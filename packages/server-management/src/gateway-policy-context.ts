import { getSettings } from '@nickhosting/database';
import type { DB, Environment } from './admission.js';

/** Per-request policy inputs shared by sleep and wake; no stale cross-request cache. */
export async function loadGatewayPolicyContext(db: DB, serverId: string, env: Environment = {}) {
  const [mapping, config] = await Promise.all([
    db
      .selectFrom('managed_servers as s')
      .innerJoin('runtime_egg_mappings as m', 'm.id', 's.mapping_id')
      .select(['m.game_id', 'm.runtime_id'])
      .where('s.id', '=', serverId)
      .executeTakeFirstOrThrow(),
    getSettings(db, env),
  ]);
  return { mapping, values: config.values };
}
export type GatewayPolicyContext = Awaited<ReturnType<typeof loadGatewayPolicyContext>>;
