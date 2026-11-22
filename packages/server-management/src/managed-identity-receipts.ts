import type { Database } from '@nickhosting/database';
import { type Kysely, type RawBuilder, sql } from 'kysely';

/** Only identity metadata crosses from an inventory read to a read-only consumer.
 * Include row versions for credential rotation and allocation/mapping replacement.
 * Fleet reconciliation updates server telemetry itself; the world index's
 * generation and operation counters fence lifecycle changes independently. */
export function observationIdentityRevision(
  serverId: RawBuilder<unknown> | string,
  purpose: 'gateway' | 'openworld' | 'minecraft',
) {
  const revision =
    purpose === 'minecraft'
      ? sql`(select jsonb_build_array(i.generation, i.operation_generation, minecraft_world_local_binding(subject.id))
            from minecraft_world_indexes i where i.server_id=subject.id)`
      : sql`null::text`;
  return sql<string | null>`(select encode(sha256(convert_to(jsonb_build_array(
    subject.id, subject.provider_identity_revision, subject.owner_id, subject.external_id, subject.pterodactyl_id, subject.pterodactyl_uuid, subject.pterodactyl_identifier,
    subject.provider_user_id, subject.mapping_id, m.xmin::text, subject.node_id, n.xmin::text, h.xmin::text, ${revision},
    (select jsonb_agg(jsonb_build_array(a.id,a.xmin::text) order by a.id) from server_allocations a where a.server_id=subject.id),
    (select p.xmin::text from platform_settings p where p.key='platform'),
    (select k.xmin::text from encrypted_secrets k where k.name='pterodactylApplicationKey'),
    (select account.xmin::text from provider_accounts account where account.user_id=subject.owner_id),
    ${purpose !== 'minecraft' ? sql`(select token.xmin::text from encrypted_secrets token where token.name='gatewayControlToken')` : sql`null::text`}
    )::text,'UTF8')),'hex')
    from managed_servers subject join runtime_egg_mappings m on m.id=subject.mapping_id
    join managed_nodes n on n.id=subject.node_id join physical_hosts h on h.id=n.physical_host_id
    where subject.id=${serverId} and subject.deleted_at is null ${purpose === 'gateway' ? sql`` : sql`and m.game_id=${purpose}`}
    ${purpose !== 'minecraft' ? sql`and subject.connection_mode='gateway'` : sql`and subject.active_operation_id is null and subject.installation_state='installed'`})`;
}

export type WorldIdentityReceipt = {
  provider: string;
  revision: string;
  expiresAt: number;
};
type DB = Kysely<Database>;
const worldReceipts = new WeakMap<DB, Map<string, WorldIdentityReceipt>>();

export function beginFleetIdentityReceipts(db: DB) {
  const entries = new Map<string, WorldIdentityReceipt>();
  worldReceipts.set(db, entries);
  return entries;
}

export function freshWorldIdentity(db: DB, id: string, provider: string) {
  const entries = worldReceipts.get(db);
  const entry = entries?.get(id);
  if (entry?.provider === provider && entry.expiresAt > performance.now()) return entry;
  entries?.delete(id);
  return undefined;
}
