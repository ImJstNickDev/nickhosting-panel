import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type AuthContext, DomainError } from '@nickhosting/core';
import {
  type Database,
  notifyGatewayChange,
  recordAudit,
  type ScheduleTiming,
} from '@nickhosting/database';
import { type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources } from './admission.js';
import { backupOptionsSchema, backupRetentionSchema } from './backup-policy.js';
import { requireMinecraftGatewayProtocol } from './gateway-registry.js';
import { currentInteractiveContext } from './interactive-context.js';
import { authorizeServer, enqueueLockedServerOperation, parse } from './registry.js';
import { calendarOccurrence, firstScheduleRun, previewScheduleRuns } from './schedule-calendar.js';

const id = z.uuid();
const instant = z.iso.datetime({ offset: true });
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const scheduleTimingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('daily'), localTime }),
  z.strictObject({
    kind: z.literal('weekly'),
    localTime,
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((values) => new Set(values).size === values.length),
  }),
  z.strictObject({ kind: z.literal('once'), at: instant }),
  z.strictObject({
    kind: z.literal('interval'),
    firstAt: instant,
    everySeconds: z.number().int().min(300).max(31_536_000),
  }),
]);
export const scheduleSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  action: z.enum(['start', 'stop', 'restart', 'backup']),
  backupOptions: backupOptionsSchema.optional(),
  retention: backupRetentionSchema.optional(),
  timing: scheduleTimingSchema,
  timeZone: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
  enabled: z.boolean(),
});
export const scheduleUpdateSchema = scheduleSchema.extend({
  revision: z.number().int().positive(),
});
export const scheduleDeleteSchema = z.strictObject({ revision: z.number().int().positive() });
type Schedule = Selectable<Database['server_schedules']>;

export const automationConsentSchema = z.strictObject({
  allowed: z.boolean(),
  expectedIntent: z.enum(['manually_stopped', 'maintenance', 'auto_wake_enabled', 'sleeping']),
});

async function consentState(db: Kysely<Database>, context: AuthContext, serverId: string) {
  const server = await authorizeServer(db, context, serverId);
  const [policy, operation, upload, installation, reservation] = await Promise.all([
    db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst(),
    db
      .selectFrom('server_operations as operation')
      .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
      .select('job.id')
      .where('operation.server_id', '=', serverId)
      .where('job.state', 'in', ['queued', 'running'])
      .executeTakeFirst(),
    db
      .selectFrom('upload_ingestion_claims')
      .select('id')
      .where('server_id', '=', serverId)
      .executeTakeFirst(),
    db
      .selectFrom('installation_reservations')
      .select('server_id')
      .where('server_id', '=', serverId)
      .executeTakeFirst(),
    db
      .selectFrom('resource_reservations')
      .select('state')
      .where('server_id', '=', serverId)
      .executeTakeFirst(),
  ]);
  const grantBlockedReason =
    server.intent === 'maintenance'
      ? ('maintenance' as const)
      : server.active_operation_id || operation
        ? ('operation_active' as const)
        : upload
          ? ('upload_pending' as const)
          : installation || server.installation_state !== 'installed'
            ? ('installation_pending' as const)
            : reservation && reservation.state !== 'running'
              ? ('reservation_uncertain' as const)
              : null;
  return {
    server,
    policy: server.connection_mode === 'gateway' ? policy : undefined,
    grantBlockedReason,
  };
}

/** Shared automatic-start consent, not a second protocol or scheduling policy.
 * A real enabled Gateway also uses this same manual-stop suppression. */
export async function getAutomationConsent(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
) {
  const { server, policy, grantBlockedReason } = await consentState(db, context, serverId);
  return {
    allowed: !['manually_stopped', 'maintenance'].includes(server.intent),
    expectedIntent: server.intent,
    gatewayConfigured: Boolean(policy),
    gatewayEnabled: policy?.enabled ?? false,
    grantBlockedReason,
  };
}

/** Revocation is immediate, including during queued work. Granting again is
 * forbidden until all unfinished effects settle; no old session or queued job
 * gains a fresh consent. Existing Gateway generations/readiness are fenced. */
