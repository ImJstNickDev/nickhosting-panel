import { createHash, randomUUID } from 'node:crypto';
import { type AuthContext, assertPermission, DomainError } from '@nickhosting/core';
import { type Database, getSettings, recordAudit } from '@nickhosting/database';
import {
  type GatewayMinecraftProtocol,
  type GatewayRoute,
  gatewayMinecraftProtocolSchema,
  gatewaySnapshotSchema,
} from '@nickhosting/game-sdk';
import { minecraftCapabilityDeclaration } from '@nickhosting/minecraft';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { type DB, type Environment, lockResources } from './admission.js';
import {
  allocationAddressesOverlap,
  backendAllocationAddress,
  canonicalAllocationAddress,
  effectiveBackendAllocationPool,
} from './allocation-pool.js';
import { getGatewayState } from './gateway-orchestration.js';
import { currentInteractiveContext } from './interactive-context.js';
import { inspectMinecraftCombination } from './minecraft-registry.js';
import { authorizeServer, parse } from './registry.js';

/** Existing managed servers retain declared routing when creation availability is disabled.
 * Compiled support declarations are independent of local diagnostic test reports. */
export async function requireMinecraftGatewayProtocol(
  db: DB,
  serverId: string,
  registration: { handlerId: string; gameVersion: string },
  env: Environment = {},
  _now = new Date(),
): Promise<GatewayMinecraftProtocol | undefined> {
  const server = await db
    .selectFrom('managed_servers as server')
    .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
    .selectAll('server')
    .select(['mapping.game_id', 'mapping.runtime_id'])
    .where('server.id', '=', serverId)
    .where('server.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!server) throw new DomainError('not_found');
  if (server.connection_mode === 'direct') throw new DomainError('integration_unavailable');
  if (server.game_id !== 'minecraft-java') {
    if (registration.handlerId === 'minecraft-java') throw new DomainError('configuration_invalid');
    return undefined;
  }
  const unavailable = () =>
    new DomainError('integration_unavailable', 503, { reason: 'minecraft_gateway_unsupported' });
  const profile = await db
    .selectFrom('minecraft_server_profiles')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (!profile?.installed || !server.pterodactyl_uuid || server.installation_state !== 'installed')
    throw unavailable();
  const choice = await inspectMinecraftCombination(db, profile.combination_id, env);
  if (
    choice.row.mapping_id !== server.mapping_id ||
    choice.row.mapping_digest !== choice.mappingDigest ||
    choice.mapping.game_id !== server.game_id ||
    choice.mapping.runtime_id !== server.runtime_id ||
    choice.combination.profile !== server.runtime_id ||
    registration.handlerId !== 'minecraft-java' ||
    registration.gameVersion !== choice.combination.release ||
    choice.combination.family !== 'netty' ||
    choice.combination.protocolId === null
  )
    throw unavailable();
  if (!choice.capabilities.gateway) throw unavailable();
  return gatewayMinecraftProtocolSchema.parse({
    release: choice.combination.release,
    protocolId: choice.combination.protocolId,
    family: 'netty',
    transfer: 'transfer' in choice.combination && choice.combination.transfer === true,
    acceptsTransfers: false,
    choiceId: choice.row.id,
    choiceDigest: choice.row.identity_digest,
    supportSource: 'integration',
    declarationId: minecraftCapabilityDeclaration.id,
    declarationVersion: minecraftCapabilityDeclaration.version,
  });
}

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
    if (server.connection_mode === 'direct') throw new DomainError('integration_unavailable');
    if (
      !server.pterodactyl_uuid ||
      !server.pterodactyl_id ||
      server.installation_state !== 'installed' ||
      server.active_operation_id
    )
      throw new DomainError('conflict');
    if (value.enabled) {
      const state = await getGatewayState(tx, server.id, { env });
      await requireMinecraftGatewayProtocol(
        tx,
        server.id,
        { handlerId: state.protocolId, gameVersion: state.gameVersion },
        env,
      );
    }
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
        old.allocation_id !== value.allocationId ||
        old.public_address !== address ||
        old.public_port !== value.publicPort ||
        old.transport !== value.transport)
    )
      throw new DomainError('conflict');
    const claim = await validateGatewayRouteEndpoint(
      tx,
      server.node_id,
      { ...value, id },
      config,
      env,
      !old,
    );
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
/** Shared namespace validation. Caller holds the global resource lock. No auth
 * bypass: interactive authorization and trusted durable provision ownership are
 * checked independently by their entry points. */
