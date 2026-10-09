import { createHash, randomUUID } from 'node:crypto';
import { type AuthContext, DomainError, type DomainErrorCode } from '@nickhosting/core';
import { type Database, type GatewayServerState, recordAudit } from '@nickhosting/database';
import { type Kysely, type Selectable, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { type DB, type Environment, lockResources } from './admission.js';
import { requireMinecraftGatewayProtocol } from './gateway-registry.js';
import { currentInteractiveContext } from './interactive-context.js';
import { authorizeServer, enqueueLockedServerOperation, parse } from './registry.js';

type State = Selectable<Database['gateway_server_states']>;
type Server = Selectable<Database['managed_servers']>;
export interface GatewayOrchestrationOptions {
  env?: Environment;
  /** Trusted Core route/revision revalidation, inside the observation's global
   * resource transaction lock. Required by the HTTP ingress integration. */
  validateObservation?: (tx: Transaction<Database>) => Promise<void>;
  /** Isolated deterministic tests only; production uses the actual clock. */
  now?: () => Date;
}
const nowOf = (options: GatewayOrchestrationOptions) => options.now?.() ?? new Date();

/** Docker process identities may contain nanoseconds; Date truncation must not
 * accept an earlier process in the same millisecond as the durable effect. */
function processNanoseconds(value: string): bigint | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(seconds)) return null;
  return BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}
export const gatewayPolicySchema = z.strictObject({
  enabled: z.boolean(),
  protocolId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  gameVersion: z.string().min(1).max(100),
  idleTimeoutSeconds: z.number().int().min(1).max(604800).nullable(),
  readinessTimeoutSeconds: z.number().int().min(1).max(86400),
  readinessMaxAgeSeconds: z.number().int().min(1).max(300),
  estimateMaxAgeSeconds: z.number().int().min(60).max(2592000),
  wakeRetrySeconds: z.number().int().min(1).max(300),
  mode: z.enum(['auto', 'maintenance', 'manually_stopped']).default('auto'),
});
export type GatewayPolicy = z.infer<typeof gatewayPolicySchema>;
export interface GatewayStartupEstimate {
  sampleCount: number;
  p50Ms: number;
  p90Ms: number;
}
export interface GatewayState {
  serverId: string;
  generation: string;
  enabled: boolean;
  protocolId: string;
  gameVersion: string;
  state: GatewayServerState;
  wakeJobId: string | null;
  sleepJobId: string | null;
  processStartedAt: string | null;
  readinessObservedAt: string | null;
  sleepEligibleAt: string | null;
  errorCode: string | null;
  messageKey: string;
  startupEstimate: GatewayStartupEstimate | null;
}

function fingerprint(server: Server, state: State) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        mapping: server.mapping_id,
        limits: server.limits,
        protocol: state.protocol_id,
        version: state.game_version,
      }),
    )
    .digest('hex');
}

/** A small, recent, representative population only. Never invent progress or ETA. */
export function estimateGatewayStartup(
  durations: readonly number[],
): GatewayStartupEstimate | null {
  if (durations.length < 5 || durations.some((value) => !Number.isFinite(value) || value <= 0))
    return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const p50Ms = sorted[Math.ceil(sorted.length * 0.5) - 1] ?? 0;
  const p90Ms = sorted[Math.ceil(sorted.length * 0.9) - 1] ?? 0;
  if ((sorted[0] ?? 0) < p50Ms / 2 || p90Ms > p50Ms * 2) return null;
  return { sampleCount: sorted.length, p50Ms, p90Ms };
}

async function rows(db: DB, serverId: string) {
  parse(z.uuid(), serverId);
  const server = await db
    .selectFrom('managed_servers as server')
    .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
    .selectAll('server')
    .select(['mapping.game_id', 'mapping.runtime_id'])
    .where('server.id', '=', serverId)
    .where('server.deleted_at', 'is', null)
    .executeTakeFirst();
  const state = await db
    .selectFrom('gateway_server_states')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (!server?.pterodactyl_uuid || !state) throw new DomainError('not_found');
  return { server, state };
}