export async function setAutomationConsent(
  db: Kysely<Database>,
  previous: AuthContext,
  serverId: string,
  input: unknown,
  env: Environment = {},
) {
  const value = parse(automationConsentSchema, input);
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const context = await manager(tx, previous, serverId, env);
    const { server, policy, grantBlockedReason } = await consentState(tx, context, serverId);
    if (server.intent !== value.expectedIntent) throw new DomainError('conflict');
    if (value.allowed && grantBlockedReason) throw new DomainError('conflict');
    if (value.allowed && policy?.enabled)
      await requireMinecraftGatewayProtocol(
        tx,
        serverId,
        {
          handlerId: policy.protocol_id,
          gameVersion: policy.game_version,
        },
        env,
      );
    const now = new Date();
    const intent = value.allowed
      ? server.runtime_state === 'offline'
        ? ('sleeping' as const)
        : ('auto_wake_enabled' as const)
      : server.intent === 'maintenance'
        ? ('maintenance' as const)
        : ('manually_stopped' as const);
    if (policy) {
      const state = value.allowed
        ? server.runtime_state === 'offline'
          ? ('sleeping' as const)
          : ('waking' as const)
        : intent === 'maintenance'
          ? ('maintenance' as const)
          : ('manually_stopped' as const);
      await tx
        .updateTable('gateway_server_states')
        .set({
          generation: randomUUID(),
          state,
          // Revoked operations remain attributable to their jobs. They are not
          // cancelled/reset here and retain all existing effect reservations.
          ...(value.allowed
            ? { wake_job_id: null, sleep_job_id: null, process_started_at: null }
            : {}),
          readiness_observed_at: null,
          idle_since: null,
          last_observed_at: null,
          startup_deadline_at:
            state === 'waking'
              ? new Date(now.getTime() + policy.readiness_timeout_seconds * 1000)
              : null,
          error_code: null,
          blocked_until: null,
          updated_at: now,
        })
        .where('server_id', '=', serverId)
        .execute();
    }
    await tx
      .updateTable('managed_servers')
      .set({ intent, readiness: 'unknown', updated_at: now })
      .where('id', '=', serverId)
      .execute();
    await recordAudit(tx, context, 'server.automation_consent.updated', {
      serverId,
      allowed: value.allowed,
      gatewayConfigured: Boolean(policy),
    });
    return getAutomationConsent(tx, context, serverId);
  });
}

/** Fixed elapsed intervals anchored to firstAt, not local wall-clock cron. DST
 * changes display only. Collapse missed intervals to the latest due instant. */
export function scheduleOccurrence(
  timing: ScheduleTiming,
  next: Date,
  now: Date,
  timeZone = 'UTC',
) {
  if (timing.kind === 'daily' || timing.kind === 'weekly')
    return calendarOccurrence(timing, timeZone, next, now);
  const missed =
    timing.kind === 'interval'
      ? Math.max(0, Math.floor((now.getTime() - next.getTime()) / (timing.everySeconds * 1000)))
      : 0;
  const due = new Date(
    next.getTime() + (timing.kind === 'interval' ? missed * timing.everySeconds * 1000 : 0),
  );
  return {
    due,
    missed,
    next: timing.kind === 'interval' ? new Date(due.getTime() + timing.everySeconds * 1000) : null,
    late: now.getTime() - due.getTime() > 300_000,
  };
}

function scheduleBackupOptions(stored: Record<string, unknown>) {
  const { retention: _retention, ...options } = stored;
  return backupOptionsSchema.parse(options);
}

async function assertRetentionCapacity(db: Kysely<Database>, serverId: string, input: unknown) {
  const retention = backupRetentionSchema.parse(input ?? {});
  if (!retention.enabled) return;
  const mapping = await db
    .selectFrom('managed_servers as server')
    .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
    .select('mapping.feature_limits')
    .where('server.id', '=', serverId)
    .executeTakeFirstOrThrow();
  // A verified replacement must exist before pruning. Never ask Panel to
  // override its limit, which may delete unrelated unlocked snapshots.
  if (retention.keepLast >= mapping.feature_limits.backups)
    throw new DomainError('validation_failed');
}