export async function validateGatewayRouteEndpoint(
  tx: DB,
  serverNodeId: string,
  value: z.infer<typeof routeInput> & { id: string },
  config: { gatewayId: string; gatewayPhysicalHostId: string },
  env: Environment = {},
  checkDisabled = true,
) {
  const address = canonicalAllocationAddress(value.publicAddress);
  if (
    !address ||
    address !== value.publicAddress ||
    ['0.0.0.0', '::'].includes(address) ||
    address.startsWith('::ffff:')
  )
    throw new DomainError('validation_failed');
  const node = await tx
    .selectFrom('managed_nodes')
    .selectAll()
    .where('id', '=', serverNodeId)
    .executeTakeFirstOrThrow();
  const claim = await tx
    .selectFrom('server_allocations')
    .selectAll()
    .where('id', '=', value.allocationId)
    .where('server_id', '=', value.serverId)
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
  if (
    existing.some(
      (row) =>
        row.id !== value.id &&
        row.public_port === value.publicPort &&
        row.transport === value.transport &&
        allocationAddressesOverlap(address, row.public_address),
    )
  )
    throw new DomainError('allocation_unavailable');
  if (value.enabled || checkDisabled) {
    // Direct allocations can share the Gateway's IP, but never its listener port.
    // Include disabled pools and retained claims: removing an editable pin does
    // not release the corresponding provider binding. Wings publishes both
    // transports, independently of the game's declared transport roles.
    const hostNodes = await tx
      .selectFrom('managed_nodes')
      .selectAll()
      .where('physical_host_id', '=', node.physical_host_id)
      .execute();
    for (const hostNode of hostNodes) {
      const hostPool = effectiveBackendAllocationPool(hostNode, env);
      if (
        hostPool?.allocations.some(
          (pin) =>
            pin.port === value.publicPort &&
            allocationAddressesOverlap(address, backendAllocationAddress(pin)),
        )
      )
        throw new DomainError('allocation_unavailable');
    }
    const hostClaims = await tx
      .selectFrom('server_allocations as allocation')
      .innerJoin('managed_nodes as ownerNode', 'ownerNode.id', 'allocation.node_id')
      .select('allocation.backend_address')
      .where('ownerNode.physical_host_id', '=', node.physical_host_id)
      .where('allocation.port', '=', value.publicPort)
      .execute();
    if (hostClaims.some((entry) => allocationAddressesOverlap(address, entry.backend_address)))
      throw new DomainError('allocation_unavailable');
    const hostRoutes = await tx
      .selectFrom('gateway_routes as route')
      .innerJoin('server_allocations as allocation', 'allocation.id', 'route.allocation_id')
      .innerJoin('managed_nodes as ownerNode', 'ownerNode.id', 'allocation.node_id')
      .select(['route.id', 'route.public_address'])
      .where('ownerNode.physical_host_id', '=', node.physical_host_id)
      .where('route.public_port', '=', value.publicPort)
      .where('route.transport', '=', value.transport)
      .execute();
    if (
      hostRoutes.some(
        (entry) =>
          entry.id !== value.id && allocationAddressesOverlap(address, entry.public_address),
      )
    )
      throw new DomainError('allocation_unavailable');
  }
  return claim;
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
      .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
      .leftJoin('gateway_server_states as policy', 'policy.server_id', 'server.id')
      .innerJoin('managed_nodes as node', 'node.id', 'server.node_id')
      .innerJoin('server_allocations as allocation', 'allocation.id', 'route.allocation_id')
      .innerJoin('user', 'user.id', 'server.owner_id')
      .selectAll('route')
      .select([
        'server.node_id',
        'mapping.game_id',
        'policy.protocol_id as stored_handler_id',
        'allocation.address',
        'allocation.backend_address',
        'allocation.port',
        'allocation.role',
        'user.locale',
      ])
      .where('route.gateway_id', '=', gatewayId)
      .where('route.enabled', '=', true)
      .where('server.deleted_at', 'is', null)
      .where('server.connection_mode', '=', 'gateway')
      .where('server.pterodactyl_uuid', 'is not', null)
      .where('node.enabled', '=', true)
      .where('node.physical_host_id', '=', config.gatewayPhysicalHostId)
      .orderBy('route.id')
      .limit(10001)
      .execute();
    if (rows.length > 10000) throw new DomainError('configuration_invalid');
    const routes: GatewayRoute[] = [];
    for (const row of rows) {
      let state: Awaited<ReturnType<typeof getGatewayState>>;
      let minecraft: GatewayMinecraftProtocol | undefined;
      try {
        state = await getGatewayState(tx, row.server_id, { env });
        if (row.game_id === 'minecraft-java') {
          minecraft = await requireMinecraftGatewayProtocol(
            tx,
            row.server_id,
            { handlerId: state.protocolId, gameVersion: state.gameVersion },
            env,
            new Date(now),
          );
          if (row.transport !== 'tcp' || row.role !== 'game') continue;
        }
      } catch (error) {
        if (
          (row.game_id === 'minecraft-java' || row.stored_handler_id === 'minecraft-java') &&
          (error instanceof DomainError || error instanceof z.ZodError)
        )
          continue;
        throw error;
      }
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
        protocol: {
          handlerId: state.protocolId,
          gameVersion: state.gameVersion,
          role: row.role,
          ...(minecraft ? { minecraft } : {}),
        },
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
      expiresAt: new Date(
        Math.min(
          now + config.gatewayLeaseSeconds * 1000,
          ...routes.map((route) =>
            route.protocol?.minecraft && route.protocol.minecraft.supportSource !== 'integration'
              ? Date.parse(route.protocol.minecraft.evidenceExpiresAt)
              : Number.POSITIVE_INFINITY,
          ),
        ),
      ).toISOString(),
      routes,
    });
  });
}
export async function requireGatewayRoute(
  db: Kysely<Database>,
  routeId: string,
  revision: number | undefined,
  env: Environment = {},
  options: { revisionPrecondition?: boolean } = {},
) {
  const snapshot = await getGatewaySnapshot(db, env),
    route = snapshot.routes.find((row) => row.id === routeId);
  if (!route) throw new DomainError('not_found');
  // A supplied route revision is an authenticated HTTP precondition. Keep this
  // distinguishable from unknown topology/ownership failures so Gateway can
  // fetch and fully validate a fresh snapshot within its existing lease.
  if (revision !== undefined && route.revision !== revision)
    throw new DomainError('conflict', options.revisionPrecondition ? 412 : 409);
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
    .where('s.connection_mode', '=', 'gateway')
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
