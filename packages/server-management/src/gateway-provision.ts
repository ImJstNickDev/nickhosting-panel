import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import { type DB, type Environment, lockResources } from './admission.js';
import { effectiveBackendAllocationPool } from './allocation-pool.js';
import { trustedGameModules } from './game-modules.js';
import { gatewayConfiguration, validateGatewayRouteEndpoint } from './gateway-registry.js';

type Server = Selectable<Database['managed_servers']>;
const planSchema = z.strictObject({
  gatewayId: z.uuid(),
  physicalHostId: z.uuid(),
  routes: z
    .array(
      z.strictObject({
        id: z.uuid(),
        allocationId: z.uuid(),
        publicAddress: z.string(),
        publicPort: z.number().int().min(1).max(65535),
        transport: z.enum(['tcp', 'udp']),
      }),
    )
    .min(1)
    .max(128),
});

/** Reserve immutable listener intent in the same transaction as allocation claims.
 * Disabled rows reserve the namespace but never enter a Gateway snapshot. */
export async function planProvisionGateway(
  tx: DB,
  server: Server,
  gameId: string,
  env: Environment = {},
  modules = trustedGameModules,
) {
  if (server.connection_mode === 'direct') return undefined;
  const module = modules.get(gameId);
  // Existing generic/legacy games without a compiled protocol binding retain
  // their explicit routing workflow; stored Owner flags cannot install codecs.
  if (!module?.gatewayPolicyBinding || !module.manifest.capabilities.readiness) return undefined;
  const config = await gatewayConfiguration(tx, env);
  const node = await tx
    .selectFrom('managed_nodes')
    .selectAll()
    .where('id', '=', server.node_id)
    .executeTakeFirstOrThrow();
  const pool = effectiveBackendAllocationPool(node, env);
  if (pool?.gatewayBindAddresses.length !== 1)
    throw new DomainError('configuration_invalid', 503, { reason: 'gateway_bind_ambiguous' });
  const address = pool.gatewayBindAddresses[0];
  if (!address) throw new DomainError('configuration_invalid');
  const claims = await tx
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', server.id)
    .orderBy('id')
    .execute();
  const plan = planSchema.parse({
    gatewayId: config.gatewayId,
    physicalHostId: config.gatewayPhysicalHostId,
    routes: claims.flatMap((claim) =>
      claim.protocols.map((transport) => ({
        id: randomUUID(),
        allocationId: claim.id,
        publicAddress: address,
        publicPort: claim.port,
        transport,
      })),
    ),
  });
  for (const route of plan.routes) {
    await validateGatewayRouteEndpoint(
      tx,
      server.node_id,
      { ...route, serverId: server.id, enabled: false },
      config,
      env,
    );
    await tx
      .insertInto('gateway_routes')
      .values({
        id: route.id,
        gateway_id: plan.gatewayId,
        server_id: server.id,
        allocation_id: route.allocationId,
        public_address: route.publicAddress,
        public_port: route.publicPort,
        transport: route.transport,
        enabled: false,
        payload_hash: null,
      })
      .execute();
  }
  return plan;
}

/** Only the provision worker calls this, under its durable per-server job lease.
 * No fabricated interactive Owner identity. The plan belongs to that exact job,
 * server and immutable allocation claims; retry cannot re-enable Owner changes. */
