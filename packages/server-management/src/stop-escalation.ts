import { randomUUID } from 'node:crypto';
import { type AuthContext, authSessionId, DomainError } from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources } from './admission.js';
import { currentInteractiveContext } from './interactive-context.js';

export const killRequestSchema = z
  .object({
    action: z.literal('kill'),
    confirm: z.literal(true),
    operationId: z.uuid(),
    idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  })
  .strict();
const receiptSchema = z.object({
  key: z.string(),
  actorId: z.string(),
  subjectId: z.string(),
  sessionId: z.string(),
  supportId: z.string().nullable(),
  state: z.enum(['requested', 'prepared', 'confirmed', 'rejected', 'unknown']),
});
type Receipt = z.infer<typeof receiptSchema>;
export function hasStopProcessBaseline(plan: Record<string, unknown>) {
  return (
    typeof plan.stopProcessStartedAt === 'string' &&
    Number.isFinite(Date.parse(plan.stopProcessStartedAt))
  );
}
export function stopEscalation(snapshot: Record<string, unknown>) {
  return receiptSchema.safeParse(snapshot.stopEscalation).data;
}
async function caller(db: Kysely<Database>, receipt: Receipt, env: Environment) {
  const context: AuthContext = {
    actorUserId: receipt.actorId,
    subjectUserId: receipt.subjectId,
    role: 'user',
    sessionType: receipt.supportId ? 'support' : 'regular',
    ownerElevation: !!receipt.supportId,
    [authSessionId]: receipt.sessionId,
    ...(receipt.supportId ? { support: { id: receipt.supportId } as AuthContext['support'] } : {}),
  };
  return currentInteractiveContext(db, context, env);
}
/** Queue an escalation on the exact active stop, without waiting for its server lock. */
export async function requestStopEscalation(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  input: unknown,
  env: Environment,
) {
  const { authorizeServer, parse } = await import('./registry.js');
  const value = parse(killRequestSchema, input);
  await authorizeServer(
    db,
    await currentInteractiveContext(db, context, env),
    serverId,
    'server:operate',
  );
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const job = await tx
      .selectFrom('operation_jobs')
      .selectAll()
      .where('id', '=', value.operationId)
      .forUpdate()
      .executeTakeFirst();
    if (!job) throw new DomainError('conflict');
    const actor = await currentInteractiveContext(tx, context, env);
    const server = await authorizeServer(tx, actor, serverId, 'server:operate');
    const operation = await tx
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', job.id)
      .executeTakeFirst();
    if (operation?.server_id !== serverId || operation.action !== 'stop')
      throw new DomainError('conflict');
    const old = stopEscalation(job.policy_snapshot);
    const history = z
      .array(receiptSchema)
      .catch([])
      .parse(job.policy_snapshot.stopEscalationHistory ?? []);
    const replay = [...history, ...(old ? [old] : [])].find(
      (entry) => entry.key === value.idempotencyKey && entry.actorId === actor.actorUserId,
    );
    if (replay) {
      if (replay.subjectId !== actor.subjectUserId) throw new DomainError('conflict');
      return { serverId, jobId: job.id };
    }
    if (old && old.state !== 'rejected') throw new DomainError('conflict');
    if (
      server.active_operation_id !== job.id ||
      operation.phase !== 'power' ||
      !hasStopProcessBaseline(operation.plan) ||
      !operation.effect_started_at ||
      job.state === 'succeeded' ||
      job.state === 'failed'
    )
      throw new DomainError('conflict');
    const receipt: Receipt = {
      key: value.idempotencyKey,
      actorId: actor.actorUserId,
      subjectId: actor.subjectUserId,
      sessionId: actor[authSessionId] ?? '',
      supportId: actor.support?.id ?? null,
      state: 'requested',
    };
    await tx
      .updateTable('operation_jobs')
      .set({
        policy_snapshot: JSON.stringify({
          ...job.policy_snapshot,
          stopEscalation: receipt,
          stopEscalationHistory: old ? [...history, old] : history,
        }),
      })
      .where('id', '=', job.id)
      .execute();
    // Manual force-stop withdraws wake consent, including an automatic idle stop.
    await tx
      .updateTable('managed_servers')
      .set({ intent: 'manually_stopped' })
      .where('id', '=', serverId)
      .execute();
    await tx
      .updateTable('gateway_server_states')
      .set({
        generation: randomUUID(),
        state: 'manually_stopped',
        idle_since: null,
        readiness_observed_at: null,
        updated_at: new Date(),
      })
      .where('server_id', '=', serverId)
      .execute();
    await recordAudit(tx, actor, 'server.stop.escalation.requested', { serverId, jobId: job.id });
    return { serverId, jobId: job.id };
  });
}
/** Called only under lifecycle's pinned server lock. Prepared effects are never replayed. */
export async function consumeStopEscalation(
  db: Kysely<Database>,
  serverId: string,
  jobId: string,
  env: Environment,
  hooks: { verify: () => Promise<boolean>; power: () => Promise<void> },
) {
  const { authorizeServer } = await import('./registry.js');
  const job = await db
    .selectFrom('operation_jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirstOrThrow();
  const receipt = stopEscalation(job.policy_snapshot);
  if (receipt?.state !== 'requested') return;
  const save = async (state: Receipt['state']) => {
    await db
      .updateTable('operation_jobs')
      .set({
        policy_snapshot: JSON.stringify({
          ...job.policy_snapshot,
          stopEscalation: { ...receipt, state },
        }),
      })
      .where('id', '=', jobId)
      .execute();
  };
  let dispatched = false;
  try {
    await authorizeServer(db, await caller(db, receipt, env), serverId, 'server:operate');
    if (!(await hooks.verify())) {
      await save('rejected');
      return;
    }
    const actor = await caller(db, receipt, env);
    const server = await authorizeServer(db, actor, serverId, 'server:operate');
    if (server.active_operation_id !== jobId) throw new DomainError('conflict');
    await save('prepared');
    await authorizeServer(db, await caller(db, receipt, env), serverId, 'server:operate');
    // Consent writes and session checks may wait. Revalidate immediately at handoff.
    if (!(await hooks.verify())) {
      await save('rejected');
      return;
    }
    const finalActor = await caller(db, receipt, env);
    const finalServer = await authorizeServer(db, finalActor, serverId, 'server:operate');
    if (finalServer.active_operation_id !== jobId) throw new DomainError('conflict');
    dispatched = true;
    await hooks.power();
    await save('confirmed');
    await recordAudit(db, actor, 'server.stop.escalation.dispatched', { serverId, jobId });
  } catch {
    await save(dispatched ? 'unknown' : 'rejected');
    await db
      .insertInto('server_events')
      .values({
        server_id: serverId,
        job_id: jobId,
        actor_id: receipt.actorId,
        subject_id: receipt.subjectId,
        support_session_id: receipt.supportId,
        message_key: 'servers.operation.kill_unconfirmed',
        data: '{}',
      })
      .execute();
  }
}