function publicSchedule(row: Schedule) {
  return {
    id: row.id,
    serverId: row.server_id,
    creatorId: row.creator_id,
    authorizerId: row.authorizer_id,
    status: row.next_run_at === null ? 'completed' : row.enabled ? 'active' : 'paused',
    name: row.name,
    action: row.action,
    timing: row.timing,
    ...(row.action === 'backup'
      ? {
          backupOptions: scheduleBackupOptions(row.backup_options),
          retention: backupRetentionSchema.parse(
            (row.backup_options as Record<string, unknown>)?.retention ?? {},
          ),
        }
      : {}),
    timeZone: row.time_zone,
    enabled: row.enabled,
    revision: row.revision,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function manager(
  db: Kysely<Database>,
  previous: AuthContext,
  serverId: string,
  env: Environment,
) {
  if (previous.sessionType !== 'regular') throw new DomainError('forbidden');
  const context = await currentInteractiveContext(db, previous, env);
  await authorizeServer(db, context, serverId, 'server:manage');
  return context;
}

export async function listSchedules(db: Kysely<Database>, context: AuthContext, serverId: string) {
  await authorizeServer(db, context, serverId);
  const rows = await db
    .selectFrom('server_schedules as schedule')
    .innerJoin('user as authorizer', 'authorizer.id', 'schedule.authorizer_id')
    .innerJoin('user as creator', 'creator.id', 'schedule.creator_id')
    .selectAll('schedule')
    .select(['authorizer.name as authorizerName', 'creator.name as creatorName'])
    .where('schedule.server_id', '=', serverId)
    .where('schedule.deleted_at', 'is', null)
    .orderBy('schedule.created_at')
    .orderBy('schedule.id')
    .execute();
  const latest = rows.length
    ? await db
        .selectFrom('schedule_occurrences as occurrence')
        .leftJoin('operation_jobs as job', 'job.id', 'occurrence.job_id')
        .select([
          'occurrence.schedule_id',
          'occurrence.due_at as dueAt',
          'occurrence.status',
          'occurrence.reason',
          'occurrence.job_id as jobId',
          'job.state as jobState',
          'job.error_code as errorCode',
        ])
        .distinctOn('occurrence.schedule_id')
        .where(
          'occurrence.schedule_id',
          'in',
          rows.map((row) => row.id),
        )
        .orderBy('occurrence.schedule_id')
        .orderBy('occurrence.due_at', 'desc')
        .orderBy('occurrence.id', 'desc')
        .execute()
    : [];
  const latestBySchedule = new Map(
    latest.map(({ schedule_id, ...outcome }) => [schedule_id, outcome]),
  );
  return rows.map((row) => ({
    ...publicSchedule(row),
    creatorName: row.creatorName,
    authorizerName: row.authorizerName,
    lastOutcome: latestBySchedule.get(row.id) ?? null,
  }));
}

export async function createSchedule(
  db: Kysely<Database>,
  previous: AuthContext,
  serverId: string,
  input: unknown,
  env: Environment = {},
) {
  const value = parse(scheduleSchema, input);
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const context = await manager(tx, previous, serverId, env);
    if (value.action === 'backup') await assertRetentionCapacity(tx, serverId, value.retention);
    const count = await tx
      .selectFrom('server_schedules')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('server_id', '=', serverId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(count.count) >= 100) throw new DomainError('rate_limited');
    const next = firstScheduleRun(value.timing, value.timeZone);
    if (next <= new Date()) throw new DomainError('validation_failed');
    const row = await tx
      .insertInto('server_schedules')
      .values({
        id: randomUUID(),
        server_id: serverId,
        creator_id: context.actorUserId,
        authorizer_id: context.actorUserId,
        name: value.name,
        action: value.action,
        timing: JSON.stringify(value.timing),
        backup_options: JSON.stringify(
          value.action === 'backup'
            ? {
                ...backupOptionsSchema.parse(value.backupOptions ?? {}),
                retention: backupRetentionSchema.parse(value.retention ?? {}),
              }
            : {},
        ),
        time_zone: value.timeZone,
        enabled: value.enabled,
        next_run_at: next,
        deleted_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(tx, context, 'schedule.created', {
      scheduleId: row.id,
      serverId,
      action: row.action,
    });
    return publicSchedule(row);
  });
}

export async function updateSchedule(
  db: Kysely<Database>,
  previous: AuthContext,
  serverId: string,
  scheduleId: string,
  input: unknown,
  env: Environment = {},
) {
  parse(id, scheduleId);
  const value = parse(scheduleUpdateSchema, input);
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const context = await manager(tx, previous, serverId, env);
    if (value.action === 'backup') await assertRetentionCapacity(tx, serverId, value.retention);
    const old = await tx
      .selectFrom('server_schedules')
      .selectAll()
      .where('id', '=', scheduleId)
      .where('server_id', '=', serverId)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!old) throw new DomainError('not_found');
    if (old.revision !== value.revision) throw new DomainError('conflict');
    const changedTiming =
      !isDeepStrictEqual(old.timing, value.timing) ||
      ((value.timing.kind === 'daily' || value.timing.kind === 'weekly') &&
        old.time_zone !== value.timeZone);
    const now = new Date();
    let next = changedTiming
      ? firstScheduleRun(value.timing, value.timeZone, now)
      : old.next_run_at;
    if (value.enabled && !next) throw new DomainError('validation_failed');
    if (changedTiming && next && next <= now) throw new DomainError('validation_failed');
    if (!old.enabled && value.enabled && next && next <= now) {
      // Re-enabling never replays the disabled window. A consumed one-shot needs
      // a new explicit future instant; an interval advances to its next slot.
      if (value.timing.kind === 'once') throw new DomainError('validation_failed');
      next = scheduleOccurrence(value.timing, next, now, value.timeZone).next;
    }
    const row = await tx
      .updateTable('server_schedules')
      .set({
        authorizer_id: context.actorUserId,
        name: value.name,
        action: value.action,
        timing: JSON.stringify(value.timing),
        backup_options: JSON.stringify(
          value.action === 'backup'
            ? {
                ...backupOptionsSchema.parse(value.backupOptions ?? {}),
                retention: backupRetentionSchema.parse(value.retention ?? {}),
              }
            : {},
        ),
        time_zone: value.timeZone,
        enabled: value.enabled,
        revision: old.revision + 1,
        next_run_at: next,
        updated_at: now,
      })
      .where('id', '=', scheduleId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(tx, context, 'schedule.updated', {
      scheduleId,
      serverId,
      revision: row.revision,
      enabled: row.enabled,
    });
    return publicSchedule(row);
  });
}

