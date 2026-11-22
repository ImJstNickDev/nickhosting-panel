import type { createLogger } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import {
  type ManagementRuntime,
  reconcileDueGatewayStates,
  withProviderReadCaller,
} from '@nickhosting/server-management';

/** A session-scoped lock fences the whole sweep. Its completion time also fences
 * staggered replicas. Gateway wake jobs and their due-state queue run independently. */
export async function pollFleet(
  pool: ReturnType<typeof createDatabase>['pool'],
  sweep: (leadership: AbortSignal) => Promise<void>,
) {
  const connection = await pool.connect();
  const leadership = new AbortController();
  const lost = () => leadership.abort(new Error('Fleet reconciliation connection lost'));
  connection.on('error', lost);
  connection.on('end', lost);
  let destroy = false;
  const lock = "hashtextextended(current_schema() || ':fleet-reconciliation', 0)";
  try {
    const { rows } = await connection.query<{ locked: boolean }>(
      `select pg_try_advisory_lock(${lock}) as locked from fleet_reconciliation_clock
       where singleton and next_poll_at <= clock_timestamp()`,
    );
    if (!rows[0]?.locked) return;
    try {
      // A concurrent leader may have completed between the first statement snapshot and lock acquisition.
      const due = await connection.query(
        'select 1 from fleet_reconciliation_clock where singleton and next_poll_at <= clock_timestamp()',
      );
      if (!due.rowCount) return;
      const { signal } = leadership;
      signal.throwIfAborted();
      await withProviderReadCaller('worker-reconcile', () => sweep(signal), signal);
      signal.throwIfAborted();
      await connection.query(
        "update fleet_reconciliation_clock set next_poll_at = clock_timestamp() + interval '5 seconds' where singleton",
      );
    } finally {
      if (!leadership.signal.aborted) {
        const released = await connection.query<{ released: boolean }>(
          `select pg_advisory_unlock(${lock}) as released`,
        );
        if (!released.rows[0]?.released) destroy = true;
      }
    }
  } catch (error) {
    destroy = true;
    throw error;
  } finally {
    connection.removeListener('error', lost);
    connection.removeListener('end', lost);
    connection.release(destroy || leadership.signal.aborted);
  }
}

/** A corrupt/retired automation record must not starve unrelated lifecycle or
 * credential recovery. Each server has its own transactional state transition. */
export async function reconcileServers(
  db: ReturnType<typeof createDatabase>['db'],
  management: () => Promise<ManagementRuntime>,
  logger: ReturnType<typeof createLogger>,
  env: Readonly<Record<string, string | undefined>>,
  pool?: ReturnType<typeof createDatabase>['pool'],
) {
  const transition = await db
    .selectFrom('storage_policy_transitions')
    .select('id')
    .where('status', '=', 'applying')
    .limit(1)
    .executeTakeFirst();
  if (transition) {
    try {
      await (await management()).storagePolicy.processPending();
    } catch {
      logger.log('warn', 'storage.policy_reconciliation_unavailable', {});
    }
  }
  await reconcileDueGatewayStates(db, { env }, (serverId) =>
    logger.log('warn', 'gateway.reconciliation_unavailable', { serverId }),
  );
  const server = await db
    .selectFrom('managed_servers')
    .select('id')
    .where('deleted_at', 'is', null)
    .limit(1)
    .executeTakeFirst();
  if (!server) {
    // Deleting the last server must not strand an interrupted credential
    // revocation. Keep the unconfigured, empty installation cheap to reconcile.
    const credential = await db
      .selectFrom('external_sftp_credentials')
      .select('id')
      .where('state', '!=', 'revoked')
      .limit(1)
      .executeTakeFirst();
    const dns = credential
      ? undefined
      : await db
          .selectFrom('dns_assignments')
          .select('id')
          .where('state', 'not in', ['active', 'deleted'])
          .limit(1)
          .executeTakeFirst();
    const abandonedClaim =
      credential || dns
        ? undefined
        : await db
            .selectFrom('dns_hostname_reservations as r')
            .innerJoin('managed_servers as s', 's.id', 'r.owner_id')
            .select('r.hostname')
            .where('s.deleted_at', 'is not', null)
            .where('r.release_after', 'is', null)
            .limit(1)
            .executeTakeFirst();
    const shared =
      credential || dns || abandonedClaim
        ? []
        : await db.selectFrom('game_integrations').select('manifest').execute();
    if (
      !credential &&
      !dns &&
      !abandonedClaim &&
      !shared.some(
        (game) =>
          (game.manifest as { connection?: { mode?: string } }).connection?.mode === 'shared-host',
      )
    )
      return;
  }
  async function sweep() {
    const result = await (await management()).reconcile();
    if (result.external.failed)
      logger.log('warn', 'servers.external_recovery_failed', { count: result.external.failed });
    if (result.unavailable.length)
      logger.log('warn', 'servers.reconciliation_unavailable', {
        count: result.unavailable.length,
      });
  }
  if (pool) await pollFleet(pool, sweep);
  else await sweep();
}
