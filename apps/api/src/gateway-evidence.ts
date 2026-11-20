import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import type { ApplicationServer } from '@nickhosting/pterodactyl-adapter';
import {
  gatewayConfiguration,
  getGatewaySnapshot,
  type ManagementRuntime,
} from '@nickhosting/server-management';
import {
  indexGatewayRemotes,
  readGatewayClaims,
  verifyGatewayClaims,
} from './gateway-managed-inventory.js';

/** One bounded, revision-bound read. The timestamp precedes every source read. */
export async function gatewayEvidence(
  db: ReturnType<typeof createDatabase>['db'],
  env: Readonly<Record<string, string | undefined>>,
  management: ManagementRuntime,
  projectServer: (server: ApplicationServer) => unknown,
) {
  const observedAt = Date.now();
  const configuration = await gatewayConfiguration(db, env);
  // This narrow membership lookup selects only explicitly managed Gateway
  // servers. No lease or route payload is built before external inventory reads.
  const candidates = await db
    .selectFrom('gateway_routes as route')
    .innerJoin('managed_servers as server', 'server.id', 'route.server_id')
    .innerJoin('managed_nodes as node', 'node.id', 'server.node_id')
    .select(['route.id', 'server.pterodactyl_uuid as uuid'])
    .where('route.gateway_id', '=', configuration.gatewayId)
    .where('route.enabled', '=', true)
    .where('server.deleted_at', 'is', null)
    .where('server.connection_mode', '=', 'gateway')
    .where('server.pterodactyl_uuid', 'is not', null)
    .where('node.enabled', '=', true)
    .where('node.physical_host_id', '=', configuration.gatewayPhysicalHostId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('server_operations as installing')
            .select('installing.job_id')
            .whereRef('installing.job_id', '=', 'server.active_operation_id')
            .whereRef('installing.server_id', '=', 'server.id')
            .where('installing.action', '=', 'reinstall'),
        ),
      ),
    )
    .limit(10001)
    .execute();
  if (candidates.length > 10000) throw new DomainError('configuration_invalid');
  const selected = new Map(candidates.map((entry) => [entry.id, entry]));
  const expected = new Set(
    candidates.map((entry) => entry.uuid).filter((uuid): uuid is string => uuid !== null),
  );
  const membershipChanged = (): never => {
    throw new DomainError('conflict', 412, { gatewayControlReason: 'snapshot_membership_changed' });
  };
  const policyNodes = configuration.gatewayNetworkPolicy?.nodes ?? [];
  const [nodes, remotes, allocations] = await Promise.all([
    management.adapter.listNodes(),
    (async () => {
      // The snapshot permits 10,000 routes; the adapter accepts 1,000 distinct IDs per lookup.
      const ids = [...expected];
      const found: ApplicationServer[] = [];
      for (let offset = 0; offset < ids.length; offset += 1000)
        found.push(
          ...(await management.adapter.getApplicationServers(ids.slice(offset, offset + 1000))),
        );
      return found;
    })(),
    (async () => {
      let next = 0;
      const results: {
        nodeId: number;
        allocations: { id: number; ip: string; port: number; assigned: boolean }[];
      }[] = [];
      await Promise.all(
        Array.from({ length: Math.min(4, policyNodes.length) }, async () => {
          for (;;) {
            const node = policyNodes[next++];
            if (!node) return;
            results.push({
              nodeId: node.nodeId,
              allocations: (await management.adapter.listAllocations(node.nodeId)).map(
                ({ id, ip, port, assigned }) => ({ id, ip, port, assigned }),
              ),
            });
          }
        }),
      );
      return results;
    })(),
  ]);
  const byUuid = indexGatewayRemotes(remotes, expected);
  // Build authority once, after external reads. getGatewaySnapshot acquires
  // the resource lock in this same transaction; contexts/proofs/claims below
  // describe that final snapshot, not a previously issued candidate lease.
  return db.transaction().execute(async (tx) => {
    const snapshot = await getGatewaySnapshot(tx, env);
    const finalConfiguration = await gatewayConfiguration(tx, env);
    if (!isDeepStrictEqual(finalConfiguration, configuration)) membershipChanged();
    if (snapshot.routes.some((route) => !selected.has(route.id))) membershipChanged();
    const ids = [...new Set(snapshot.routes.map((route) => route.serverId))];
    const [{ indexed, claimsByServer }, proofs] = await Promise.all([
      readGatewayClaims(tx, ids),
      ids.length
        ? tx
            .selectFrom('gateway_reachability_proofs')
            .select(['route_id', 'proof'])
            .where(
              'route_id',
              'in',
              snapshot.routes.map((route) => route.id),
            )
            .execute()
        : [],
    ]);
    if (claimsByServer.size !== ids.length) throw new DomainError('provenance_mismatch');
    const proofIndex = new Map(proofs.map((row) => [row.route_id, row.proof]));
    const contexts = snapshot.routes.map((route) => {
      const row = indexed.get(`${route.serverId}:${route.allocationId}`);
      if (!row?.pterodactyl_id || !row.pterodactyl_uuid || !row.provider_user_id)
        throw new DomainError('provenance_mismatch');
      return {
        routeId: route.id,
        routeRevision: route.revision,
        context: {
          providerServerId: row.pterodactyl_id,
          providerServerUuid: row.pterodactyl_uuid,
          externalId: row.external_id,
          providerUserId: row.provider_user_id,
          providerNodeId: row.pterodactyl_node_id,
          providerAllocationId: row.pterodactyl_allocation_id,
          nestId: row.nest_id,
          eggId: row.egg_id,
        },
        proof: proofIndex.get(route.id) ?? null,
      };
    });
    if (
      contexts.some(
        (entry) => selected.get(entry.routeId)?.uuid !== entry.context.providerServerUuid,
      )
    )
      membershipChanged();
    // The final snapshot may have withdrawn candidates while the provider was being read.
    const finalRemotes = new Map(
      contexts.map(({ context }) => {
        const uuid = context.providerServerUuid;
        const remote = byUuid.get(uuid);
        if (!remote) throw new DomainError('provenance_mismatch');
        return [uuid, remote] as const;
      }),
    );
    verifyGatewayClaims(claimsByServer, finalRemotes);
    return {
      observedAt,
      configuration: Object.fromEntries(
        Object.entries(configuration).filter(([key]) => key.startsWith('gateway')),
      ),
      snapshot,
      contexts,
      nodes: nodes.map(({ id, uuid }) => ({ id, uuid })),
      allocations,
      servers: [...finalRemotes.values()].map(projectServer),
    };
  });
}