export async function deleteSchedule(
  db: Kysely<Database>,
  previous: AuthContext,
  serverId: string,
  scheduleId: string,
  input: unknown,
  env: Environment = {},
) {
  parse(id, scheduleId);
  const value = parse(scheduleDeleteSchema, input);
  await db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const context = await manager(tx, previous, serverId, env);
    const row = await tx
      .updateTable('server_schedules')
      .set({
        enabled: false,
        deleted_at: new Date(),
        updated_at: new Date(),
        revision: value.revision + 1,
      })
      .where('id', '=', scheduleId)
      .where('server_id', '=', serverId)
      .where('revision', '=', value.revision)
      .where('deleted_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new DomainError('conflict');
    await recordAudit(tx, context, 'schedule.deleted', { scheduleId, serverId });
  });
}

export async function listScheduleOutcomes(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  scheduleId: string,
  input: unknown = {},
) {
  await authorizeServer(db, context, serverId);
  parse(id, scheduleId);
  const query = parse(
    z.strictObject({
      before: id.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
    input,
  );
  if (
    !(await db
      .selectFrom('server_schedules')
      .select('id')
      .where('id', '=', scheduleId)
      .where('server_id', '=', serverId)
      .executeTakeFirst())
  )
    throw new DomainError('not_found');
  let rows = db
    .selectFrom('schedule_occurrences as occurrence')
    .leftJoin('operation_jobs as job', 'job.id', 'occurrence.job_id')
    .leftJoin('server_operations as operation', 'operation.job_id', 'occurrence.job_id')
    .select([
      'occurrence.id',
      'occurrence.revision',
      'occurrence.trigger',
      'occurrence.requester_id as requesterId',
      'occurrence.due_at as dueAt',
      'occurrence.action',
      'occurrence.status',
      'occurrence.reason',
      'occurrence.missed_count as missedCount',
      'occurrence.job_id as jobId',
      'job.state as jobState',
      'job.error_code as errorCode',
      'operation.phase',
      'operation.plan',
      'operation.effect_state as effectState',
      'job.completed_at as completedAt',
    ])
    .where('occurrence.schedule_id', '=', scheduleId);
  if (query.before) {
    const cursor = await db
      .selectFrom('schedule_occurrences')
      .select(['due_at', 'id'])
      .where('id', '=', query.before)
      .where('schedule_id', '=', scheduleId)
      .executeTakeFirst();
    if (!cursor) throw new DomainError('validation_failed');
    rows = rows.where((eb) =>
      eb.or([
        eb('occurrence.due_at', '<', cursor.due_at),
        eb.and([eb('occurrence.due_at', '=', cursor.due_at), eb('occurrence.id', '<', cursor.id)]),
      ]),
    );
  }
  const found = await rows
    .orderBy('occurrence.due_at', 'desc')
    .orderBy('occurrence.id', 'desc')
    .limit(query.limit + 1)
    .execute();
  const items = found.slice(0, query.limit).map(({ plan, ...row }) => ({
    ...row,
    backupResult:
      row.action === 'backup' && plan
        ? {
            state:
              plan.backupComplete === true
                ? 'succeeded'
                : plan.backupFailed === true
                  ? 'failed'
                  : 'pending',
            resume: ['pending', 'succeeded', 'failed', 'suppressed'].includes(
              String(plan.backupResumeOutcome),
            )
              ? String(plan.backupResumeOutcome)
              : null,
            cleanupFailed:
              typeof plan.backupCleanupError === 'string' && plan.backupCleanupComplete !== true,
            retentionFailed: typeof plan.backupRetentionError === 'string',
          }
        : null,
  }));
  return { items, nextCursor: found.length > query.limit ? (items.at(-1)?.id ?? null) : null };
}

async function creatorContext(db: Kysely<Database>, creatorId: string): Promise<AuthContext> {
  const user = await db
    .selectFrom('user')
    .select(['id', 'role', 'emailVerified'])
    .where('id', '=', creatorId)
    .executeTakeFirst();
  if (!user?.emailVerified) throw new DomainError('forbidden');
  return {
    actorUserId: user.id,
    subjectUserId: user.id,
    role: user.role,
    sessionType: 'regular',
    ownerElevation: false,
  };
}

const markerSchema = z.strictObject({
  scheduleId: id,
  occurrenceId: id,
  revision: z.number().int().positive(),
  gatewayGeneration: id.nullable(),
  retention: backupRetentionSchema.optional(),
  stopIntent: z.enum(['sleeping', 'manually_stopped', 'maintenance']).optional(),
  manual: z.boolean().optional(),
});

/** Called by the existing lifecycle authorizer before NEW provider effects.
 * Reconciliation of prepared/uncertain effects remains the lifecycle's job. */
export async function authorizeScheduledEffect(
  db: Kysely<Database>,
  jobId: string,
  serverId: string,
) {
  const operation = await db
    .selectFrom('server_operations')
    .select(['plan', 'action'])
    .where('job_id', '=', jobId)
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (!operation) throw new DomainError('forbidden');
  const parsed = markerSchema.safeParse(operation.plan.scheduleAutomation);
  if (!parsed.success) throw new DomainError('forbidden');
  const marker = parsed.data;
  const schedule = await db
    .selectFrom('server_schedules')
    .selectAll()
    .where('id', '=', marker.scheduleId)
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  const occurrence = await db
    .selectFrom('schedule_occurrences')
    .selectAll()
    .where('id', '=', marker.occurrenceId)
    .where('schedule_id', '=', marker.scheduleId)
    .where('job_id', '=', jobId)
    .executeTakeFirst();
  const job = await db
    .selectFrom('operation_jobs')
    .select(['actor_id', 'subject_id', 'support_session_id'])
    .where('id', '=', jobId)
    .executeTakeFirst();
  if (
    !schedule ||
    (!schedule.enabled && !marker.manual) ||
    schedule.deleted_at ||
    schedule.revision !== marker.revision ||
    !occurrence ||
    occurrence.revision !== marker.revision ||
    occurrence.action !== operation.action ||
    !job ||
    occurrence.trigger !== (marker.manual ? 'manual' : 'scheduled') ||
    job.actor_id !== (marker.manual ? occurrence.requester_id : schedule.authorizer_id) ||
    job.subject_id !== job.actor_id ||
    job.support_session_id
  )
    throw new DomainError('forbidden');
  const context = await creatorContext(db, job.actor_id);
  const server = await authorizeServer(db, context, serverId, 'server:manage');
  if (['start', 'restart'].includes(operation.action)) {
    if (['manually_stopped', 'maintenance'].includes(server.intent))
      throw new DomainError('forbidden');
    const policy =
      server.connection_mode === 'gateway'
        ? await db
            .selectFrom('gateway_server_states')
            .select('generation')
            .where('server_id', '=', serverId)
            .executeTakeFirst()
        : undefined;
    if ((policy?.generation ?? null) !== marker.gatewayGeneration)
      throw new DomainError('forbidden');
  }
}

/** PostgreSQL owns the due claim, lifecycle job and outbox in a single commit.
 * Redis loss never replays admission or a provider effect. Bounded polls skip
 * conflicts/capacity refusals; neither missed runs nor denied starts are queued. */
export async function runDueSchedules(
  db: Kysely<Database>,
  env: Environment = {},
  options: { now?: Date; limit?: number; onError?: (id: string, error: unknown) => void } = {},
) {
  const now = options.now ?? new Date();
  const limit = parse(z.number().int().min(1).max(100), options.limit ?? 25);
  const candidates = await db
    .selectFrom('server_schedules')
    .select('id')
    .where('enabled', '=', true)
    .where('deleted_at', 'is', null)
    .where('next_run_at', '<=', now)
    .orderBy('next_run_at')
    .limit(limit)
    .execute();
  let dispatched = 0,
    skipped = 0,
    failures = 0;
  for (const candidate of candidates) {
    try {
      const result = await dispatchSchedule(db, candidate.id, env, now);
      if (result?.status === 'dispatched') dispatched += 1;
      if (result?.status === 'skipped') skipped += 1;
    } catch (error) {
      // A malformed row or infrastructure error rolls back only this candidate.
      // Preserve its due time for recovery and continue unrelated schedules.
      options.onError?.(candidate.id, error);
      failures += 1;
    }
  }
  return { dispatched, skipped, ...(failures ? { failures } : {}) };
}

type ManualScheduleRequest = {
  context: AuthContext;
  serverId: string;
  revision: number;
  idempotencyKey: string;
};
async function dispatchSchedule(
  db: Kysely<Database>,
  scheduleId: string,
  env: Environment,
  now: Date,
  request?: ManualScheduleRequest,
) {
  return db.transaction().execute(async (tx) => {
    // Same lock order as CRUD/admission prevents schedule/server deadlocks.
    await lockResources(tx);
    const schedule = await tx
      .selectFrom('server_schedules')
      .selectAll()
      .where('id', '=', scheduleId)
      .forUpdate()
      .executeTakeFirst();
    const interactive = request ? await manager(tx, request.context, request.serverId, env) : null;
    if (request && (!schedule || schedule.server_id !== request.serverId || schedule.deleted_at))
      throw new DomainError('not_found');
    if (request) {
      const previous = await tx
        .selectFrom('schedule_occurrences')
        .selectAll()
        .where('schedule_id', '=', scheduleId)
        .where('requester_id', '=', request.context.actorUserId)
        .where('request_key', '=', request.idempotencyKey)
        .executeTakeFirst();
      if (previous) {
        if (previous.revision !== request.revision) throw new DomainError('conflict');
        return {
          occurrenceId: previous.id,
          status: previous.status,
          jobId: previous.job_id,
          reason: previous.reason,
        };
      }
      if (schedule?.revision !== request.revision) throw new DomainError('conflict');
    }
    if (
      !request &&
      (!schedule?.enabled ||
        schedule.deleted_at ||
        !schedule.next_run_at ||
        schedule.next_run_at > now)
    )
      return;
    if (!schedule) return;
    const occurrence = request
      ? { due: now, missed: 0, next: schedule.next_run_at, late: false }
      : scheduleOccurrence(schedule.timing, schedule.next_run_at as Date, now, schedule.time_zone);
    const occurrenceId = randomUUID();
    let reason: string | null = occurrence.late ? 'schedule_late' : null;
    let jobId: string | null = null;
    await sql`savepoint schedule_admission`.execute(tx);
    try {
      if (!reason) {
        const context = interactive ?? (await creatorContext(tx, schedule.authorizer_id));
        const server = await authorizeServer(tx, context, schedule.server_id, 'server:manage');
        if (schedule.action === 'backup')
          await assertRetentionCapacity(tx, server.id, schedule.backup_options.retention);
        if (
          ['start', 'restart'].includes(schedule.action) &&
          ['manually_stopped', 'maintenance'].includes(server.intent)
        )
          reason = 'manual_stop_suppressed';
        else {
          const policy =
            server.connection_mode === 'gateway'
              ? await tx
                  .selectFrom('gateway_server_states')
                  .selectAll()
                  .where('server_id', '=', server.id)
                  .executeTakeFirst()
              : undefined;
          let generation = policy?.generation ?? null;
          const operation = await enqueueLockedServerOperation(
            tx,
            context,
            server.id,
            {
              action: schedule.action,
              idempotencyKey: `schedule_${occurrenceId}`,
              ...(schedule.action === 'backup'
                ? scheduleBackupOptions(schedule.backup_options)
                : {}),
            },
            env,
          );
          jobId = operation.jobId;
          const stopIntent = ['manually_stopped', 'maintenance'].includes(server.intent)
            ? (server.intent as 'manually_stopped' | 'maintenance')
            : ('sleeping' as const);
          if (schedule.action === 'stop') {
            await tx
              .updateTable('managed_servers')
              .set({ intent: stopIntent, updated_at: now })
              .where('id', '=', server.id)
              .execute();
            if (policy)
              await tx
                .updateTable('gateway_server_states')
                .set({
                  sleep_job_id: jobId,
                  idle_since: null,
                  readiness_observed_at: null,
                  updated_at: now,
                })
                .where('server_id', '=', server.id)
                .execute();
          }
          if (policy && ['start', 'restart'].includes(schedule.action)) {
            generation = randomUUID();
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
                startup_deadline_at: new Date(
                  now.getTime() + policy.readiness_timeout_seconds * 1000,
                ),
                error_code: null,
                updated_at: now,
              })
              .where('server_id', '=', server.id)
              .execute();
            await tx
              .updateTable('managed_servers')
              .set({ intent: 'auto_wake_enabled', readiness: 'loading' })
              .where('id', '=', server.id)
              .execute();
          }
          if (policy && ['start', 'stop', 'restart'].includes(schedule.action))
            await notifyGatewayChange(tx);
          const stored = await tx
            .selectFrom('server_operations')
            .select('plan')
            .where('job_id', '=', jobId)
            .executeTakeFirstOrThrow();
          await tx
            .updateTable('server_operations')
            .set({
              plan: JSON.stringify({
                ...stored.plan,
                scheduleAutomation: {
                  scheduleId: schedule.id,
                  ...(request ? { manual: true } : {}),
                  ...(schedule.action === 'stop' ? { stopIntent } : {}),
                  ...(schedule.action === 'backup'
                    ? {
                        retention: backupRetentionSchema.parse(
                          schedule.backup_options.retention ?? {},
                        ),
                      }
                    : {}),
                  occurrenceId,
                  revision: schedule.revision,
                  gatewayGeneration: generation,
                },
              }),
            })
            .where('job_id', '=', jobId)
            .execute();
          await recordAudit(tx, context, 'schedule.dispatched', {
            serverId: server.id,
            scheduleId: schedule.id,
            occurrenceId,
            jobId,
          });
        }
      }
      await sql`release savepoint schedule_admission`.execute(tx);
    } catch (error) {
      await sql`rollback to savepoint schedule_admission`.execute(tx);
      if (!(error instanceof DomainError)) throw error;
      reason = error.code;
      jobId = null;
    }
    const status = jobId ? 'dispatched' : 'skipped';
    await tx
      .insertInto('schedule_occurrences')
      .values({
        id: occurrenceId,
        schedule_id: schedule.id,
        revision: schedule.revision,
        trigger: request ? 'manual' : 'scheduled',
        request_key: request?.idempotencyKey ?? null,
        requester_id: request?.context.actorUserId ?? null,
        due_at: occurrence.due,
        action: schedule.action,
        status,
        reason,
        missed_count: occurrence.missed,
        job_id: jobId,
      })
      .execute();
    if (!request)
      await tx
        .updateTable('server_schedules')
        .set({ next_run_at: occurrence.next, updated_at: now })
        .where('id', '=', schedule.id)
        .execute();
    return { occurrenceId, status, jobId, reason };
  });
}

export async function runScheduleNow(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  scheduleId: string,
  input: unknown,
  env: Environment = {},
) {
  parse(id, scheduleId);
  const value = parse(
    z.strictObject({
      revision: z.number().int().positive(),
      idempotencyKey: z
        .string()
        .min(8)
        .max(128)
        .regex(/^[a-zA-Z0-9_-]+$/),
    }),
    input,
  );
  return dispatchSchedule(db, scheduleId, env, new Date(), { context, serverId, ...value });
}

export async function previewSchedule(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  input: unknown,
) {
  await authorizeServer(db, context, serverId);
  const value = parse(scheduleSchema.pick({ timing: true, timeZone: true }), input);
  return { nextRuns: previewScheduleRuns(value.timing, value.timeZone) };
}
