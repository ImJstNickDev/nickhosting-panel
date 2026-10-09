import { createHash, randomUUID } from 'node:crypto';
import { type AuthContext, assertPermission, DomainError } from '@nickhosting/core';
import { type Database, getSettings, recordAudit } from '@nickhosting/database';
import { type GatewayRoute, gatewaySnapshotSchema } from '@nickhosting/game-sdk';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { type DB, type Environment, lockResources } from './admission.js';
import {
  allocationAddressesOverlap,
  canonicalAllocationAddress,
  effectiveBackendAllocationPool,
} from './allocation-pool.js';
import { getGatewayState } from './gateway-orchestration.js';
import { currentInteractiveContext } from './interactive-context.js';
import { authorizeServer, parse } from './registry.js';

const routeInput = z
  .object({
    id: z.uuid().optional(),
    serverId: z.uuid(),
    allocationId: z.uuid(),
    publicAddress: z.string().max(45),
    publicPort: z.number().int().min(1).max(65535),
    transport: z.enum(['tcp', 'udp']),
    enabled: z.boolean().default(true),
  })
  .strict();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function gatewayConfiguration(db: DB, env: Environment = {}) {
  const { values } = await getSettings(db, env);
  if (!values.gatewayEnabled || !values.gatewayId || !values.gatewayPhysicalHostId)
    throw new DomainError('integration_unavailable');
  return {
    ...values,
    gatewayId: values.gatewayId,
    gatewayPhysicalHostId: values.gatewayPhysicalHostId,
  };
}
export async function setGatewayRoute(
  db: Kysely<Database>,
  context: AuthContext,
  input: unknown,
  env: Environment = {},
) {
  assertPermission(context, 'settings:write');
  if (context.sessionType !== 'regular') throw new DomainError('forbidden');
  const value = parse(routeInput, input),
    address = canonicalAllocationAddress(value.publicAddress);
  if (
    !address ||
    address !== value.publicAddress ||
    ['0.0.0.0', '::'].includes(address) ||
    address.startsWith('::ffff:')
  )
    throw new DomainError('validation_failed');
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const current = await currentInteractiveContext(tx, context, env);
    assertPermission(current, 'settings:write');
    if (current.sessionType !== 'regular') throw new DomainError('forbidden');
    const config = await gatewayConfiguration(tx, env);
    const server = await authorizeServer(tx, current, value.serverId, 'server:manage');
    if (
      !server.pterodactyl_uuid ||
      !server.pterodactyl_id ||
      server.installation_state !== 'installed' ||
      server.active_operation_id
    )
      throw new DomainError('conflict');
    await getGatewayState(tx, server.id);
    const node = await tx
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', server.node_id)
      .executeTakeFirstOrThrow();
    const claim = await tx
      .selectFrom('server_allocations')
      .selectAll()
      .where('id', '=', value.allocationId)
      .where('server_id', '=', server.id)
      .where('node_id', '=', node.id)
      .executeTakeFirst();
    const pool = effectiveBackendAllocationPool(node, env);
    if (
      !node.enabled ||
      node.physical_host_id !== config.gatewayPhysicalHostId ||
      !claim ||
      !claim.protocols.includes(value.transport) ||
      !pool?.gatewayBindAddresses.includes(address) ||
      allocationAddressesOverlap(address, claim.backend_address)
    )
      throw new DomainError('allocation_unavailable');
    const existing = await tx
      .selectFrom('gateway_routes')
      .selectAll()
      .where('gateway_id', '=', config.gatewayId)
      .execute();
    const id = value.id ?? randomUUID();
    const old = existing.find((row) => row.id === id);
    if (value.id && !old) throw new DomainError('not_found');
    if (
      old &&
      (old.server_id !== server.id ||
        old.allocation_id !== claim.id ||
        old.public_address !== address ||
        old.public_port !== value.publicPort ||
        old.transport !== value.transport)
    )
      throw new DomainError('conflict');
    if (
      existing.some(
        (row) =>
          row.id !== id &&
          row.public_port === value.publicPort &&
          row.transport === value.transport &&
          allocationAddressesOverlap(address, row.public_address),
      )
    )
      throw new DomainError('allocation_unavailable');
    await tx
      .insertInto('gateway_routes')
      .values({
        id,
        gateway_id: config.gatewayId,
        server_id: server.id,
        allocation_id: claim.id,
        public_address: address,
        public_port: value.publicPort,
        transport: value.transport,
        enabled: value.enabled,
        payload_hash: null,
      })
      .onConflict((c) =>
        c.column('id').doUpdateSet({ enabled: value.enabled, updated_at: new Date() }),
      )
      .execute();
    await recordAudit(tx, current, 'gateway.route.configured', {
      routeId: id,
      serverId: server.id,
      enabled: value.enabled,
    });
    return { id };
  });
}
export async function listGatewayRoutes(db: DB, context: AuthContext) {
  assertPermission(context, 'settings:write');
  if (context.sessionType !== 'regular') throw new DomainError('forbidden');
  return db
    .selectFrom('gateway_routes')
    .select([
      'id',
      'server_id',
      'allocation_id',
      'public_address',
      'public_port',
      'transport',
      'enabled',
      'revision',
      'updated_at',
    ])
    .orderBy('created_at')
    .limit(10000)
    .execute();
}
/** One serialized full snapshot, with persisted monotonic content revisions. */
export async function getGatewaySnapshot(db: Kysely<Database>, env: Environment = {}) {
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const config = await gatewayConfiguration(tx, env),
      gatewayId = config.gatewayId;
    const now = Date.now();
    const rows = await tx
      .selectFrom('gateway_routes as route')
      .innerJoin('managed_servers as server', 'server.id', 'route.server_id')
      .innerJoin('managed_nodes as node', 'node.id', 'server.node_id')
      .innerJoin('server_allocations as allocation', 'allocation.id', 'route.allocation_id')
      .innerJoin('user', 'user.id', 'server.owner_id')
      .selectAll('route')
      .select([
        'server.node_id',
        'allocation.address',
        'allocation.backend_address',
        'allocation.port',
        'allocation.role',
        'user.locale',
      ])
      .where('route.gateway_id', '=', gatewayId)
      .where('route.enabled', '=', true)
      .where('server.deleted_at', 'is', null)
      .where('server.pterodactyl_uuid', 'is not', null)
      .where('node.enabled', '=', true)
      .where('node.physical_host_id', '=', config.gatewayPhysicalHostId)
      .orderBy('route.id')
      .limit(10001)
      .execute();
    if (rows.length > 10000) throw new DomainError('configuration_invalid');
    const routes: GatewayRoute[] = [];
    for (const row of rows) {
      const state = await getGatewayState(tx, row.server_id);
      const payload = {
        id: row.id,
        serverId: row.server_id,
        nodeId: row.node_id,
        allocationId: row.allocation_id,
        generation: state.generation,
        ...(state.sleepEligibleAt ? { sleepEligibleAt: state.sleepEligibleAt } : {}),
        ...(state.wakeJobId ? { wakeJobId: state.wakeJobId } : {}),
        public: { address: row.public_address, port: row.public_port, transport: row.transport },
        backend: { allocationAddress: row.address, address: row.backend_address, port: row.port },
        protocol: { handlerId: state.protocolId, gameVersion: state.gameVersion, role: row.role },
        mode: state.state,
        locale: row.locale === 'it' ? ('it' as const) : ('en' as const),
      };
      const hash = digest(payload),
        revision = Number(row.revision) + (row.payload_hash && row.payload_hash !== hash ? 1 : 0);
      if (!Number.isSafeInteger(revision)) throw new DomainError('configuration_invalid');
      await tx
        .updateTable('gateway_routes')
        .set({
          payload_hash: hash,
          revision: String(revision),
          updated_at: new Date(),
          lease_expires_at: sql<Date>`greatest(lease_expires_at, ${new Date(now + config.gatewayLeaseSeconds * 1000 + 1000)})`,
        })
        .where('id', '=', row.id)
        .execute();
      routes.push({ ...payload, revision });
    }
    const previous = await tx
      .selectFrom('gateway_control_state')
      .selectAll()
      .where('gateway_id', '=', gatewayId)
      .executeTakeFirst();
    const hash = digest(routes),
      revision = previous
        ? Number(previous.revision) + (previous.snapshot_hash === hash ? 0 : 1)
        : 1;
    if (!Number.isSafeInteger(revision)) throw new DomainError('configuration_invalid');
    await tx
      .insertInto('gateway_control_state')
      .values({ gateway_id: gatewayId, revision: String(revision), snapshot_hash: hash })
      .onConflict((c) =>
        c
          .column('gateway_id')
          .doUpdateSet({ revision: String(revision), snapshot_hash: hash, updated_at: new Date() }),
      )
      .execute();
    return gatewaySnapshotSchema.parse({
      gatewayId,
      revision,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + config.gatewayLeaseSeconds * 1000).toISOString(),
      routes,
    });
  });
}
export async function requireGatewayRoute(
  db: Kysely<Database>,
  routeId: string,
  revision: number | undefined,
  env: Environment = {},
) {
  const snapshot = await getGatewaySnapshot(db, env),
    route = snapshot.routes.find((row) => row.id === routeId);
  if (!route) throw new DomainError('not_found');
  if (revision !== undefined && route.revision !== revision) throw new DomainError('conflict');
  return route;
}
export async function gatewaySafetyContext(db: DB, route: GatewayRoute) {
  const row = await db
    .selectFrom('managed_servers as s')
    .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
    .innerJoin('runtime_egg_mappings as m', 'm.id', 's.mapping_id')
    .innerJoin('server_allocations as a', 'a.server_id', 's.id')
    .select([
      's.pterodactyl_id',
      's.pterodactyl_uuid',
      's.external_id',
      'n.provision_user_id',
      'n.pterodactyl_node_id',
      'a.pterodactyl_allocation_id',
      'm.nest_id',
      'm.egg_id',
    ])
    .where('s.id', '=', route.serverId)
    .where('s.deleted_at', 'is', null)
    .where('a.id', '=', route.allocationId)
    .executeTakeFirst();
  if (!row?.pterodactyl_id || !row.pterodactyl_uuid) throw new DomainError('not_found');
  return {
    providerServerId: row.pterodactyl_id,
    providerServerUuid: row.pterodactyl_uuid,
    externalId: row.external_id,
    providerUserId: row.provision_user_id,
    providerNodeId: row.pterodactyl_node_id,
    providerAllocationId: row.pterodactyl_allocation_id,
    nestId: row.nest_id,
    eggId: row.egg_id,
  };
}
