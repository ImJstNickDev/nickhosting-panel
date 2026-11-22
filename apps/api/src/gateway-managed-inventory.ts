import { DomainError } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import type { GatewayInventoryServer } from '@nickhosting/pterodactyl-adapter';
import { assertManagedIdentity } from '../../../packages/server-management/src/managed-identity.js';

type DB = ReturnType<typeof createDatabase>['db'];

/** All owned allocations, including those without a published Gateway route. */
export async function readGatewayClaims(db: DB, ids: string[]) {
  const rows = ids.length
    ? await db
        .selectFrom('managed_servers as s')
        .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
        .innerJoin('runtime_egg_mappings as m', 'm.id', 's.mapping_id')
        .innerJoin('server_allocations as a', 'a.server_id', 's.id')
        .select([
          's.id as serverId',
          'a.id as allocationId',
          's.pterodactyl_id',
          's.pterodactyl_uuid',
          's.pterodactyl_identifier',
          's.external_id',
          's.provider_user_id',
          'n.pterodactyl_node_id',
          'a.pterodactyl_allocation_id',
          'a.is_primary',
          'a.address',
          'a.port',
          'm.nest_id',
          'm.egg_id',
        ])
        .where('s.id', 'in', ids)
        .where('s.deleted_at', 'is', null)
        .where('s.connection_mode', '=', 'gateway')
        .execute()
    : [];
  const indexed = new Map(rows.map((row) => [`${row.serverId}:${row.allocationId}`, row]));
  const claimsByServer = new Map<string, typeof rows>();
  for (const row of rows) {
    const claims = claimsByServer.get(row.serverId) ?? [];
    claims.push(row);
    claimsByServer.set(row.serverId, claims);
  }
  if (indexed.size !== rows.length) throw new DomainError('provenance_mismatch');
  return { indexed, claimsByServer };
}

export function indexGatewayRemotes(
  remotes: GatewayInventoryServer[],
  expected: ReadonlySet<string>,
) {
  const byUuid = new Map(remotes.map((remote) => [remote.uuid, remote]));
  if (
    byUuid.size !== expected.size ||
    byUuid.size !== remotes.length ||
    new Set(remotes.map((remote) => remote.id)).size !== remotes.length ||
    remotes.some((remote) => !expected.has(remote.uuid))
  )
    throw new DomainError('provenance_mismatch');
  return byUuid;
}

export function verifyGatewayClaims(
  claimsByServer: Awaited<ReturnType<typeof readGatewayClaims>>['claimsByServer'],
  byUuid: ReadonlyMap<string, GatewayInventoryServer>,
) {
  if (claimsByServer.size !== byUuid.size) throw new DomainError('provenance_mismatch');
  for (const claims of claimsByServer.values()) {
    const server = claims[0];
    const remote = server?.pterodactyl_uuid && byUuid.get(server.pterodactyl_uuid);
    if (!server || !remote) throw new DomainError('provenance_mismatch');
    // All claims join the same managed server and node in this statement.
    assertManagedIdentity(server, remote, {
      pterodactyl_node_id: server.pterodactyl_node_id,
      allocations: claims,
    });
  }
}
