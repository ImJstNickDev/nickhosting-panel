import { randomUUID } from 'node:crypto';
import {
  type AuthContext,
  assertPermission,
  DomainError,
  type DomainErrorCode,
  domainErrorCodes,
  safeError,
} from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { type Kysely, type Selectable, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { commandDigest, type JobCommand, parseCommand, retryDelayMs } from './contracts.js';

type JobState = Selectable<Database['operation_jobs']>['state'];

export interface EnqueueCommandInput {
  context: AuthContext;
  resourceOwnerId: string;
  idempotencyKey: string;
  command: unknown;
  maxAttempts?: number;
}

export interface JobStatus {
  id: string;
  state: JobState;
  messageKey: `jobs.${JobState}`;
  actorId: string;
  subjectId: string;
  resourceOwnerId: string;
  attempts: number;
  maxAttempts: number;
  error: ReturnType<typeof safeError> | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

function status(row: Selectable<Database['operation_jobs']>): JobStatus {
  return {
    id: row.id,
    state: row.state,
    messageKey: `jobs.${row.state}`,
    actorId: row.actor_id,
    subjectId: row.subject_id,
    resourceOwnerId: row.resource_owner_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    error: row.error_code
      ? safeError(
          new DomainError(
            (domainErrorCodes as readonly string[]).includes(row.error_code)
              ? (row.error_code as DomainErrorCode)
              : 'internal_error',
          ),
        )
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export async function enqueueCommand(
  db: Kysely<Database>,
  input: EnqueueCommandInput,
): Promise<JobStatus> {
  assertPermission(input.context, 'jobs:read', { ownerUserId: input.resourceOwnerId });
  const parsed = z
    .object({
      idempotencyKey: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-zA-Z0-9_-]+$/),
      resourceOwnerId: z.string().min(1).max(128),
      maxAttempts: z.number().int().min(1).max(10),
    })
    .safeParse({ ...input, maxAttempts: input.maxAttempts ?? 3 });
  if (!parsed.success) throw new DomainError('validation_failed');
  const command = parseCommand(input.command);
  const digest = commandDigest({
    command,
    subjectId: input.context.subjectUserId,
    resourceOwnerId: input.resourceOwnerId,
  });
  return db.transaction().execute(async (tx) => {
    const inserted = await tx
      .insertInto('operation_jobs')
      .values({
        id: randomUUID(),
        actor_id: input.context.actorUserId,
        subject_id: input.context.subjectUserId,
        resource_owner_id: input.resourceOwnerId,
        support_session_id: input.context.support?.id ?? null,
        idempotency_key: parsed.data.idempotencyKey,
        command_hash: digest,
        command: JSON.stringify(command),
        policy_snapshot: JSON.stringify({
          role: input.context.role,
          sessionType: input.context.sessionType,
          ownerElevation: input.context.ownerElevation,
        }),
        max_attempts: parsed.data.maxAttempts,
        error_code: null,
        completed_at: null,
      })
      .onConflict((conflict) => conflict.columns(['actor_id', 'idempotency_key']).doNothing())
      .returningAll()
      .executeTakeFirst();
    const row =
      inserted ??
      (await tx
        .selectFrom('operation_jobs')
        .selectAll()
        .where('actor_id', '=', input.context.actorUserId)
        .where('idempotency_key', '=', parsed.data.idempotencyKey)
        .executeTakeFirstOrThrow());
    if (row.command_hash !== digest || row.max_attempts !== parsed.data.maxAttempts)
      throw new DomainError('conflict');
    if (inserted)
      await tx
        .insertInto('job_outbox')
        .values({ job_id: row.id, last_dispatched_at: null })
        .execute();
    return status(row);
  });
}

export async function getJobStatus(
  db: Kysely<Database>,
  jobId: string,
  context: AuthContext,
): Promise<JobStatus> {
  if (!z.uuid().safeParse(jobId).success) throw new DomainError('validation_failed');
  const row = await db
    .selectFrom('operation_jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirst();
  if (!row) throw new DomainError('not_found');
  assertPermission(context, 'jobs:read', { ownerUserId: row.resource_owner_id });
  return status(row);
}

export interface HandlerContext {
  /** Handlers must perform DB-only work using this transaction, never external effects. */
  tx: Transaction<Database>;
  job: Selectable<Database['operation_jobs']>;
  command: JobCommand;
}
export type JobHandler = (context: HandlerContext) => Promise<void>;
export type JobHandlers = Readonly<Record<JobCommand['type'], JobHandler>>;

export const foundationHandlers: JobHandlers = {
  'foundation.record-activity': async ({ tx, job, command }) => {
    await tx
      .insertInto('activity_events')
      .values({
        id: randomUUID(),
        job_id: job.id,
        actor_id: job.actor_id,
        subject_id: job.subject_id,
        resource_owner_id: job.resource_owner_id,
        message_key: 'activity.foundation.recorded',
        parameters: JSON.stringify({ source: command.payload.source }),
      })
      .execute();
  },
};

/** The row lock serializes duplicates; handler writes + step + completion commit together. */
export async function processJob(
  db: Kysely<Database>,
  jobId: string,
  handlers: JobHandlers = foundationHandlers,
): Promise<'succeeded' | 'failed' | 'retry' | 'deferred' | 'duplicate' | 'missing'> {
  if (!z.uuid().safeParse(jobId).success) throw new DomainError('validation_failed');
  return db.transaction().execute(async (tx) => {
    const job = await tx
      .selectFrom('operation_jobs')
      .selectAll()
      .where('id', '=', jobId)
      .forUpdate()
      .executeTakeFirst();
    if (!job) return 'missing';
    if (job.state === 'succeeded' || job.state === 'failed') return 'duplicate';
    const { now } = await tx
      .selectNoFrom(sql<Date>`clock_timestamp()`.as('now'))
      .executeTakeFirstOrThrow();
    if (job.next_attempt_at > now) return 'deferred';
    const attempt = job.attempts + 1;
    await tx
      .updateTable('operation_jobs')
      .set({ state: 'running', attempts: attempt, updated_at: now })
      .where('id', '=', jobId)
      .execute();
    await sql`savepoint job_attempt`.execute(tx);
    try {
      const command = parseCommand(job.command);
      await handlers[command.type]({ tx, job, command });
      await tx
        .insertInto('job_steps')
        .values({ job_id: jobId, step: `${command.type}.v${command.version}` })
        .execute();
      await tx
        .updateTable('operation_jobs')
        .set({ state: 'succeeded', error_code: null, completed_at: now, updated_at: now })
        .where('id', '=', jobId)
        .execute();
      await tx.deleteFrom('job_outbox').where('job_id', '=', jobId).execute();
      await sql`release savepoint job_attempt`.execute(tx);
      return 'succeeded';
    } catch (error) {
      await sql`rollback to savepoint job_attempt`.execute(tx);
      const terminal =
        attempt >= job.max_attempts ||
        (error instanceof DomainError && error.code === 'validation_failed');
      const next = new Date(now.getTime() + retryDelayMs(attempt));
      await tx
        .updateTable('operation_jobs')
        .set({
          state: terminal ? 'failed' : 'queued',
          error_code: safeError(error).code,
          next_attempt_at: next,
          completed_at: terminal ? now : null,
          updated_at: now,
        })
        .where('id', '=', jobId)
        .execute();
      if (terminal) await tx.deleteFrom('job_outbox').where('job_id', '=', jobId).execute();
      else
        await tx
          .updateTable('job_outbox')
          .set({ next_dispatch_at: next })
          .where('job_id', '=', jobId)
          .execute();
      await sql`release savepoint job_attempt`.execute(tx);
      return terminal ? 'failed' : 'retry';
    }
  });
}
