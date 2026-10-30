import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '@nickhosting/core';
import { type Database, notifyJobOutbox } from '@nickhosting/database';
import {
  type ProviderBackupEvent,
  providerBackupEventSchema,
} from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';

const schemaChecks = new WeakMap<object, { expires: number; result: Promise<boolean> }>();
/** Source HMR may precede the explicit migration. Cache discovery once per runtime,
 * never make unrelated Files/Console unavailable during that deployment interval. */
export function backupSchemaAvailable(db: Kysely<Database>): Promise<boolean> {
  const previous = schemaChecks.get(db);
  if (previous && previous.expires > Date.now()) return previous.result;
  const entry = { expires: Date.now() + 5000, result: Promise.resolve(false) };
  entry.result = sql<{
    present: boolean;
  }>`select to_regclass(current_schema() || '.provider_backup_events') is not null as present`
    .execute(db)
    .then((result) => {
      const present = result.rows[0]?.present === true;
      if (present) entry.expires = Infinity;
      return present;
    });
  schemaChecks.set(db, entry);
  return entry.result;
}

/** Only authenticated, committed provider events enter here. No remote calls or server imports. */
export async function applyProviderBackupEvent(
  db: Kysely<Database>,
  value: unknown,
  now = new Date(),
) {
  const event = providerBackupEventSchema.parse(value);
  if (
    Date.parse(event.occurredAt) > now.getTime() + 60_000 ||
    Date.parse(event.backup.completedAt) > now.getTime() + 60_000
  )
    throw new DomainError('validation_failed');
  return db.transaction().execute(async (tx) => {
    const link = await tx
      .selectFrom('provider_server_projections as p')
      .innerJoin('provider_change_feeds as f', 'f.instance_id', 'p.instance_id')
      .innerJoin('managed_servers as s', 's.id', 'p.server_id')
      .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
      .select([
        's.id',
        's.pterodactyl_id',
        's.pterodactyl_uuid',
        's.pterodactyl_identifier',
        's.external_id',
        's.active_operation_id',
        's.deleted_at',
        'n.pterodactyl_node_id',
        'p.identity_invalidated',
        'p.payload',
        'f.enabled',
      ])
      .where('p.instance_id', '=', event.instanceId)
      .where('s.pterodactyl_uuid', '=', event.server.providerUuid)
      .executeTakeFirst();
    if (
      !link?.enabled ||
      link.identity_invalidated ||
      link.deleted_at ||
      link.pterodactyl_id !== event.server.providerId ||
      link.pterodactyl_identifier !== event.server.identifier ||
      link.external_id !== event.server.externalId ||
      link.pterodactyl_node_id !== event.server.nodeId ||
      !isDeepStrictEqual((link.payload as { server?: unknown }).server, event.server)
    )
      throw new DomainError('provenance_mismatch');
    // Serialize with the worker's waiting transition, not its network/server lock.
    const job = link.active_operation_id
      ? await tx
          .selectFrom('operation_jobs')
          .select(['id', 'state'])
          .where('id', '=', link.active_operation_id)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    const inserted = await tx
      .insertInto('provider_backup_events')
      .values({
        event_id: event.eventId,
        instance_id: event.instanceId,
        server_id: link.id,
        backup_id: event.backup.uuid,
        type: event.type,
        occurred_at: new Date(event.occurredAt),
        payload: event,
      })
      .onConflict((c) => c.column('event_id').doNothing())
      .returning('event_id')
      .executeTakeFirst();
    if (!inserted) {
      const existing = await tx
        .selectFrom('provider_backup_events')
        .select('payload')
        .where('event_id', '=', event.eventId)
        .executeTakeFirstOrThrow();
      if (!isDeepStrictEqual(existing.payload, event)) throw new DomainError('conflict');
      return 'duplicate' as const;
    }
    if (job && ['queued', 'running'].includes(job.state)) {
      const operation = await tx
        .selectFrom('server_operations')
        .select(['plan', 'effect_started_at'])
        .where('job_id', '=', job.id)
        .executeTakeFirst();
      const target =
        event.type === 'backup.completed'
          ? operation?.plan.backupId
          : (operation?.plan.restoreBackupId ?? operation?.plan.backupId);
      if (
        operation &&
        (target === event.backup.uuid ||
          (event.type === 'backup.completed' &&
            event.backup.name === `nickhosting-operation-${job.id}`))
      ) {
        await tx
          .updateTable('operation_jobs')
          .set({ next_attempt_at: now })
          .where('id', '=', job.id)
          .execute();
        await tx
          .insertInto('job_outbox')
          .values({ job_id: job.id, last_dispatched_at: null, next_dispatch_at: now })
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
    }
    return 'applied' as const;
  });
}

export async function readProviderBackupCompletion(
  db: Kysely<Database>,
  serverId: string,
  backupId: string,
  type: ProviderBackupEvent['type'],
  since?: Date,
): Promise<ProviderBackupEvent | null> {
  if (!(await backupSchemaAvailable(db))) return null;
  let query = db
    .selectFrom('provider_backup_events')
    .select('payload')
    .where('server_id', '=', serverId)
    .where('backup_id', '=', backupId)
    .where('type', '=', type);
  if (since) query = query.where('occurred_at', '>=', since);
  const row = await query
    .orderBy('occurred_at', 'desc')
    .orderBy('received_at', 'desc')
    .executeTakeFirst();
  return row ? providerBackupEventSchema.parse(row.payload) : null;
}

export async function providerBackupEventsEnabled(
  db: Kysely<Database>,
  serverId: string,
): Promise<boolean> {
  if (!(await backupSchemaAvailable(db))) return false;
  const row = await db
    .selectFrom('provider_server_projections as p')
    .innerJoin('provider_change_feeds as f', 'f.instance_id', 'p.instance_id')
    .select('f.backup_events')
    .where('p.server_id', '=', serverId)
    .where('p.identity_invalidated', '=', false)
    .where('f.enabled', '=', true)
    .executeTakeFirst();
  return row?.backup_events === true;
}
