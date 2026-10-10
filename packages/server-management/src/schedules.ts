import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, recordAudit, type ScheduleTiming } from '@nickhosting/database';
import { type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources } from './admission.js';
import { requireMinecraftGatewayProtocol } from './gateway-registry.js';
import { currentInteractiveContext } from './interactive-context.js';
import { authorizeServer, enqueueLockedServerOperation, parse } from './registry.js';

const id = z.uuid();
const instant = z.iso.datetime({ offset: true });
export const scheduleTimingSchema = z.discriminatedUnion('kind', [
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

function firstRun(timing: ScheduleTiming) {
  return new Date(timing.kind === 'once' ? timing.at : timing.firstAt);
}

/** Fixed elapsed intervals anchored to firstAt, not local wall-clock cron. DST
 * changes display only. Collapse missed intervals to the latest due instant. */
export function scheduleOccurrence(timing: ScheduleTiming, next: Date, now: Date) {
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

function publicSchedule(row: Schedule) {
  return {
    id: row.id,
    serverId: row.server_id,
    creatorId: row.creator_id,
    name: row.name,
    action: row.action,
    timing: row.timing,
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
  return (
    await db
      .selectFrom('server_schedules')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .execute()
  ).map(publicSchedule);
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
    const count = await tx
      .selectFrom('server_schedules')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('server_id', '=', serverId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(count.count) >= 100) throw new DomainError('rate_limited');
    const next = firstRun(value.timing);
    if (next <= new Date()) throw new DomainError('validation_failed');
    const row = await tx
      .insertInto('server_schedules')
      .values({
        id: randomUUID(),
        server_id: serverId,
        creator_id: context.actorUserId,
        name: value.name,
        action: value.action,
        timing: JSON.stringify(value.timing),
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
    const changedTiming = !isDeepStrictEqual(old.timing, value.timing);
    const now = new Date();
    let next = changedTiming ? firstRun(value.timing) : old.next_run_at;
    if (changedTiming && next && next <= now) throw new DomainError('validation_failed');
    if (!old.enabled && value.enabled && next && next <= now) {
      // Re-enabling never replays the disabled window. A consumed one-shot needs
      // a new explicit future instant; an interval advances to its next slot.
      if (value.timing.kind === 'once') throw new DomainError('validation_failed');
      next = scheduleOccurrence(value.timing, next, now).next;
    }
    const row = await tx
      .updateTable('server_schedules')
      .set({
        creator_id: context.actorUserId,
        name: value.name,
        action: value.action,
        timing: JSON.stringify(value.timing),
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
      'occurrence.due_at as dueAt',
      'occurrence.action',
      'occurrence.status',
      'occurrence.reason',
      'occurrence.missed_count as missedCount',
      'occurrence.job_id as jobId',
      'job.state as jobState',
      'job.error_code as errorCode',
      'operation.phase',
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
  const items = found.slice(0, query.limit);
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
    !schedule?.enabled ||
    schedule.deleted_at ||
    schedule.revision !== marker.revision ||
    !occurrence ||
    occurrence.revision !== marker.revision ||
    occurrence.action !== operation.action ||
    !job ||
    job.actor_id !== schedule.creator_id ||
    job.subject_id !== schedule.creator_id ||
    job.support_session_id
  )
    throw new DomainError('forbidden');
  const context = await creatorContext(db, schedule.creator_id);
  const server = await authorizeServer(db, context, serverId, 'server:manage');
  if (['start', 'restart'].includes(operation.action)) {
    if (['manually_stopped', 'maintenance'].includes(server.intent))
      throw new DomainError('forbidden');
    const policy = await db
      .selectFrom('gateway_server_states')
      .select('generation')
      .where('server_id', '=', serverId)
      .executeTakeFirst();
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
  options: { now?: Date; limit?: number } = {},
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
    skipped = 0;
  for (const candidate of candidates) {
    const result = await db.transaction().execute(async (tx) => {
      // Same lock order as CRUD/admission prevents schedule/server deadlocks.
      await lockResources(tx);
      const schedule = await tx
        .selectFrom('server_schedules')
        .selectAll()
        .where('id', '=', candidate.id)
        .forUpdate()
        .executeTakeFirst();
      if (
        !schedule?.enabled ||
        schedule.deleted_at ||
        !schedule.next_run_at ||
        schedule.next_run_at > now
      )
        return;
      const occurrence = scheduleOccurrence(schedule.timing, schedule.next_run_at, now);
      const occurrenceId = randomUUID();
      let reason: string | null = occurrence.late ? 'schedule_late' : null;
      let jobId: string | null = null;
      await sql`savepoint schedule_admission`.execute(tx);
      try {
        if (!reason) {
          const context = await creatorContext(tx, schedule.creator_id);
          const server = await authorizeServer(tx, context, schedule.server_id, 'server:manage');
          if (
            ['start', 'restart'].includes(schedule.action) &&
            ['manually_stopped', 'maintenance'].includes(server.intent)
          )
            reason = 'manual_stop_suppressed';
          else {
            const policy = await tx
              .selectFrom('gateway_server_states')
              .selectAll()
              .where('server_id', '=', server.id)
              .executeTakeFirst();
            let generation = policy?.generation ?? null;
            if (schedule.action === 'stop') {
              // A scheduled stop is an explicit stop, not idle sleep. Revoke
              // future starts even if another job prevents this stop dispatch.
              await tx
                .updateTable('managed_servers')
                .set({ intent: 'manually_stopped' })
                .where('id', '=', server.id)
                .execute();
              if (policy) {
                generation = randomUUID();
                await tx
                  .updateTable('gateway_server_states')
                  .set({
                    generation,
                    state: 'manually_stopped',
                    readiness_observed_at: null,
                    idle_since: null,
                    updated_at: now,
                  })
                  .where('server_id', '=', server.id)
                  .execute();
              }
              await recordAudit(tx, context, 'schedule.stop_consent_revoked', {
                serverId: server.id,
                scheduleId: schedule.id,
                occurrenceId,
              });
              // Preserve the revocation if admission/another operation refuses
              // this occurrence. Never enqueue a waiting stop or replay it.
              await sql`release savepoint schedule_admission`.execute(tx);
              await sql`savepoint schedule_admission`.execute(tx);
            }
            const operation = await enqueueLockedServerOperation(
              tx,
              context,
              server.id,
              { action: schedule.action, idempotencyKey: `schedule_${occurrenceId}` },
              env,
            );
            jobId = operation.jobId;
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
          due_at: occurrence.due,
          action: schedule.action,
          status,
          reason,
          missed_count: occurrence.missed,
          job_id: jobId,
        })
        .execute();
      await tx
        .updateTable('server_schedules')
        .set({ next_run_at: occurrence.next, updated_at: now })
        .where('id', '=', schedule.id)
        .execute();
      return status;
    });
    if (result === 'dispatched') dispatched += 1;
    if (result === 'skipped') skipped += 1;
  }
  return { dispatched, skipped };
}
