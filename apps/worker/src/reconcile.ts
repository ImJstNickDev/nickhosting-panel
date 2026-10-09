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
  if (!server) return;
  const result = await (await management()).reconcile();
  if (result.external.failed)
    logger.log('warn', 'servers.external_recovery_failed', { count: result.external.failed });
  if (result.unavailable.length)
    logger.log('warn', 'servers.reconciliation_unavailable', { count: result.unavailable.length });
}