function effectiveState(server: Server, state: State, now: Date): GatewayServerState {
  if (server.intent === 'manually_stopped') return 'manually_stopped';
  if (server.intent === 'maintenance') return 'maintenance';
  if (
    state.state === 'online' &&
    (server.runtime_state !== 'running' ||
      !state.readiness_observed_at ||
      !state.process_started_at ||
      now.getTime() - state.readiness_observed_at.getTime() < 0 ||
      now.getTime() - state.readiness_observed_at.getTime() >
        state.readiness_max_age_seconds * 1000)
  )
    return 'blocked';
  if (
    state.state === 'sleeping' &&
    (server.runtime_state !== 'offline' || server.active_operation_id)
  )
    return 'blocked';
  return state.state;
}

async function publicState(db: DB, server: Server, state: State, now: Date): Promise<GatewayState> {
  const samples = await db
    .selectFrom('gateway_startup_samples')
    .select('duration_ms')
    .where('server_id', '=', server.id)
    .where('fingerprint', '=', fingerprint(server, state))
    .where('ready_at', '>=', new Date(now.getTime() - state.estimate_max_age_seconds * 1000))
    .where('ready_at', '<=', now)
    .orderBy('ready_at', 'desc')
    .limit(20)
    .execute();
  const actual = effectiveState(server, state, now);
  return {
    serverId: server.id,
    generation: state.generation,
    enabled: state.enabled,
    protocolId: state.protocol_id,
    gameVersion: state.game_version,
    state: actual,
    wakeJobId: state.wake_job_id,
    sleepJobId: state.sleep_job_id,
    processStartedAt: state.process_started_at,
    readinessObservedAt: state.readiness_observed_at?.toISOString() ?? null,
    sleepEligibleAt:
      state.enabled &&
      actual === 'online' &&
      state.idle_since &&
      state.idle_timeout_seconds !== null
        ? new Date(state.idle_since.getTime() + state.idle_timeout_seconds * 1000).toISOString()
        : null,
    errorCode:
      actual === 'blocked' ? (state.error_code ?? 'integration_unavailable') : state.error_code,
    messageKey: `gateway.states.${actual}`,
    startupEstimate: estimateGatewayStartup(samples.map((sample) => sample.duration_ms)),
  };
}

/** Caller performs interactive read authorization or authenticates the scoped Gateway route. */
export async function getGatewayState(
  db: DB,
  serverId: string,
  options: GatewayOrchestrationOptions = {},
) {
  const { server, state } = await rows(db, serverId);
  if (
    state.enabled &&
    (server.game_id === 'minecraft-java' || state.protocol_id === 'minecraft-java')
  )
    await requireMinecraftGatewayProtocol(
      db,
      serverId,
      { handlerId: state.protocol_id, gameVersion: state.game_version },
      options.env,
      nowOf(options),
    );
  return publicState(db, server, state, nowOf(options));
}

export async function setGatewayPolicy(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  input: unknown,
  options: GatewayOrchestrationOptions = {},
) {
  const value = parse(gatewayPolicySchema, input);
  // A temporary support session cannot leave a permanent automation grant behind.
  if (context.sessionType !== 'regular') throw new DomainError('forbidden');
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const current = await currentInteractiveContext(tx, context, options.env ?? {});
    const server = await authorizeServer(tx, current, serverId, 'server:manage');
    if (!server.pterodactyl_uuid || server.installation_state !== 'installed')
      throw new DomainError('conflict');
    const now = nowOf(options);
    if (value.enabled)
      await requireMinecraftGatewayProtocol(
        tx,
        serverId,
        { handlerId: value.protocolId, gameVersion: value.gameVersion },
        options.env,
        now,
      );
    const mode = !value.enabled && value.mode === 'auto' ? 'manually_stopped' : value.mode;
    const intent =
      mode === 'auto'
        ? server.runtime_state === 'offline'
          ? 'sleeping'
          : 'auto_wake_enabled'
        : mode;
    const initial: GatewayServerState =
      mode === 'auto'
        ? server.active_operation_id
          ? 'blocked'
          : server.runtime_state === 'offline'
            ? 'sleeping'
            : 'waking'
        : mode;
    const row = {
      server_id: serverId,
      generation: randomUUID(),
      enabled: value.enabled,
      protocol_id: value.protocolId,
      game_version: value.gameVersion,
      state: initial,
      idle_timeout_seconds: value.idleTimeoutSeconds,
      readiness_timeout_seconds: value.readinessTimeoutSeconds,
      readiness_max_age_seconds: value.readinessMaxAgeSeconds,
      estimate_max_age_seconds: value.estimateMaxAgeSeconds,
      wake_retry_seconds: value.wakeRetrySeconds,
      wake_job_id: null,
      sleep_job_id: null,
      process_started_at: null,
      readiness_observed_at: null,
      startup_deadline_at:
        initial === 'waking'
          ? new Date(now.getTime() + value.readinessTimeoutSeconds * 1000)
          : null,
      idle_since: null,
      last_observed_at: null,
      last_activity_at: null,
      blocked_until: null,
      error_code: server.active_operation_id ? 'operation_uncertain' : null,
      updated_at: now,
    };
    await tx
      .insertInto('gateway_server_states')
      .values(row)
      .onConflict((c) => c.column('server_id').doUpdateSet(row))
      .execute();
    await tx
      .updateTable('managed_servers')
      .set({ intent, readiness: 'unknown', updated_at: now })
      .where('id', '=', serverId)
      .execute();
    await recordAudit(tx, current, 'gateway.policy.updated', {
      serverId,
      generation: row.generation,
      ...value,
    });
    return getGatewayState(tx, serverId, options);
  });
}