export async function activateProvisionGateway(
  db: Kysely<Database>,
  serverId: string,
  jobId: string,
  env: Environment = {},
  modules = trustedGameModules,
) {
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const operation = await tx
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow();
    if (operation.plan.gatewayProvision === undefined) return;
    if (operation.action !== 'provision' || operation.server_id !== serverId)
      throw new DomainError('conflict');
    const server = await tx
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (
      server.active_operation_id !== jobId ||
      server.connection_mode !== 'gateway' ||
      !server.pterodactyl_id ||
      !server.pterodactyl_uuid ||
      server.installation_state !== 'installed'
    )
      throw new DomainError('conflict');
    const plan = planSchema.parse(operation.plan.gatewayProvision);
    // All validation happens before any row becomes visible; rollback is atomic.
    for (const route of plan.routes) {
      const stored = await tx
        .selectFrom('gateway_routes')
        .selectAll()
        .where('id', '=', route.id)
        .executeTakeFirst();
      if (
        !stored ||
        stored.gateway_id !== plan.gatewayId ||
        stored.server_id !== server.id ||
        stored.allocation_id !== route.allocationId ||
        stored.public_address !== route.publicAddress ||
        stored.public_port !== route.publicPort ||
        stored.transport !== route.transport
      )
        throw new DomainError('conflict');
    }
    // Confirmation retries never retarget or re-enable routes. Changed Owner
    // config is enforced by live snapshot/preflight fences, not replayed effects.
    if (operation.plan.gatewayRoutesActivated === true) return;
    const config = await gatewayConfiguration(tx, env);
    if (plan.gatewayId !== config.gatewayId || plan.physicalHostId !== config.gatewayPhysicalHostId)
      throw new DomainError('configuration_invalid');
    const mapping = await tx
      .selectFrom('runtime_egg_mappings')
      .select('game_id')
      .where('id', '=', server.mapping_id)
      .executeTakeFirstOrThrow();
    const binding = await modules.get(mapping.game_id)?.gatewayPolicyBinding?.(tx, server, env);
    if (!binding) throw new DomainError('integration_unavailable');
    for (const route of plan.routes) {
      await validateGatewayRouteEndpoint(
        tx,
        server.node_id,
        { ...route, serverId, enabled: true },
        config,
        env,
      );
    }
    const initialized = await tx
      .insertInto('gateway_server_states')
      .values({
        server_id: serverId,
        generation: randomUUID(),
        enabled: false,
        protocol_id: binding.protocolId,
        game_version: binding.gameVersion,
        state: server.intent === 'maintenance' ? 'maintenance' : 'manually_stopped',
        idle_timeout_seconds: null,
        idle_timeout_inherited: true,
        readiness_timeout_seconds: 600,
        readiness_max_age_seconds: 30,
        estimate_max_age_seconds: 604800,
        wake_retry_seconds: 10,
        wake_job_id: null,
        sleep_job_id: null,
        process_started_at: null,
        readiness_observed_at: null,
        startup_deadline_at: null,
        idle_since: null,
        last_observed_at: null,
        last_activity_at: null,
        blocked_until: null,
        error_code: null,
      })
      .onConflict((c) => c.column('server_id').doNothing())
      .returning('generation')
      .executeTakeFirst();
    await tx
      .updateTable('gateway_routes')
      .set({ enabled: true, updated_at: new Date() })
      .where(
        'id',
        'in',
        plan.routes.map((route) => route.id),
      )
      .execute();
    await tx
      .updateTable('server_operations')
      .set({
        plan: JSON.stringify({
          ...operation.plan,
          gatewayRoutesActivated: true,
          gatewayPolicyGeneration: initialized?.generation ?? null,
        }),
        updated_at: new Date(),
      })
      .where('job_id', '=', jobId)
      .execute();
  });
}

/** Initial explicit Create+Start is a launch, not permanent auto-start consent.
 * Replays preserve its generation and any later manual/maintenance suppression. */
export async function prepareProvisionGatewayStart(
  db: Kysely<Database>,
  serverId: string,
  jobId: string,
  now: Date,
) {
  await db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const operation = await tx
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow();
    if (operation.plan.gatewayRoutesActivated !== true) return;
    if (
      operation.action !== 'provision' ||
      operation.server_id !== serverId ||
      operation.plan.autoStart !== true
    )
      throw new DomainError('conflict');
    const state = await tx
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    if (state.wake_job_id === jobId) return;
    // A concurrent explicit manual stop/policy edit must not be overwritten by
    // the pending first start. Only our untouched initial policy grants this transition.
    if (operation.plan.gatewayPolicyGeneration !== state.generation)
      throw new DomainError('conflict');
    const server = await tx
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    if (server.active_operation_id !== jobId) throw new DomainError('conflict');
    // A new provision starts manually_stopped. Maintenance is never cleared.
    if (server.intent === 'maintenance') throw new DomainError('conflict');
    const generation = randomUUID();
    await tx
      .updateTable('gateway_server_states')
      .set({
        generation,
        state: 'waking',
        wake_job_id: jobId,
        sleep_job_id: null,
        process_started_at: null,
        readiness_observed_at: null,
        idle_since: null,
        error_code: null,
        startup_deadline_at: new Date(now.getTime() + state.readiness_timeout_seconds * 1000),
        updated_at: now,
      })
      .where('server_id', '=', serverId)
      .execute();
    await tx
      .updateTable('managed_servers')
      .set({ intent: 'auto_wake_enabled', readiness: 'loading' })
      .where('id', '=', serverId)
      .execute();
    await tx
      .updateTable('server_operations')
      .set({
        plan: JSON.stringify({ ...operation.plan, gatewayInitialStartGeneration: generation }),
      })
      .where('job_id', '=', jobId)
      .execute();
  });
}

/** Recheck after durable power intent, immediately before the external handoff.
 * Confirming an already issued start never calls this and cannot replay it. */
export async function assertProvisionGatewayStart(
  db: Kysely<Database>,
  serverId: string,
  jobId: string,
) {
  await db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const operation = await tx
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow();
    if (operation.plan.gatewayRoutesActivated !== true) return;
    const state = await tx
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    const server = await tx
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    if (
      operation.action !== 'provision' ||
      operation.server_id !== serverId ||
      operation.plan.autoStart !== true ||
      server.active_operation_id !== jobId ||
      server.intent !== 'auto_wake_enabled' ||
      state.wake_job_id !== jobId ||
      state.state !== 'waking' ||
      state.generation !== operation.plan.gatewayInitialStartGeneration
    )
      throw new DomainError('conflict');
  });
}
