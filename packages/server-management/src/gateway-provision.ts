import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
import { type DB, type Environment, lockResources } from './admission.js';
import { effectiveBackendAllocationPool } from './allocation-pool.js';
import { trustedGameModules } from './game-modules.js';
import { gatewayConfiguration, validateGatewayRouteEndpoint } from './gateway-registry.js';

type Server = Selectable<Database['managed_servers']>;
type Operation = Selectable<Database['server_operations']>;
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
    await activateReservedGateway(tx, server, operation, env, modules);
  });
}

/** Reconciliation already holds resource/server locks and has verified provider
 * identity and installed state. Recover only untouched initial route reservations
 * after a later successful reinstall. Manual-stop intent remains authoritative. */
export async function recoverProvisionGateway(
  tx: DB,
  serverId: string,
  now: Date,
  env: Environment = {},
  modules = trustedGameModules,
) {
  const server = await tx
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (
    server?.connection_mode !== 'gateway' ||
    server.active_operation_id ||
    server.installation_state !== 'installed' ||
    !server.pterodactyl_id ||
    !server.pterodactyl_uuid
  )
    return;
  if (
    await tx
      .selectFrom('gateway_server_states')
      .select('server_id')
      .where('server_id', '=', serverId)
      .executeTakeFirst()
  )
    return;
  if (
    await tx
      .selectFrom('installation_reservations')
      .select('server_id')
      .where('server_id', '=', serverId)
      .executeTakeFirst()
  )
    return;
  const provision = await tx
    .selectFrom('server_operations as operation')
    .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
    .selectAll('operation')
    .select('job.completed_at')
    .where('operation.server_id', '=', serverId)
    .where('operation.action', '=', 'provision')
    .where('operation.phase', '=', 'failed')
    .where('job.state', '=', 'failed')
    .where('job.completed_at', 'is not', null)
    .executeTakeFirst();
  if (
    !provision?.completed_at ||
    provision.plan.gatewayProvision === undefined ||
    provision.plan.gatewayRoutesActivated !== undefined
  )
    return;
  const reinstall = await tx
    .selectFrom('server_operations as operation')
    .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
    .selectAll('operation')
    .select('job.completed_at')
    .where('operation.server_id', '=', serverId)
    .where('operation.action', '=', 'reinstall')
    .where('operation.phase', '=', 'complete')
    .where('operation.effect_state', '=', 'confirmed')
    .where('job.state', '=', 'succeeded')
    .where('job.created_at', '>=', provision.completed_at)
    .where('job.completed_at', '>', provision.completed_at)
    .orderBy('job.completed_at', 'desc')
    .executeTakeFirst();
  if (!reinstall?.completed_at || reinstall.plan.installConfirmed !== true) return;
  const plan = planSchema.parse(provision.plan.gatewayProvision);
  const routes = await tx
    .selectFrom('gateway_routes')
    .selectAll()
    .select(sql<boolean>`created_at = updated_at`.as('untouched'))
    .where('server_id', '=', serverId)
    .execute();
  // Revision alone is insufficient: an Owner disabling an unpublished route
  // only changes updated_at. Compare timestamps at PostgreSQL precision.
  if (
    routes.length !== plan.routes.length ||
    routes.some(
      (route) =>
        route.enabled ||
        String(route.revision) !== '1' ||
        route.payload_hash !== null ||
        route.lease_expires_at !== null ||
        !route.untouched,
    )
  )
    return;
  // Validate exact route identities atomically in the shared activation helper.
  // Never reconstruct a removed route or overwrite an existing Gateway policy.
  let start: { jobId: string; processStartedAt: string } | undefined;
  if (server.intent !== 'maintenance' && ['running', 'starting'].includes(server.runtime_state)) {
    const latest = await tx
      .selectFrom('server_operations as operation')
      .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
      .selectAll('operation')
      .select(['job.state as job_state', 'job.completed_at', 'job.created_at'])
      .where('operation.server_id', '=', serverId)
      .where('operation.action', 'in', [
        'start',
        'restart',
        'stop',
        'provision',
        'reinstall',
        'wipe',
        'delete',
        'restore',
      ])
      .orderBy('job.created_at', 'desc')
      .orderBy('operation.job_id', 'desc')
      .executeTakeFirst();
    const restart = latest?.action === 'restart';
    const epoch = receiptTime(
      restart ? latest?.plan.restartProcessStartedAt : latest?.plan.startProcessStartedAt,
    );
    const confirmed = receiptTime(
      restart ? latest?.plan.restartConfirmedAt : latest?.plan.startConfirmedAt,
    );
    if (
      latest &&
      ['start', 'restart'].includes(latest.action) &&
      latest.phase === 'complete' &&
      latest.effect_state === 'confirmed' &&
      latest.job_state === 'succeeded' &&
      latest.completed_at &&
      latest.created_at >= reinstall.completed_at &&
      latest.plan.gatewayAutomation === undefined &&
      latest.plan.scheduleAutomation === undefined &&
      (restart ? latest.plan.restartConfirmed : latest.plan.startConfirmed) === true &&
      latest.effect_started_at &&
      epoch !== null &&
      confirmed !== null &&
      epoch > BigInt(latest.effect_started_at.getTime()) * 1_000_000n &&
      confirmed >= epoch &&
      confirmed <= BigInt(now.getTime()) * 1_000_000n
    ) {
      start = {
        jobId: latest.job_id,
        processStartedAt: String(
          restart ? latest.plan.restartProcessStartedAt : latest.plan.startProcessStartedAt,
        ),
      };
    }
  }
  await activateReservedGateway(tx, server, provision, env, modules, {
    reinstallJobId: reinstall.job_id,
    now,
    start,
  });
}