async function ownerContext(tx: DB, server: Server): Promise<AuthContext> {
  const user = await tx
    .selectFrom('user')
    .select(['id', 'role'])
    .where('id', '=', server.owner_id)
    .executeTakeFirst();
  if (!user) throw new DomainError('forbidden');
  return {
    actorUserId: user.id,
    subjectUserId: user.id,
    role: user.role,
    sessionType: 'regular',
    ownerElevation: false,
  };
}

async function block(tx: Transaction<Database>, state: State, code: DomainErrorCode, now: Date) {
  await tx
    .updateTable('gateway_server_states')
    .set({
      state: 'blocked',
      error_code: code,
      blocked_until: new Date(now.getTime() + state.wake_retry_seconds * 1000),
      readiness_observed_at: null,
      idle_since: null,
      updated_at: now,
    })
    .where('server_id', '=', state.server_id)
    .execute();
  await tx
    .updateTable('managed_servers')
    .set({ readiness: 'degraded' })
    .where('id', '=', state.server_id)
    .execute();
}

/** Authenticated control-plane only. Status probes do not create work. PostgreSQL
 * serializes every joining client with ordinary M2 admission and manual stops. */
export async function requestGatewayWake(
  db: Kysely<Database>,
  serverId: string,
  input: unknown,
  options: GatewayOrchestrationOptions = {},
): Promise<GatewayState> {
  const value = parse(
    z.strictObject({ generation: z.uuid(), intent: z.enum(['status', 'join']) }),
    input,
  );
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const { server, state } = await rows(tx, serverId);
    const now = nowOf(options);
    if (value.generation !== state.generation) throw new DomainError('conflict');
    if (
      state.enabled &&
      (server.game_id === 'minecraft-java' || state.protocol_id === 'minecraft-java')
    )
      await requireMinecraftGatewayProtocol(
        tx,
        serverId,
        { handlerId: state.protocol_id, gameVersion: state.game_version },
        options.env,
        now,
      );
    if (
      value.intent === 'status' ||
      !state.enabled ||
      ['manually_stopped', 'maintenance'].includes(server.intent) ||
      state.state === 'waking' ||
      effectiveState(server, state, now) === 'online' ||
      (state.blocked_until && state.blocked_until > now)
    )
      return publicState(tx, server, state, now);
    // An uncertain reservation or operation is never a new automatic start.
    const reservation = await tx
      .selectFrom('resource_reservations')
      .select('server_id')
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (server.active_operation_id || reservation || server.runtime_state !== 'offline') {
      await block(tx, state, 'operation_uncertain', now);
      return getGatewayState(tx, serverId, options);
    }
    const actor = await ownerContext(tx, server);
    // Savepoint ensures any partial operation/admission changes roll back on a
    // denied request while the durable blocked state and diagnostics still commit.
    await sql`savepoint gateway_admission`.execute(tx);
    try {
      const result = await enqueueLockedServerOperation(
        tx,
        actor,
        serverId,
        {
          action: 'start',
          idempotencyKey: `gateway_wake_${randomUUID()}`,
        },
        options.env,
        { generation: state.generation, kind: 'wake' },
      );
      await tx
        .updateTable('gateway_server_states')
        .set({
          state: 'waking',
          wake_job_id: result.jobId,
          sleep_job_id: null,
          process_started_at: null,
          readiness_observed_at: null,
          idle_since: null,
          startup_deadline_at: new Date(now.getTime() + state.readiness_timeout_seconds * 1000),
          error_code: null,
          blocked_until: null,
          updated_at: now,
        })
        .where('server_id', '=', serverId)
        .execute();
      await tx
        .updateTable('managed_servers')
        .set({ intent: 'auto_wake_enabled', readiness: 'loading' })
        .where('id', '=', serverId)
        .execute();
      await recordAudit(tx, actor, 'gateway.wake.requested', {
        serverId,
        jobId: result.jobId,
        generation: state.generation,
      });
      await sql`release savepoint gateway_admission`.execute(tx);
    } catch (error) {
      await sql`rollback to savepoint gateway_admission`.execute(tx);
      if (!(error instanceof DomainError)) throw error;
      await block(tx, state, error.code, now);
    }
    return getGatewayState(tx, serverId, options);
  });
}

