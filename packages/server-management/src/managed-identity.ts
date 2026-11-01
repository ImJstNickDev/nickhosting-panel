import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { ApplicationServer } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, type Selectable, sql } from 'kysely';
import { canonicalAllocationAddress } from './allocation-pool.js';

type Server = Selectable<Database['managed_servers']>;
type ServerIdentity = Pick<
  Server,
  | 'external_id'
  | 'provider_user_id'
  | 'pterodactyl_id'
  | 'pterodactyl_uuid'
  | 'pterodactyl_identifier'
>;
export type ManagedAllocationIdentity = Pick<
  Selectable<Database['server_allocations']>,
  'pterodactyl_allocation_id' | 'is_primary' | 'address' | 'port'
>;
export type ManagedIdentitySnapshot = {
  pterodactyl_node_id: number;
  allocations: readonly ManagedAllocationIdentity[];
};

/** Keep the full ordered claim JSON so existing directory-proof fingerprints stay unchanged. */
export function managedIdentityClaims(serverId: string) {
  return sql<
    ManagedAllocationIdentity[] | null
  >`(select jsonb_agg(to_jsonb(claim) order by claim.pterodactyl_allocation_id)
    from server_allocations claim where claim.server_id = ${serverId})`;
}

/** Node and all owned allocations from one current database snapshot. */
export async function readManagedIdentity(
  db: Kysely<Database>,
  server: Pick<Server, 'id' | 'node_id'>,
): Promise<ManagedIdentitySnapshot> {
  const row = await db
    .selectFrom('managed_nodes')
    .select(['pterodactyl_node_id', managedIdentityClaims(server.id).as('claims')])
    .where('id', '=', server.node_id)
    .executeTakeFirstOrThrow();
  return { pterodactyl_node_id: row.pterodactyl_node_id, allocations: row.claims ?? [] };
}

/** Pure identity comparison shared by browsing and lifecycle effects. */
export function assertManagedIdentity(
  server: ServerIdentity,
  remote: ApplicationServer,
  snapshot: ManagedIdentitySnapshot,
  provisioning = false,
): void {
  const allocations = snapshot.allocations;
  const primary = allocations.find((allocation) => allocation.is_primary);
  const reported = remote.relationships?.allocations?.data.map((item) => item.attributes);
  if (
    !primary ||
    !reported ||
    reported.length !== allocations.length ||
    allocations.some(
      (claim) =>
        !reported.some(
          (allocation) =>
            allocation.id === claim.pterodactyl_allocation_id &&
            allocation.assigned &&
            canonicalAllocationAddress(allocation.ip) !== '' &&
            canonicalAllocationAddress(allocation.ip) === claim.address &&
            allocation.port === claim.port,
        ),
    ) ||
    remote.external_id !== server.external_id ||
    remote.node !== snapshot.pterodactyl_node_id ||
    remote.user !== server.provider_user_id ||
    remote.allocation !== primary.pterodactyl_allocation_id ||
    (!provisioning &&
      (remote.id !== server.pterodactyl_id ||
        remote.uuid !== server.pterodactyl_uuid ||
        remote.identifier !== server.pterodactyl_identifier))
  ) {
    throw new DomainError('provenance_mismatch');
  }
}
