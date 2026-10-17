import { createHash, randomUUID } from 'node:crypto';
import { type AuthContext, authSessionId, DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { type Kysely, type Selectable, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { lockResources } from './admission.js';
import { parse } from './registry.js';
import { uploadMultipartAllowanceBytes } from './upload-policy.js';
import { createUploadTiming, type UploadTiming } from './upload-timing.js';

type Claim = Selectable<Database['upload_ingestion_claims']>;
type Batch = NonNullable<Claim['scope']['batch']>;
export type UploadBatchFile = Omit<Batch['files'][number], 'state' | 'auditOutcome'>;
export const uploadBatchMaxFiles = 500;
const fileSchema = z.strictObject({
  id: z.string().min(1).max(128),
  path: z
    .string()
    .min(2)
    .max(4096)
    .refine(
      (value) =>
        value.startsWith('/') &&
        [...value].every((character) => {
          const code = character.charCodeAt(0);
          return code >= 32 && code !== 127 && code !== 92;
        }) &&
        value
          .slice(1)
          .split('/')
          .every((part) => part && part !== '.' && part !== '..'),
    ),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  overwrite: z.boolean(),
});
const bindingSchema = z.string().regex(/^[a-f0-9]{64}$/);

function lockKey(id: string) {
  return `:nickhosting:upload:${id}`;
}
function checkBinding(claim: Claim, context: AuthContext, serverId: string, bindingHash: string) {
  const batch = claim.scope.batch;
  if (
    !batch ||
    claim.server_id !== serverId ||
    claim.actor_user_id !== context.actorUserId ||
    batch.actorUserId !== context.actorUserId ||
    batch.subjectUserId !== context.subjectUserId ||
    !context[authSessionId] ||
    batch.sessionId !== context[authSessionId] ||
    batch.bindingHash !== bindingHash
  )
    throw new DomainError('conflict');
  return batch;
}
function view(claim: Claim, closed: boolean) {
  const batch = claim.scope.batch;
  if (!batch) throw new DomainError('conflict');
  return {
    id: claim.id,
    files: batch.files,
    concurrency: batch.concurrency,
    manifestHash: batch.manifestHash,
    rejected: batch.rejected ?? [],
    closed,
  };
}
/** Bounded activity detail; session/binding hashes and upload contents never leave the claim. */
function batchActivity(claim: Claim, closed: boolean, entryId?: string) {
  const batch = claim.scope.batch;
  if (!batch) throw new DomainError('conflict');
  const completed = batch.files.filter((file) => file.state === 'complete').length;
  const cancelled = batch.files.filter(
    (file) => file.state === 'cancelled' && file.auditOutcome !== 'failed',
  ).length;
  const uncertain = batch.files.filter((file) => file.state === 'uncertain').length;
  const rejected = batch.rejected?.length ?? 0;
  const failed = rejected + batch.files.filter((file) => file.auditOutcome === 'failed').length;
  const outcome =
    uncertain > 0
      ? completed > 0
        ? 'partial'
        : 'uncertain'
      : !closed
        ? 'requested'
        : completed === batch.files.length && failed === 0
          ? 'succeeded'
          : completed > 0
            ? 'partial'
            : cancelled > 0
              ? 'cancelled'
              : 'failed';
  const details = (file: Batch['files'][number]) => ({
    id: file.id,
    path: file.path,
    state: file.auditOutcome ?? file.state,
    bytes: file.bytes,
  });
  const entry = batch.files.find((file) => file.id === entryId);
  return {
    claimId: claim.id,
    operationId: claim.id,
    batchId: claim.id,
    serverId: claim.server_id,
    source: 'panel',
    action: 'upload',
    closed,
    count: batch.files.length + rejected,
    completed,
    cancelled,
    uncertain,
    failed,
    outcome,
    // Intermediate settlements keep only the changed entry, avoiding repeated manifests.
    ...(closed || entryId === undefined ? { entries: batch.files.slice(0, 100).map(details) } : {}),
    ...(entry ? { entry: details(entry), path: entry.path } : {}),
  };
}
async function recordBatchAudit(
  tx: Transaction<Database>,
  context: AuthContext,
  events: Array<{ action: string; metadata: Record<string, unknown> }>,
) {
  // now() is transaction start, which can precede waiting on the claim lock.
  // Timestamp this locked snapshot at insertion so later serialized snapshots win.
  await tx
    .insertInto('audit_events')
    .values(
      events.map((event) => ({
        id: randomUUID(),
        actor_user_id: context.actorUserId,
        subject_user_id: context.subjectUserId,
        correlation_id: context.support?.id ?? randomUUID(),
        created_at: sql<Date>`clock_timestamp()`,
        ...event,
      })),
    )
    .execute();
}
type TimingPhase = 'admission' | 'settlement' | 'settlementRelease';
async function persist(
  tx: Transaction<Database>,
  claim: Claim,
  releaseFinished = true,
  trace?: UploadTiming,
  phase: TimingPhase = 'settlement',
) {
  const timing = trace ?? createUploadTiming(false);
  const batch = claim.scope.batch;
  if (!batch) throw new DomainError('conflict');
  const closed =
    releaseFinished &&
    batch.files.every((file) => file.state === 'complete' || file.state === 'cancelled');
  if (closed) {
    await timing.measure(`${phase}.deleteClaim`, () =>
      tx.deleteFrom('upload_ingestion_claims').where('id', '=', claim.id).execute(),
    );
  } else {
    const serialized = timing.measureSync(`${phase}.serializeHash`, () => {
      const scope = JSON.stringify(claim.scope);
      return { scope, scope_hash: createHash('sha256').update(scope).digest('hex') };
    });
    await timing.measure(`${phase}.updateClaim`, () =>
      tx
        .updateTable('upload_ingestion_claims')
        .set(serialized)
        .where('id', '=', claim.id)
        .execute(),
    );
  }
  return view(claim, closed);
}
async function mutate(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  batchId: string,
  bindingHash: string,
  action: string,
  change: (batch: Batch) => void,
  trace?: UploadTiming,
  phase: TimingPhase = 'settlement',
  lockMode: 'global' | 'claim' = 'global',
  uploadedBytes?: number,
  entryId?: string,
) {
  const timing = trace ?? createUploadTiming(false);
  const needsGlobalRelease = Symbol('upload batch final release');
  async function attempt(global: boolean, step: TimingPhase) {
    // Entry includes driver acquisition and BEGIN up to callback entry; the caller
    // already pins its connection, so this is not a pure connection-pool metric.
    const entered = timing.start(`${step}.transactionEntry`);
    let tail = () => {};
    try {
      return await db.transaction().execute(async (tx) => {
        entered();
        const body = timing.start(`${step}.transactionBody`);
        try {
          if (global) await timing.measure(`${step}.resourceLock`, () => lockResources(tx));
          const claim = await timing.measure(`${step}.selectForUpdate`, () =>
            tx
              .selectFrom('upload_ingestion_claims')
              .selectAll()
              .where('id', '=', batchId)
              .forUpdate()
              .executeTakeFirst(),
          );
          if (!claim) throw new DomainError('conflict');
          timing.measureSync(`${step}.validateTransition`, () => {
            const batch = checkBinding(claim, context, serverId, bindingHash);
            change(batch);
            // Intermediate states do not change the reserved capacity. Final
            // deletion must serialize with statfs + outstanding-reservation reads.
            // Roll back before taking the global lock: never invert global→row.
            if (
              !global &&
              batch.files.every((file) => file.state === 'complete' || file.state === 'cancelled')
            )
              throw needsGlobalRelease;
          });
          const result = await persist(tx, claim, true, timing, step);
          await timing.measure(`${step}.audit`, async () => {
            const metadata = batchActivity(claim, result.closed, entryId);
            // Keep both events atomic with claim settlement in the existing single INSERT.
            await recordBatchAudit(tx, context, [
              { action, metadata },
              ...(uploadedBytes === undefined
                ? []
                : [
                    {
                      action: 'server.files.uploaded',
                      metadata: { ...metadata, bytes: uploadedBytes },
                    },
                  ]),
            ]);
          });
          return result;
        } finally {
          body();
          // Includes COMMIT or ROLLBACK and driver release; never label a failed
          // transaction's rollback as a successful commit.
          tail = timing.start(`${step}.transactionTail`);
        }
      });
    } finally {
      entered();
      tail();
    }
  }
  try {
    return await attempt(lockMode === 'global', phase);
  } catch (error) {
    if (error !== needsGlobalRelease) throw error;
    // Re-read and revalidate once in a fresh transaction. No file effect or
    // database mutation occurred during the rolled-back decision attempt.
    return attempt(true, 'settlementRelease');
  }
}

/** Called once after path/quota preflight while the reservation's exclusive lock is held.
 * The full conservative reservation stays charged until every entry is terminal. */
export async function createUploadBatch(
  connection: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  claimId: string,
  input: {
    bindingHash: string;
    manifestHash?: string;
    rejected?: Array<{ id: string; code: 'file_exists' | 'conflict' }>;
    concurrency: number;
    files: UploadBatchFile[];
  },
) {
  const value = parse(
    z.strictObject({
      bindingHash: bindingSchema,
      manifestHash: bindingSchema.optional(),
      rejected: z
        .array(
          z.strictObject({
            id: z.string().min(1).max(128),
            code: z.enum(['file_exists', 'conflict']),
          }),
        )
        .max(uploadBatchMaxFiles)
        .optional(),
      concurrency: z.number().int().min(1).max(6),
      files: z.array(fileSchema).min(1).max(uploadBatchMaxFiles),
    }),
    input,
  );
  const sessionId = context[authSessionId];
  if (!sessionId) throw new DomainError('unauthenticated');
  const total = value.files.reduce((sum, file) => sum + file.bytes, 0);
  const paths = new Set(value.files.map((file) => file.path));
  if (
    !Number.isSafeInteger(total) ||
    value.files.length + (value.rejected?.length ?? 0) > uploadBatchMaxFiles ||
    paths.size !== value.files.length ||
    new Set(value.files.map((file) => file.id)).size !== value.files.length ||
    new Set([...value.files, ...(value.rejected ?? [])].map((file) => file.id)).size !==
      value.files.length + (value.rejected?.length ?? 0) ||
    value.files.some((file) => {
      const parts = file.path.split('/');
      return parts.slice(1, -1).some((_, index) => paths.has(parts.slice(0, index + 2).join('/')));
    })
  )
    throw new DomainError('validation_failed');
  return connection.transaction().execute(async (tx) => {
    await lockResources(tx);
    const claim = await tx
      .selectFrom('upload_ingestion_claims')
      .selectAll()
      .where('id', '=', claimId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !claim ||
      claim.scope.batch ||
      claim.server_id !== serverId ||
      claim.actor_user_id !== context.actorUserId ||
      BigInt(claim.declared_bytes) !== BigInt(total) ||
      BigInt(claim.reserved_bytes) <
        2n * BigInt(total) +
          BigInt(uploadMultipartAllowanceBytes * Math.min(value.concurrency, value.files.length)) ||
      value.files.some((file) => file.bytes > claim.scope.policy.providerMaxFileBytes)
    )
      throw new DomainError('conflict');
    claim.scope.batch = {
      actorUserId: context.actorUserId,
      subjectUserId: context.subjectUserId,
      sessionId,
      bindingHash: value.bindingHash,
      manifestHash: value.manifestHash,
      rejected: value.rejected,
      concurrency: value.concurrency,
      files: value.files.map((file) => ({ ...file, state: 'queued' })),
    };
    const result = await persist(tx, claim, false);
    await recordBatchAudit(tx, context, [
      {
        action: 'server.upload.batch_prepared',
        metadata: {
          ...batchActivity(claim, false),
          files: value.files.length,
          declaredBytes: total,
          concurrency: value.concurrency,
        },
      },
    ]);
    return result;
  });
}

/** The caller pins this connection and keeps its shared server lifecycle lock.
 * A shared claim lock excludes Owner recovery until the transfer has finished. */
export async function claimUploadBatchEntry(
  connection: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  batchId: string,
  input: UploadBatchFile & { bindingHash: string },
  trace?: UploadTiming,
) {
  const timing = trace ?? createUploadTiming(false);
  const value = timing.measureSync('admission.validateInput', () =>
    parse(fileSchema.extend({ bindingHash: bindingSchema }), input),
  );
  const result = await timing.measure('admission.claimLock', () =>
    sql<{
      acquired: boolean;
    }>`select pg_try_advisory_lock_shared(hashtextextended(current_schema() || ${lockKey(batchId)},0)) as acquired`.execute(
      connection,
    ),
  );
  if (!result.rows[0]?.acquired) throw new DomainError('conflict');
  let unlocked = false;
  let pendingFiles: Array<{ id: string; path: string }> = [];
  async function unlock() {
    if (unlocked) return;
    unlocked = true;
    await timing.measure('release.claimUnlock', () =>
      sql`select pg_advisory_unlock_shared(hashtextextended(current_schema() || ${lockKey(batchId)},0))`.execute(
        connection,
      ),
    );
  }
  try {
    await mutate(
      connection,
      context,
      serverId,
      batchId,
      value.bindingHash,
      'server.upload.started',
      (batch) => {
        const file = batch.files.find((file) => file.id === value.id);
        if (
          file?.state !== 'queued' ||
          file.path !== value.path ||
          file.bytes !== value.bytes ||
          file.overwrite !== value.overwrite
        )
          throw new DomainError('conflict');
        if (
          batch.files.filter((file) => file.state === 'active' || file.state === 'uncertain')
            .length >= batch.concurrency
        )
          throw new DomainError('operation_busy');
        file.state = 'active';
        pendingFiles = batch.files
          .filter((entry) => entry.state === 'queued' || entry.state === 'active')
          .map(({ id, path }) => ({ id, path }));
      },
      timing,
      'admission',
      'claim',
      undefined,
      value.id,
    );
  } catch (error) {
    await unlock();
    throw error;
  }
  let settled = false;
  async function settle(state: 'complete' | 'cancelled' | 'uncertain', action: string) {
    if (settled || unlocked) throw new DomainError('conflict');
    const result = await mutate(
      connection,
      context,
      serverId,
      batchId,
      value.bindingHash,
      action,
      (batch) => {
        const file = batch.files.find((file) => file.id === value.id);
        if (file?.state !== 'active') throw new DomainError('conflict');
        file.state = state;
        if (state === 'cancelled')
          file.auditOutcome = action === 'server.upload.not_dispatched' ? 'failed' : 'cancelled';
      },
      timing,
      'settlement',
      'claim',
      state === 'complete' ? value.bytes : undefined,
      value.id,
    );
    settled = true;
    return result;
  }
  return {
    pendingFiles,
    complete: () => settle('complete', 'server.upload.confirmed'),
    /** Only after adapter proof that the external upload was never invoked. */
    rejectBeforeDispatch: () => settle('cancelled', 'server.upload.not_dispatched'),
    /** Only after the adapter receives Wings' rejection of our incomplete multipart. */
    cancelConfirmed: () => settle('cancelled', 'server.upload.cancelled'),
    uncertain: () => settle('uncertain', 'server.upload.uncertain'),
    /** Process loss before settlement retains an active claim, never replayable. */
    unlock,
  };
}

/** Only queued entries can be cancelled without proof of the external outcome. */
export async function cancelUploadBatchEntry(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  batchId: string,
  entryId: string,
  bindingHash: string,
) {
  return mutate(
    db,
    context,
    serverId,
    batchId,
    bindingHash,
    'server.upload.entry_cancelled',
    (batch) => {
      const file = batch.files.find((file) => file.id === entryId);
      if (!file) throw new DomainError('conflict');
      if (file.state === 'queued') file.state = 'cancelled';
    },
    undefined,
    'settlement',
    'global',
    undefined,
    entryId,
  );
}

/** Abandon queued work; retain the full reservation for active/uncertain writes. */
export async function closeUploadBatch(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  batchId: string,
  bindingHash: string,
) {
  return mutate(
    db,
    context,
    serverId,
    batchId,
    bindingHash,
    'server.upload.batch_closed',
    (batch) => {
      for (const file of batch.files) if (file.state === 'queued') file.state = 'cancelled';
    },
  );
}

/** Cancellation polling exposes only entry state; it does not replay provider work. */
export async function uploadBatchStatus(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  batchId: string,
  bindingHash: string,
) {
  const claim = await db
    .selectFrom('upload_ingestion_claims')
    .selectAll()
    .where('id', '=', batchId)
    .executeTakeFirst();
  if (!claim) return { closed: true, files: [] };
  const batch = checkBinding(claim, context, serverId, bindingHash);
  return { closed: false, files: batch.files.map(({ id, state }) => ({ id, state })) };
}

/** A prepare retry may reuse this exact manifest; it never replays an entry. */
export async function readUploadBatch(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  batchId: string,
  bindingHash: string,
) {
  const claim = await db
    .selectFrom('upload_ingestion_claims')
    .selectAll()
    .where('id', '=', batchId)
    .executeTakeFirst();
  if (!claim) {
    const prepared = await db
      .selectFrom('audit_events')
      .select('id')
      .where('action', '=', 'server.upload.batch_prepared')
      .where(sql<string>`metadata->>'claimId'`, '=', batchId)
      .executeTakeFirst();
    if (prepared) throw new DomainError('conflict');
    return null;
  }
  checkBinding(claim, context, serverId, bindingHash);
  return view(claim, false);
}