export const gatewayObservationSchema = z.strictObject({
  generation: z.uuid(),
  wakeJobId: z.uuid().nullable().optional(),
  observedAt: z.iso.datetime(),
  processStartedAt: z.iso.datetime({ offset: true }).nullable(),
  ready: z.boolean(),
  idle: z.boolean().optional(),
  playerCount: z.number().int().min(0).optional(),
  activeSessions: z.number().int().min(0),
  quiescenceUntil: z.iso.datetime().optional(),
});
export type GatewayObservation = z.infer<typeof gatewayObservationSchema>;

function assertQuiescenceDeadline(value: GatewayObservation, now: Date): void {
  if (!value.quiescenceUntil) throw new DomainError('validation_failed');
  const deadline = Date.parse(value.quiescenceUntil);
  if (deadline <= now.getTime() || deadline > Date.parse(value.observedAt) + 30000)
    throw new DomainError('validation_failed');
}

/** Accept only trusted Core corroboration of the exact process identity. The
 * HTTP Gateway report cannot supply its own processStartedAt to bypass this. */
export async function reportGatewayObservation(
  db: Kysely<Database>,
  serverId: string,
  input: unknown,
  options: GatewayOrchestrationOptions = {},
): Promise<GatewayState> {
  const value = parse(gatewayObservationSchema, input);
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    await options.validateObservation?.(tx);
    const { server, state } = await rows(tx, serverId);
    const now = nowOf(options),
      observed = new Date(value.observedAt);
    if (
      state.enabled &&
      (server.game_id === 'minecraft-java' || state.protocol_id === 'minecraft-java')
    )
      await requireMinecraftGatewayProtocol(
        tx,
        serverId,
        { handlerId: state.protocol_id, gameVersion: state.game_version },
        options.env,
        now,
      );
    if (value.quiescenceUntil) assertQuiescenceDeadline(value, now);
    if (value.generation !== state.generation || (value.wakeJobId ?? null) !== state.wake_job_id)
      throw new DomainError('conflict');
    if (
      observed > now ||
      now.getTime() - observed.getTime() > state.readiness_max_age_seconds * 1000 ||
      (state.last_observed_at && observed < state.last_observed_at)
    )
      throw new DomainError('validation_failed');
    if (['manually_stopped', 'maintenance'].includes(server.intent))
      return publicState(tx, server, state, now);
    // An identical observation is idempotent and cannot advance the idle timer.
    if (state.last_observed_at?.getTime() === observed.getTime())
      return publicState(tx, server, state, now);
    const activeOperation = server.active_operation_id
      ? await tx
          .selectFrom('server_operations')
          .select('action')
          .where('job_id', '=', server.active_operation_id)
          .executeTakeFirst()
      : undefined;
    if (
      !value.processStartedAt ||
      server.runtime_state !== 'running' ||
      (server.active_operation_id && activeOperation?.action !== 'backup')
    ) {
      await tx
        .updateTable('gateway_server_states')
        .set({
          last_observed_at: observed,
          idle_since: null,
          readiness_observed_at: null,
          updated_at: now,
        })
        .where('server_id', '=', serverId)
        .execute();
      return reconcileLocked(tx, serverId, options);
    }
    const processStart = new Date(value.processStartedAt);
    const processNanos = processNanoseconds(value.processStartedAt);
    if (
      !Number.isFinite(processStart.getTime()) ||
      processNanos === null ||
      processNanos <= 0n ||
      processNanos > BigInt(observed.getTime()) * 1_000_000n
    )
      throw new DomainError('validation_failed');
    if (state.process_started_at && state.process_started_at !== value.processStartedAt) {
      await block(tx, state, 'operation_uncertain', now);
      return getGatewayState(tx, serverId, options);
    }
    let operation: Selectable<Database['server_operations']> | undefined;
    if (state.wake_job_id) {
      const job = await tx
        .selectFrom('operation_jobs')
        .selectAll()
        .where('id', '=', state.wake_job_id)
        .executeTakeFirstOrThrow();
      operation = await tx
        .selectFrom('server_operations')
        .selectAll()
        .where('job_id', '=', state.wake_job_id)
        .executeTakeFirstOrThrow();
      if (
        job.state !== 'succeeded' ||
        !operation.effect_started_at ||
        processNanos <= BigInt(operation.effect_started_at.getTime()) * 1_000_000n ||
        operation.server_id !== serverId ||
        !['start', 'restart'].includes(operation.action)
      )
        throw new DomainError('operation_uncertain');
    }
    if (state.startup_deadline_at && now > state.startup_deadline_at && state.state !== 'online') {
      await block(tx, state, 'integration_unavailable', now);
      return getGatewayState(tx, serverId, options);
    }
    if (!value.ready) {
      await tx
        .updateTable('gateway_server_states')
        .set({
          state: state.state === 'online' ? 'blocked' : state.state,
          process_started_at: value.processStartedAt,
          readiness_observed_at: null,
          idle_since: null,
          last_observed_at: observed,
          updated_at: now,
          error_code: state.state === 'online' ? 'integration_unavailable' : state.error_code,
        })
        .where('server_id', '=', serverId)
        .execute();
      await tx
        .updateTable('managed_servers')
        .set({ readiness: 'loading' })
        .where('id', '=', serverId)
        .execute();
      return getGatewayState(tx, serverId, options);
    }
    const freshIdle = value.idle === true && value.activeSessions === 0 && value.playerCount === 0;
    // Unknown player count is not affirmative proof of idleness. Gaps reset the
    // interval; a stale Gateway cannot sleep a server based on silence.
    const continuous =
      state.last_observed_at !== null &&
      observed.getTime() - state.last_observed_at.getTime() <=
        state.readiness_max_age_seconds * 1000;
    const idleSince = freshIdle ? (continuous ? (state.idle_since ?? observed) : observed) : null;
    await tx
      .updateTable('gateway_server_states')
      .set({
        state: 'online',
        process_started_at: value.processStartedAt,
        readiness_observed_at: observed,
        startup_deadline_at: null,
        last_observed_at: observed,
        idle_since: idleSince,
        last_activity_at: freshIdle ? state.last_activity_at : observed,
        error_code: null,
        blocked_until: null,
        updated_at: now,
      })
      .where('server_id', '=', serverId)
      .execute();
    await tx
      .updateTable('managed_servers')
      .set({ readiness: 'ready' })
      .where('id', '=', serverId)
      .execute();
    if (state.wake_job_id && operation) {
      const duration = observed.getTime() - processStart.getTime();
      if (duration > 0 && duration <= state.readiness_timeout_seconds * 1000)
        await tx
          .insertInto('gateway_startup_samples')
          .values({
            server_id: serverId,
            job_id: state.wake_job_id,
            fingerprint: fingerprint(server, state),
            process_started_at: value.processStartedAt,
            ready_at: observed,
            duration_ms: duration,
          })
          .onConflict((c) => c.column('job_id').doNothing())
          .execute();
    }
    if (
      state.enabled &&
      value.quiescenceUntil !== undefined &&
      !server.active_operation_id &&
      state.idle_timeout_seconds !== null &&
      idleSince &&
      observed.getTime() - idleSince.getTime() >= state.idle_timeout_seconds * 1000
    ) {
      await sql`savepoint gateway_sleep`.execute(tx);
      try {
        await options.validateObservation?.(tx);
        assertQuiescenceDeadline(value, nowOf(options));
        const result = await enqueueLockedServerOperation(
          tx,
          await ownerContext(tx, server),
          serverId,
          {
            action: 'stop',
            idempotencyKey: `gateway_sleep_${randomUUID()}`,
          },
          options.env,
          { generation: state.generation, kind: 'sleep', quiescenceUntil: value.quiescenceUntil },
        );
        await tx
          .updateTable('gateway_server_states')
          .set({
            state: 'blocked',
            sleep_job_id: result.jobId,
            readiness_observed_at: null,
            idle_since: null,
            error_code: 'operation_uncertain',
            updated_at: now,
          })
          .where('server_id', '=', serverId)
          .execute();
        await options.validateObservation?.(tx);
        assertQuiescenceDeadline(value, nowOf(options));
        await sql`release savepoint gateway_sleep`.execute(tx);
      } catch (error) {
        await sql`rollback to savepoint gateway_sleep`.execute(tx);
        if (!(error instanceof DomainError)) throw error;
        await block(tx, state, error.code, nowOf(options));
      }
    }
    return getGatewayState(tx, serverId, options);
  });
}