function receiptTime(value: unknown): bigint | null {
  if (typeof value !== 'string' || !z.iso.datetime({ offset: true }).safeParse(value).success)
    return null;
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!parts) return null;
  return (
    BigInt(Date.parse(`${parts[1]}${parts[3]}`)) * 1_000_000n +
    BigInt((parts[2] ?? '').padEnd(9, '0'))
  );
}

/** Upgrade only the old generated policy default, under reconciliation locks.
 * An explicit policy save (even a no-op disable) is authoritative. Lifecycle
 * Start/Stop can rotate generation, so generation equality cannot prove intent. */
export async function reconcileProvisionGatewayAutomation(
  tx: DB,
  serverId: string,
  env: Environment = {},
  modules = trustedGameModules,
) {
  const server = await tx
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (
    server?.connection_mode !== 'gateway' ||
    server.active_operation_id ||
    server.installation_state !== 'installed' ||
    !server.pterodactyl_id ||
    !server.pterodactyl_uuid
  )
    return;
  const state = await tx
    .selectFrom('gateway_server_states')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (
    !state ||
    state.enabled ||
    !state.idle_timeout_inherited ||
    state.idle_timeout_seconds !== null ||
    state.owner_idle_timeout_seconds !== null ||
    state.owner_idle_timeout_user_access !== null ||
    state.readiness_timeout_seconds !== 600 ||
    state.readiness_max_age_seconds !== 30 ||
    state.estimate_max_age_seconds !== 604800 ||
    state.wake_retry_seconds !== 10
  )
    return;
  const operation = await tx
    .selectFrom('server_operations')
    .selectAll()
    .where('server_id', '=', serverId)
    .where('action', '=', 'provision')
    .where(sql<boolean>`plan->>'gatewayRoutesActivated' = 'true'
      and plan->>'gatewayAutomationInitialized' is distinct from 'true'`)
    .executeTakeFirst();
  if (
    !operation ||
    operation.plan.gatewayProvision === undefined ||
    typeof operation.plan.gatewayPolicyGeneration !== 'string'
  )
    return;
  if (
    await tx
      .selectFrom('audit_events')
      .select('id')
      .where('action', '=', 'gateway.policy.updated')
      .where(sql<boolean>`metadata->>'serverId' = ${serverId}`)
      .executeTakeFirst()
  )
    return;
  const binding = await provisionGatewayBinding(tx, server, env, modules);
  if (binding.protocolId !== state.protocol_id || binding.gameVersion !== state.game_version)
    throw new DomainError('conflict');
  await tx
    .updateTable('gateway_server_states')
    .set({ enabled: true })
    .where('server_id', '=', serverId)
    .execute();
  // Existing fresh idle observations remain evidence. The normal observation
  // path still requires current player/session/epoch proof before issuing sleep.
  await tx
    .updateTable('server_operations')
    .set({
      plan: JSON.stringify({ ...operation.plan, gatewayAutomationInitialized: true }),
    })
    .where('job_id', '=', operation.job_id)
    .execute();
}

async function provisionGatewayBinding(
  tx: DB,
  server: Server,
  env: Environment,
  modules: typeof trustedGameModules,
) {
  const mapping = await tx
    .selectFrom('runtime_egg_mappings')
    .select('game_id')
    .where('id', '=', server.mapping_id)
    .executeTakeFirstOrThrow();
  const binding = await modules.get(mapping.game_id)?.gatewayPolicyBinding?.(tx, server, env);
  if (!binding) throw new DomainError('integration_unavailable');
  return binding;
}

/** Shared atomic activation: callers validate their distinct durable authority. */
async function activateReservedGateway(
  tx: DB,
  server: Server,
  operation: Operation,
  env: Environment,
  modules: typeof trustedGameModules,
  recovery?: {
    reinstallJobId: string;
    now: Date;
    start?: { jobId: string; processStartedAt: string };
  },
) {
  const serverId = server.id;
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
  const binding = await provisionGatewayBinding(tx, server, env, modules);
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
      enabled: true,
      protocol_id: binding.protocolId,
      game_version: binding.gameVersion,
      state:
        server.intent === 'maintenance'
          ? 'maintenance'
          : recovery?.start
            ? 'waking'
            : 'manually_stopped',
      idle_timeout_seconds: null,
      idle_timeout_inherited: true,
      readiness_timeout_seconds: 600,
      readiness_max_age_seconds: 30,
      estimate_max_age_seconds: 604800,
      wake_retry_seconds: 10,
      wake_job_id: recovery?.start?.jobId ?? null,
      sleep_job_id: null,
      process_started_at: recovery?.start?.processStartedAt ?? null,
      readiness_observed_at: null,
      startup_deadline_at: recovery?.start ? new Date(recovery.now.getTime() + 600_000) : null,
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
        gatewayAutomationInitialized: true,
        ...(recovery
          ? {
              gatewayRecoveredAfterReinstall: recovery.reinstallJobId,
              gatewayRecoveredAt: recovery.now.toISOString(),
            }
          : {}),
      }),
      // Recovery bookkeeping must not make this failed provision appear newer
      // than a subsequent power receipt during normal runtime reconciliation.
      updated_at: recovery ? undefined : new Date(),
    })
    .where('job_id', '=', operation.job_id)
    .execute();
  if (recovery?.start)
    await tx
      .updateTable('managed_servers')
      .set({ intent: 'auto_wake_enabled', readiness: 'loading' })
      .where('id', '=', serverId)
      .execute();
}

/** Initial explicit Create+Start preserves inherited automation.
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
