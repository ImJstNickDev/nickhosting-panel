import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import {
  type ApplicationServer,
  type GatewayInventoryServer,
  PterodactylError,
} from '@nickhosting/pterodactyl-adapter';
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

async function stockInventory(management: ManagementRuntime, nodeIds: number[], uuids: string[]) {
  const [nodes, remotes, allocations] = await Promise.all([
    management.adapter.listNodes(),
    (async () => {
      // The snapshot permits 10,000 routes; the adapter accepts 1,000 distinct IDs per lookup.
      const found: ApplicationServer[] = [];
      for (let offset = 0; offset < uuids.length; offset += 1000)
        found.push(
          ...(await management.adapter.getApplicationServers(uuids.slice(offset, offset + 1000))),
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
        Array.from({ length: Math.min(4, nodeIds.length) }, async () => {
          for (;;) {
            const nodeId = nodeIds[next++];
            if (nodeId === undefined) return;
            results.push({
              nodeId,
              allocations: (await management.adapter.listAllocations(nodeId)).map(
                ({ id, ip, port, assigned }) => ({ id, ip, port, assigned }),
              ),
            });
          }
        }),
      );
      return results;
    })(),
  ]);
  return { nodes, servers: remotes, allocations };
}

/** Only capability metadata is reused. Every evidence cycle reads new provider inventory. */
export function createGatewayInventoryReader() {
  let cached: { binding: string; expiresAt: number; supported: Promise<boolean> } | undefined;
  return async (management: ManagementRuntime, nodeIds: number[], uuids: string[]) => {
    if (nodeIds.length > 256) return stockInventory(management, nodeIds, uuids);
    if (
      !cached ||
      cached.binding !== management.consoleProviderBinding ||
      cached.expiresAt <= Date.now()
    ) {
      const supported = management.adapter.supportsGatewayInventory();
      cached = {
        binding: management.consoleProviderBinding,
        expiresAt: Date.now() + 60_000,
        supported,
      };
      void supported.catch(() => {
        if (cached?.supported === supported) cached = undefined;
      });
    }
    if (await cached.supported) {
      try {
        return await management.adapter.readGatewayInventory(nodeIds, uuids);
      } catch (error) {
        // The extension explicitly declines an oversized complete result. No partial data is reused.
        if (!(error instanceof PterodactylError) || error.upstreamStatus !== 413) throw error;
      }
    }
    return stockInventory(management, nodeIds, uuids);
  };
}

/** One bounded, revision-bound read. The timestamp precedes every source read. */
export async function gatewayEvidence(
  db: ReturnType<typeof createDatabase>['db'],
  env: Readonly<Record<string, string | undefined>>,
  management: ManagementRuntime,
  projectServer: (server: GatewayInventoryServer) => unknown,
  readInventory: ReturnType<typeof createGatewayInventoryReader>,
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
  const {
    nodes,
    servers: remotes,
    allocations,
  } = await readInventory(
    management,
    policyNodes.map((node) => node.nodeId),
    [...expected],
  );
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