async function reconcileLocked(
  tx: Transaction<Database>,
  serverId: string,
  options: GatewayOrchestrationOptions,
) {
  const { server, state } = await rows(tx, serverId);
  const now = nowOf(options);
  if (['manually_stopped', 'maintenance'].includes(server.intent)) {
    await tx
      .updateTable('gateway_server_states')
      .set({
        state: server.intent as GatewayServerState,
        readiness_observed_at: null,
        idle_since: null,
        updated_at: now,
      })
      .where('server_id', '=', serverId)
      .execute();
    return getGatewayState(tx, serverId, options);
  }
  if (state.sleep_job_id) {
    const job = await tx
      .selectFrom('operation_jobs')
      .selectAll()
      .where('id', '=', state.sleep_job_id)
      .executeTakeFirstOrThrow();
    const reservation = await tx
      .selectFrom('resource_reservations')
      .select('server_id')
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (
      job.state === 'succeeded' &&
      server.runtime_state === 'offline' &&
      !server.active_operation_id &&
      !reservation
    ) {
      await tx
        .updateTable('gateway_server_states')
        .set({
          state: 'sleeping',
          wake_job_id: null,
          sleep_job_id: null,
          process_started_at: null,
          readiness_observed_at: null,
          startup_deadline_at: null,
          last_observed_at: null,
          idle_since: null,
          error_code: null,
          blocked_until: null,
          updated_at: now,
        })
        .where('server_id', '=', serverId)
        .execute();
    } else if (job.state === 'failed') await block(tx, state, 'operation_uncertain', now);
  } else if (state.wake_job_id && state.state === 'waking') {
    const job = await tx
      .selectFrom('operation_jobs')
      .selectAll()
      .where('id', '=', state.wake_job_id)
      .executeTakeFirstOrThrow();
    if (job.state === 'failed')
      await block(
        tx,
        state,
        (job.error_code as DomainErrorCode | null) ?? 'integration_unavailable',
        now,
      );
    else if (state.startup_deadline_at && now > state.startup_deadline_at)
      await block(tx, state, 'integration_unavailable', now);
  } else if (state.state === 'online' && effectiveState(server, state, now) !== 'online') {
    await block(tx, state, 'integration_unavailable', now);
  } else if (
    state.state === 'waking' &&
    state.startup_deadline_at &&
    now > state.startup_deadline_at
  ) {
    await block(tx, state, 'integration_unavailable', now);
  }
  return getGatewayState(tx, serverId, options);
}

/** Reloads durable state after worker/API/Redis outages; never creates wake work
 * merely because a timer fired and never releases M2's resource reservations. */
export async function reconcileGatewayState(
  db: Kysely<Database>,
  serverId: string,
  options: GatewayOrchestrationOptions = {},
): Promise<GatewayState> {
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    return reconcileLocked(tx, serverId, options);
  });
}
