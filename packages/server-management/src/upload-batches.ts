import { createHash } from 'node:crypto';
import { type AuthContext, authSessionId, DomainError } from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import { type Kysely, type Selectable, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { lockResources } from './admission.js';
import { parse } from './registry.js';
import { uploadMultipartAllowanceBytes } from './upload-policy.js';

type Claim = Selectable<Database['upload_ingestion_claims']>;
type Batch = NonNullable<Claim['scope']['batch']>;
export type UploadBatchFile = Omit<Batch['files'][number], 'state'>;
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
async function persist(tx: Transaction<Database>, claim: Claim, releaseFinished = true) {
  const batch = claim.scope.batch;
  if (!batch) throw new DomainError('conflict');
  const closed =
    releaseFinished &&
    batch.files.every((file) => file.state === 'complete' || file.state === 'cancelled');
  if (closed) {
    await tx.deleteFrom('upload_ingestion_claims').where('id', '=', claim.id).execute();
  } else {
    const scope = JSON.stringify(claim.scope);
    await tx
      .updateTable('upload_ingestion_claims')
      .set({ scope, scope_hash: createHash('sha256').update(scope).digest('hex') })
      .where('id', '=', claim.id)
      .execute();
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
) {
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const claim = await tx
      .selectFrom('upload_ingestion_claims')
      .selectAll()
      .where('id', '=', batchId)
      .forUpdate()
      .executeTakeFirst();
    if (!claim) throw new DomainError('conflict');
    const batch = checkBinding(claim, context, serverId, bindingHash);
    change(batch);
    const result = await persist(tx, claim);
    await recordAudit(tx, context, action, { claimId: claim.id, serverId, closed: result.closed });
    return result;
  });
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
    await recordAudit(tx, context, 'server.upload.batch_prepared', {
      claimId,
      serverId,
      files: value.files.length,
      declaredBytes: total,
      concurrency: value.concurrency,
    });
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
) {
  const value = parse(fileSchema.extend({ bindingHash: bindingSchema }), input);
  const result = await sql<{
    acquired: boolean;
  }>`select pg_try_advisory_lock_shared(hashtextextended(current_schema() || ${lockKey(batchId)},0)) as acquired`.execute(
    connection,
  );
  if (!result.rows[0]?.acquired) throw new DomainError('conflict');
  let unlocked = false;
  async function unlock() {
    if (unlocked) return;
    unlocked = true;
    await sql`select pg_advisory_unlock_shared(hashtextextended(current_schema() || ${lockKey(batchId)},0))`.execute(
      connection,
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
      },
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
      },
    );
    settled = true;
    return result;
  }
  return {
    complete: () => settle('complete', 'server.upload.confirmed'),
    /** Only after adapter proof that the external upload was never invoked. */
    rejectBeforeDispatch: () => settle('cancelled', 'server.upload.not_dispatched'),
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
