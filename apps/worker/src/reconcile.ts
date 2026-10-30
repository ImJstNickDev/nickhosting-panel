import type { createLogger } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import { type ManagementRuntime, reconcileGatewayState } from '@nickhosting/server-management';

/** A corrupt/retired automation record must not starve unrelated lifecycle or
 * credential recovery. Each server has its own transactional state transition. */
export async function reconcileServers(
  db: ReturnType<typeof createDatabase>['db'],
  management: () => Promise<ManagementRuntime>,
  logger: ReturnType<typeof createLogger>,
  env: Readonly<Record<string, string | undefined>>,
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
  const states = await db
    .selectFrom('gateway_server_states as state')
    .innerJoin('managed_servers as server', 'server.id', 'state.server_id')
    .select('state.server_id')
    .where('server.deleted_at', 'is', null)
    .execute();
  for (const state of states) {
    try {
      await reconcileGatewayState(db, state.server_id, { env });
    } catch {
      logger.log('warn', 'gateway.reconciliation_unavailable', { serverId: state.server_id });
    }
  }
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
  const result = await (await management()).reconcile();
  if (result.external.failed)
    logger.log('warn', 'servers.external_recovery_failed', { count: result.external.failed });
  if (result.unavailable.length)
    logger.log('warn', 'servers.reconciliation_unavailable', { count: result.unavailable.length });
}
