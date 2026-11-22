import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import type { GatewayInventoryServer } from '@nickhosting/pterodactyl-adapter';
import {
  gatewayConfiguration,
  getGatewaySnapshot,
  type ManagementRuntime,
} from '@nickhosting/server-management';
import { sql } from 'kysely';
import { observationIdentityRevision } from '../../../packages/server-management/src/managed-identity-receipts.js';
import type { GatewayIdentityReceipt } from './gateway-identity-receipts.js';
import { createGatewayInventoryReader } from './gateway-inventory-reader.js';
import {
  indexGatewayRemotes,
  readGatewayClaims,
  verifyGatewayClaims,
} from './gateway-managed-inventory.js';

export { createGatewayInventoryReader };

/** One bounded, revision-bound read. The timestamp precedes every source read. */
export async function gatewayEvidence(
  db: ReturnType<typeof createDatabase>['db'],
  env: Readonly<Record<string, string | undefined>>,
  management: ManagementRuntime,
  projectServer: (server: GatewayInventoryServer) => unknown,
  readInventory: ReturnType<typeof createGatewayInventoryReader>,
  publishReceipts: (receipts: Map<string, GatewayIdentityReceipt>, fresh: boolean) => void,
) {
  const started = Date.now();
  const configuration = await gatewayConfiguration(db, env);
  // This narrow membership lookup selects only explicitly managed Gateway
  // servers. No lease or route payload is built before external inventory reads.
  const candidates = await db
    .selectFrom('gateway_routes as route')
    .innerJoin('managed_servers as server', 'server.id', 'route.server_id')
    .innerJoin('managed_nodes as node', 'node.id', 'server.node_id')
    .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
    .select([
      'route.id',
      'route.revision',
      'mapping.game_id',
      'server.id as server_id',
      'server.pterodactyl_uuid as uuid',
      observationIdentityRevision(sql.ref('server.id'), 'gateway').as('identity_revision'),
    ])
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
  // A cached provider inventory must postdate the admission it authorizes. The
  // identity generation also captures endpoint and membership edits between reads.
  const admission = createHash('sha256')
    .update(
      JSON.stringify([
        configuration.gatewayId,
        configuration.gatewayPhysicalHostId,
        configuration.gatewayNetworkPolicy,
        candidates
          .map((candidate) => [candidate.id, candidate.identity_revision])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ]),
    )
    .digest('hex');
  const policyNodes = configuration.gatewayNetworkPolicy?.nodes ?? [];
  const {
    nodes,
    servers: remotes,
    allocations,
    providerObservedAt,
    providerReadFresh,
    checkCurrent,
  } = await readInventory(
    management,
    policyNodes.map((node) => node.nodeId),
    [...expected],
    Math.min(
      candidates.some((candidate) => candidate.game_id === 'openworld') ? 4000 : 7500,
      configuration.gatewayLeaseSeconds * 500,
      Math.max(
        1,
        Math.floor((configuration.gatewayNetworkPolicy?.maximumObservationAgeMs ?? 100) * 0.85),
      ),
    ),
    admission,
  );
  const observedAt = Math.min(started, providerObservedAt);
  const byUuid = indexGatewayRemotes(remotes, expected);
  // Build authority once, after external reads. getGatewaySnapshot acquires
  // the resource lock in this same transaction; contexts/proofs/claims below
  // describe that final snapshot, not a previously issued candidate lease.
  const receipts = new Map<string, GatewayIdentityReceipt>();
  const evidence = await db.transaction().execute(async (tx) => {
    const snapshot = await getGatewaySnapshot(tx, env);
    // Renewals using a previous confirmation cannot issue a newer provider lease.
    if (snapshot.routes.length) {
      const deadline = Math.min(
        Date.parse(snapshot.expiresAt),
        providerObservedAt + configuration.gatewayLeaseSeconds * 1000,
      );
      if (deadline <= Date.now()) membershipChanged();
      snapshot.expiresAt = new Date(deadline).toISOString();
    }
    const finalConfiguration = await gatewayConfiguration(tx, env);
    if (!isDeepStrictEqual(finalConfiguration, configuration)) membershipChanged();
    if (snapshot.routes.some((route) => !selected.has(route.id))) membershipChanged();
    const ids = [...new Set(snapshot.routes.map((route) => route.serverId))];
    const [{ indexed, claimsByServer }, proofs] = await Promise.all([
      readGatewayClaims(tx, ids, true),
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
    const initialCounts = new Map<string, number>();
    for (const candidate of candidates)
      initialCounts.set(candidate.server_id, (initialCounts.get(candidate.server_id) ?? 0) + 1);
    const finalCounts = new Map<string, number>();
    const changed = new Set<string>();
    for (const route of snapshot.routes) {
      const before = selected.get(route.id);
      const row = indexed.get(`${route.serverId}:${route.allocationId}`);
      const remote = row?.pterodactyl_uuid && finalRemotes.get(row.pterodactyl_uuid);
      finalCounts.set(route.serverId, (finalCounts.get(route.serverId) ?? 0) + 1);
      if (!row?.identity_revision || row.identity_revision !== before?.identity_revision)
        membershipChanged();
      if (
        before?.game_id !== 'openworld' ||
        before.server_id !== route.serverId ||
        Number(before.revision) !== route.revision ||
        !row?.identity_revision ||
        before.identity_revision !== row.identity_revision ||
        !remote ||
        remote.nest !== row.nest_id ||
        remote.egg !== row.egg_id ||
        remote.suspended
      ) {
        changed.add(route.serverId);
        continue;
      }
      receipts.set(route.serverId, {
        revision: row.identity_revision,
        providerUuid: remote.uuid,
        gatewayId: snapshot.gatewayId,
        snapshotRevision: snapshot.revision,
        observedAt: providerObservedAt,
        expiresAt: Math.min(
          observedAt + 5000,
          observedAt + (configuration.gatewayNetworkPolicy?.maximumObservationAgeMs ?? 5000),
          Date.parse(snapshot.expiresAt),
        ),
      });
    }
    for (const id of receipts.keys())
      if (changed.has(id) || finalCounts.get(id) !== initialCounts.get(id)) receipts.delete(id);
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
  checkCurrent();
  publishReceipts(receipts, providerReadFresh);
  return evidence;
}
