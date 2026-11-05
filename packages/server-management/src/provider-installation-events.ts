import { DomainError } from '@nickhosting/core';
import { type Database, notifyJobOutbox } from '@nickhosting/database';
import { providerInstallationEventSchema } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';

async function wakeLocked(tx: Kysely<Database>, jobId: string, now: Date) {
  const job = await tx
    .selectFrom('operation_jobs')
    .select('state')
    .where('id', '=', jobId)
    .forUpdate()
    .executeTakeFirst();
  if (!job || !['queued', 'running'].includes(job.state)) return;
  await tx
    .updateTable('operation_jobs')
    .set({ next_attempt_at: now })
    .where('id', '=', jobId)
    .execute();
  await tx
    .insertInto('job_outbox')
    .values({ job_id: jobId, next_dispatch_at: now, last_dispatched_at: null })
    .onConflict((c) =>
      c.column('job_id').doUpdateSet({
        generation: sql`job_outbox.generation + 1`,
        next_dispatch_at: now,
        last_dispatched_at: null,
      }),
    )
    .execute();
  await notifyJobOutbox(tx);
}
export async function wakeInstallationOperation(
  db: Kysely<Database>,
  jobId: string,
  now = new Date(),
) {
  await db.transaction().execute((tx) => wakeLocked(tx, jobId, now));
}

/** Signed provider receipts only expedite reconciliation; they never mark an
 * installation successful or release its physical resource reservation. */
export async function applyProviderInstallationEvent(
  db: Kysely<Database>,
  input: unknown,
  now = new Date(),
) {
  const event = providerInstallationEventSchema.parse(input);
  if (Date.parse(event.occurredAt) > now.getTime() + 60_000)
    throw new DomainError('validation_failed');
  const server = await db
    .selectFrom('managed_servers as s')
    .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
    .innerJoin('provider_server_projections as p', 'p.server_id', 's.id')
    .innerJoin('provider_change_feeds as f', 'f.instance_id', 'p.instance_id')
    .select([
      's.id',
      's.active_operation_id',
      's.pterodactyl_id',
      's.pterodactyl_uuid',
      's.pterodactyl_identifier',
      's.external_id',
      's.deleted_at',
      'n.pterodactyl_node_id',
      'p.identity_invalidated',
      'f.enabled',
    ])
    .where('p.instance_id', '=', event.instanceId)
    .where('s.pterodactyl_uuid', '=', event.server.providerUuid)
    .executeTakeFirst();
  if (
    !server?.enabled ||
    server.identity_invalidated ||
    server.deleted_at ||
    server.pterodactyl_id !== event.server.providerId ||
    server.pterodactyl_identifier !== event.server.identifier ||
    server.external_id !== event.server.externalId ||
    server.pterodactyl_node_id !== event.server.nodeId
  )
    throw new DomainError('provenance_mismatch');
  if (!server.active_operation_id) return;
  const operation = await db
    .selectFrom('server_operations')
    .select(['job_id', 'action', 'effect_started_at'])
    .where('job_id', '=', server.active_operation_id)
    .executeTakeFirst();
  if (
    !operation ||
    !['provision', 'reinstall'].includes(operation.action) ||
    !operation.effect_started_at ||
    Date.parse(event.occurredAt) < Math.floor(operation.effect_started_at.getTime() / 1000) * 1000
  )
    return;
  await db.transaction().execute(async (tx) => {
    await tx
      .selectFrom('operation_jobs')
      .select('id')
      .where('id', '=', operation.job_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const duplicate = await tx
      .selectFrom('server_events')
      .select('id')
      .where('job_id', '=', operation.job_id)
      .where('message_key', '=', 'servers.operation.installation_updated')
      .where(sql<string>`data->>'eventId'`, '=', event.eventId)
      .executeTakeFirst();
    if (duplicate) return false;
    await tx
      .insertInto('server_events')
      .values({
        server_id: server.id,
        job_id: operation.job_id,
        actor_id: null,
        subject_id: null,
        support_session_id: null,
        message_key: 'servers.operation.installation_updated',
        data: JSON.stringify({
          eventId: event.eventId,
          state: event.installation.state,
          occurredAt: event.occurredAt,
        }),
      })
      .execute();
    await wakeLocked(tx, operation.job_id, now);
  });
}

/** Only the worker's authenticated live installation channel calls this. A Panel
 * status receipt is deliberately not convertible into this terminal evidence. */
export async function recordNativeInstallationCompletion(
  db: Kysely<Database>,
  input: {
    serverId: string;
    jobId: string;
    providerUuid: string;
    observedAt: Date;
    effectStartedAt?: Date;
  },
) {
  return db.transaction().execute(async (tx) => {
    const operation = await tx
      .selectFrom('server_operations as o')
      .innerJoin('operation_jobs as j', 'j.id', 'o.job_id')
      .innerJoin('managed_servers as s', 's.id', 'o.server_id')
      .select(['o.effect_started_at', 'o.phase', 'o.plan', 'o.action', 'j.state'])
      .where('o.job_id', '=', input.jobId)
      .where('s.id', '=', input.serverId)
      .where('s.active_operation_id', '=', input.jobId)
      .where('s.pterodactyl_uuid', '=', input.providerUuid)
      .where('s.deleted_at', 'is', null)
      .forUpdate('o')
      .executeTakeFirst();
    if (
      !operation ||
      !['queued', 'running'].includes(operation.state) ||
      !['provision', 'reinstall'].includes(operation.action) ||
      (!['provision', 'installation', 'reinstall'].includes(operation.phase) &&
        !/^installation_retry:[1-5]$/.test(operation.phase)) ||
      operation.plan.modpackOperationId ||
      operation.plan.installConfirmed ||
      !operation.effect_started_at ||
      (input.effectStartedAt !== undefined &&
        operation.effect_started_at.getTime() !== input.effectStartedAt.getTime()) ||
      operation.effect_started_at > input.observedAt
    )
      return false;
    const effectStartedAt = operation.effect_started_at.toISOString();
    const duplicate = await tx
      .selectFrom('server_events')
      .select('id')
      .where('job_id', '=', input.jobId)
      .where('message_key', '=', 'servers.operation.installation_updated')
      .where(sql<string>`data->>'source'`, '=', 'native_installation_completed')
      .where(sql<string>`data->>'effectStartedAt'`, '=', effectStartedAt)
      .executeTakeFirst();
    if (duplicate) return true;
    await tx
      .insertInto('server_events')
      .values({
        server_id: input.serverId,
        job_id: input.jobId,
        actor_id: null,
        subject_id: null,
        support_session_id: null,
        message_key: 'servers.operation.installation_updated',
        data: JSON.stringify({
          source: 'native_installation_completed',
          state: 'completed',
          providerUuid: input.providerUuid,
          effectStartedAt,
          occurredAt: input.observedAt.toISOString(),
        }),
      })
      .execute();
    return true;
  });
}
