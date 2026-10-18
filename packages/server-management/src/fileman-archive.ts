import { createHash } from 'node:crypto';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { recordAudit } from '@nickhosting/database';
import type { FilemanJobServices, FilemanTransferManifest } from '@nickhosting/game-sdk';
import { filemanTransferManifestSchema } from '@nickhosting/game-sdk';
import {
  type FileArchiveCommit,
  isUploadCancelled,
  isUploadNotDispatched,
} from '@nickhosting/pterodactyl-adapter';
import { sql } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources } from './admission.js';
import { filemanTransferDigest, filemanTransferReceiptStep } from './fileman-transfers.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { providerFileIdentity } from './provider-file-operations.js';
import { assertServerStorageCapacity, serverStorageLimitBytes } from './storage-capacity.js';
import { reserveUploadIngestion } from './upload-admission.js';

type Input = Parameters<NonNullable<FilemanJobServices['uploadArchive']>>[0];
interface ArchiveJournal {
  binding: string;
  claimId?: string;
  claimScopeHash?: string;
  manifest?: unknown;
  request?: FileArchiveCommit;
  commitDispatched?: boolean;
  completed?: boolean;
  retrySafe?: boolean;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type ArchiveStage =
  | 'preflight'
  | 'authorization'
  | 'root_listing'
  | 'quota'
  | 'upload_token'
  | 'claim'
  | 'claim_journal'
  | 'upload'
  | 'validation'
  | 'manifest'
  | 'commit_journal'
  | 'before_publish'
  | 'commit'
  | 'receipts';

/** One sanitized ZIP stream and one node-side commit. The exact commit request is
 * durable before dispatch: recovery replays only the provider's operation receipt,
 * never an upload or an unjournaled extraction. Caller retains its server lock. */
export async function uploadFilemanArchive(
  context: GameLifecycleContext,
  options: { env?: Environment; authorize: () => Promise<AuthContext> },
  input: Input,
) {
  // A grant/auth failure can occur before the producer starts or its caller awaits it.
  void input.completion.catch(() => {});
  const jobId = context.operation().job_id;
  const debug = context.logger?.isEnabled('debug') === true;
  const began = debug ? performance.now() : 0;
  const log = (event: string, data: Record<string, unknown>) => {
    if (!debug) return;
    try {
      context.logger?.log('debug', event, { jobId, serverId: context.server.id, ...data });
    } catch {
      /* Diagnostics must not change a transfer or its recovery outcome. */
    }
  };
  const timed = async <T>(
    stage: ArchiveStage,
    work: () => Promise<T>,
    concurrentGroup?: 'preflight' | 'transfer',
  ): Promise<T> => {
    if (!debug) return work();
    const started = performance.now();
    let outcome = 'error';
    try {
      const value = await work();
      outcome = 'ok';
      return value;
    } finally {
      log('servers.file_archive_stage', {
        stage,
        outcome,
        startOffsetMs: Math.round(started - began),
        durationMs: Math.round(performance.now() - started),
        measurement: 'wall',
        ...(concurrentGroup ? { concurrentGroup } : {}),
        files: input.files.length,
        archiveBytes: input.contentLength,
      });
    }
  };
  const { identifier, skeleton, binding, phase, bytes, identity, actor } = await timed(
    'preflight',
    async () => {
      const identifier = context.server.pterodactyl_identifier;
      const skeleton = filemanTransferManifestSchema.parse({
        id: input.id,
        destinationRoot: input.destinationRoot,
        files: input.files.map((file) => ({ ...file, sha256: '0'.repeat(64) })),
      });
      if (
        !identifier ||
        input.destinationRoot.includes('/') ||
        input.destinationRoot.startsWith('.nickhosting-import-') ||
        skeleton.files.length > 10000 ||
        !/^[a-f0-9]{64}$/.test(input.sourceSha256) ||
        !Number.isSafeInteger(input.contentLength) ||
        input.contentLength < 22
      )
        throw new DomainError('validation_failed');
      const binding = hash(
        JSON.stringify({ skeleton, source: input.sourceSha256, bytes: input.contentLength }),
      );
      const phase = `fileman.archive.${binding}`;
      const bytes = skeleton.files.reduce((total, file) => total + file.size, 0);
      const identity = await providerFileIdentity(context.db, context.server);
      if (
        !Number.isSafeInteger(bytes + input.contentLength) ||
        Buffer.byteLength(
          JSON.stringify({
            operationId: jobId,
            identity,
            destinationRoot: input.destinationRoot,
            archiveSha256: '0'.repeat(64),
            files: input.files.map(({ path, size }) => ({ path, size })),
          }),
          'utf8',
        ) > 4194304
      )
        throw new DomainError('validation_failed');
      const actor = await options.authorize();
      return { identifier, skeleton, binding, phase, bytes, identity, actor };
    },
  );
  const authorizations = new Set<Promise<void>>();
  const authorize = () => {
    const work = timed('authorization', async () => {
      await options.authorize();
      await input.beforeWrite?.();
    });
    authorizations.add(work);
    const settled = () => {
      authorizations.delete(work);
    };
    void work.then(settled, settled);
    return work;
  };
  const drainAuthorizations = async () => {
    // The adapter may abort its race against an authorization callback without
    // cancelling that callback's DB query. Keep the connection until it finishes.
    while (authorizations.size) await Promise.allSettled([...authorizations]);
  };
  const receipt = (
    manifest: FilemanTransferManifest,
    digest = filemanTransferDigest(manifest),
  ) => ({
    id: input.id,
    digest,
    files: manifest.files.length,
    bytes,
    manifest,
  });
  const checkedManifest = (value: unknown) => {
    const manifest = filemanTransferManifestSchema.parse(value);
    if (
      manifest.id !== input.id ||
      manifest.destinationRoot !== input.destinationRoot ||
      manifest.files.length !== skeleton.files.length ||
      manifest.files.some(
        (file, i) => file.path !== skeleton.files[i]?.path || file.size !== skeleton.files[i]?.size,
      )
    )
      throw new DomainError('conflict');
    return manifest;
  };
  const persist = (journal: ArchiveJournal) =>
    context.update({
      plan: { ...context.operation().plan, fileArchive: journal },
    });
  const recorded = (manifest: FilemanTransferManifest) =>
    context.db
      .selectFrom('job_steps')
      .select('step')
      .where('job_id', '=', jobId)
      .where('step', '=', filemanTransferReceiptStep(filemanTransferDigest(manifest)))
      .executeTakeFirst();

  const checkedRequest = (journal: ArchiveJournal, manifest: FilemanTransferManifest) => {
    const request = journal.request;
    if (
      !request ||
      request.operationId !== jobId ||
      request.destinationRoot !== input.destinationRoot ||
      !/^[a-f0-9]{64}$/.test(request.archiveSha256) ||
      !request.identity ||
      Object.entries(identity).some(
        ([key, value]) => request.identity[key as keyof typeof identity] !== value,
      ) ||
      !Array.isArray(request.files) ||
      request.files.length !== manifest.files.length ||
      request.files.some(
        (file, i) => file.path !== manifest.files[i]?.path || file.size !== manifest.files[i]?.size,
      ) ||
      !z.uuid().safeParse(journal.claimId).success ||
      !/^[a-f0-9]{64}$/.test(journal.claimScopeHash ?? '')
    )
      throw new DomainError('operation_uncertain');
    return request;
  };
  const publish = async (journal: ArchiveJournal) => {
    const manifest = checkedManifest(journal.manifest);
    const request = checkedRequest(journal, manifest);
    const claimId = journal.claimId as string;
    const lockKey = `:nickhosting:upload:${claimId}`;
    const lock = await sql<{
      acquired: boolean;
    }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${lockKey},0)) as acquired`.execute(
      context.db,
    );
    if (!lock.rows[0]?.acquired) throw new DomainError('operation_uncertain');
    try {
      const claim = await context.db
        .selectFrom('upload_ingestion_claims')
        .selectAll()
        .where('id', '=', claimId)
        .executeTakeFirst();
      if (claim) {
        const scope = claim.scope;
        if (
          claim.server_id !== context.server.id ||
          claim.actor_user_id !== actor.actorUserId ||
          claim.scope_hash !== journal.claimScopeHash ||
          BigInt(claim.declared_bytes) !== BigInt(bytes + input.contentLength) ||
          scope.nodeId !== context.server.node_id ||
          scope.pterodactylNodeId !== identity.nodeId ||
          scope.pterodactylServerId !== identity.providerId ||
          scope.pterodactylServerUuid !== identity.providerUuid ||
          scope.externalId !== identity.externalId
        )
          throw new DomainError('operation_uncertain');
      } else if (!(await recorded(manifest))) throw new DomainError('operation_uncertain');
      // Recovery must repeat the current game guard, even if a prior invocation
      // passed it. An existing provider receipt does not authorize a new game state.
      await authorize();
      await timed('before_publish', () => input.beforePublish(manifest));
      journal = { ...journal, commitDispatched: true };
      await timed('commit_journal', () => persist(journal));
      const confirmed = await timed('commit', () =>
        context.adapter.commitFileArchive(identifier, request, debug ? true : undefined),
      );
      if (confirmed.timings) log('servers.file_archive_provider', { timings: confirmed.timings });
      if (confirmed.state !== 'confirmed') throw new DomainError('operation_uncertain');
      const digest = filemanTransferDigest(manifest);
      // Receipt and capacity settlement are atomic. A crash before the final plan
      // update can replay the exact provider receipt and finish without a claim.
      await timed('receipts', async () => {
        await context.db.transaction().execute(async (tx) => {
          await lockResources(tx);
          const removed = await tx
            .deleteFrom('upload_ingestion_claims')
            .where('id', '=', claimId)
            .where('server_id', '=', context.server.id)
            .where('scope_hash', '=', journal.claimScopeHash as string)
            .returning('id')
            .executeTakeFirst();
          const step = filemanTransferReceiptStep(digest);
          if (
            !removed &&
            !(await tx
              .selectFrom('job_steps')
              .select('step')
              .where('job_id', '=', jobId)
              .where('step', '=', step)
              .executeTakeFirst())
          )
            throw new DomainError('operation_uncertain');
          await tx
            .insertInto('job_steps')
            .values({ job_id: jobId, step })
            .onConflict((conflict) => conflict.columns(['job_id', 'step']).doNothing())
            .execute();
          if (removed)
            await recordAudit(tx, actor, 'server.upload.confirmed', {
              claimId,
              serverId: context.server.id,
            });
        });
        await context.update({
          plan: {
            ...context.operation().plan,
            fileArchive: { ...journal, completed: true },
            fileTransfer: {
              id: input.id,
              digest,
              completedFiles: manifest.files.length,
              totalFiles: manifest.files.length,
              completedBytes: bytes,
              totalBytes: bytes,
            },
          },
        });
      });
      return receipt(manifest, digest);
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${lockKey},0))`.execute(
        context.db,
      );
    }
  };

  const previous = context.operation().plan.fileArchive as ArchiveJournal | undefined;
  if (previous && previous.binding !== binding) throw new DomainError('conflict');
  if (previous?.completed) {
    const manifest = checkedManifest(previous.manifest);
    checkedRequest(previous, manifest);
    if (!(await recorded(manifest))) throw new DomainError('operation_uncertain');
    const retained =
      previous.claimId &&
      (await context.db
        .selectFrom('upload_ingestion_claims')
        .select('id')
        .where('id', '=', previous.claimId)
        .executeTakeFirst());
    if (!retained) return receipt(manifest);
  }
  // Deliberately bypass context.effect: it rejects pending ingestion claims,
  // whereas this path owns exactly the claim corroborated above.
  if (previous?.request) return publish(previous);
  if (
    context.operation().phase === phase &&
    context.operation().effect_started_at &&
    !previous?.retrySafe
  )
    throw new DomainError('operation_uncertain');
  await authorize();
  const scratch = `.nickhosting-import-${jobId}`;
  // These authenticated provider reads are independent. A signed URL grants
  // no write until send() is called. Join every branch even when one fails;
  // neither body consumption nor admission begins before all gates pass.
  const ready = await Promise.allSettled([
    timed(
      'root_listing',
      async () => {
        const root = await context.adapter.listFiles(identifier, '');
        if (
          root.some((entry) =>
            [scratch.toLowerCase(), input.destinationRoot.toLowerCase()].includes(
              entry.name.toLowerCase(),
            ),
          )
        )
          throw new DomainError('conflict');
      },
      'preflight',
    ),
    timed(
      'quota',
      async () => {
        if (serverStorageLimitBytes(context.server.limits.disk) === null) return;
        const usage = await context.adapter.getResources(identifier);
        assertServerStorageCapacity(
          context.server.limits.disk,
          usage.resources.disk_bytes + bytes + input.contentLength,
        );
      },
      'preflight',
    ),
    timed(
      'upload_token',
      () => context.adapter.prepareUpload(identifier, `${scratch}/payload.zip`),
      'preflight',
    ),
  ]);
  for (const outcome of ready) if (outcome.status === 'rejected') throw outcome.reason;
  const prepared = ready[2];
  if (prepared.status !== 'fulfilled') throw new DomainError('operation_uncertain');
  const send = prepared.value;
  let result: ReturnType<typeof receipt> | undefined;
  await context.effect(phase, async () => {
    await authorize();
    const claim = await timed('claim', () =>
      reserveUploadIngestion(
        context.db,
        actor,
        context.server.id,
        input.contentLength + bytes,
        options.env,
        { operationId: jobId, multipartCount: 1, providerLargestFileBytes: input.contentLength },
      ),
    );
    let dispatched = false;
    let settled = false;
    let body: ReadableStream<Uint8Array> | undefined;
    let sending: Promise<void> | undefined;
    const controller = new AbortController();
    const cancel = (reason: unknown) => {
      if (controller.signal.aborted) return;
      controller.abort(reason);
      try {
        input.cancel?.(reason);
      } catch {
        /* Cleanup must not hide the dispatch outcome. */
      }
      if (body && !body.locked) void body.cancel(reason).catch(() => {});
    };
    try {
      let journal = await timed('claim_journal', async () => {
        const stored = await context.db
          .selectFrom('upload_ingestion_claims')
          .select('scope_hash')
          .where('id', '=', claim.id)
          .executeTakeFirstOrThrow();
        const value: ArchiveJournal = {
          binding,
          claimId: claim.id,
          claimScopeHash: stored.scope_hash,
        };
        await persist(value);
        return value;
      });
      const archiveHash = createHash('sha256');
      let sentBytes = 0;
      body = input.open().pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, output) {
            sentBytes += chunk.byteLength;
            archiveHash.update(chunk);
            output.enqueue(chunk);
          },
          flush() {
            if (sentBytes !== input.contentLength) throw new DomainError('conflict');
          },
        }),
        { signal: controller.signal },
      );
      // These spans overlap and include backpressure. They are wall-clock
      // observations, not additive phases or a measure of inflater CPU time.
      const verifying = timed('validation', () => input.completion, 'transfer');
      dispatched = true;
      // Fail fast: waiting for allSettled hangs when a token/connection failure
      // happens before the sender reads the stream and its completion is pending.
      const uploadBody = body;
      sending = timed(
        'upload',
        () =>
          send({
            body: uploadBody,
            contentLength: input.contentLength,
            maxBytes: input.contentLength,
            authorize,
            signal: controller.signal,
          }),
        'transfer',
      );
      const [, verified] = await Promise.all([sending, verifying]);
      await drainAuthorizations();
      const { manifest, request } = await timed('manifest', async () => {
        const manifest = checkedManifest({
          id: input.id,
          destinationRoot: input.destinationRoot,
          files: verified.files,
        });
        if (verified.bytes !== bytes || sentBytes !== input.contentLength)
          throw new DomainError('conflict');
        const request: FileArchiveCommit = {
          operationId: jobId,
          identity,
          destinationRoot: input.destinationRoot,
          archiveSha256: archiveHash.digest('hex'),
          files: manifest.files.map(({ path, size }) => ({ path, size })),
        };
        return { manifest, request };
      });
      journal = { ...journal, manifest, request, commitDispatched: false, completed: false };
      await timed('commit_journal', () => persist(journal));
      result = await publish(journal);
      settled = true;
    } catch (error) {
      cancel(error);
      // The adapter owns a bounded network/authorization lifetime. Join it after
      // cancellation before returning this pinned DB connection; its pending
      // authorization work must not outlive our server/ingestion locks. Never
      // join the producer, which may not have started on a sender-first failure.
      let uploadFailure: unknown = error;
      try {
        await sending;
      } catch (outcome) {
        uploadFailure = outcome;
      }
      await drainAuthorizations();
      if (!dispatched || isUploadNotDispatched(uploadFailure) || isUploadCancelled(uploadFailure)) {
        if (isUploadCancelled(uploadFailure)) await claim.cancelConfirmed();
        else await claim.rejectBeforeDispatch();
        settled = true;
        await persist({ binding, retrySafe: true });
        throw error;
      }
      throw new DomainError('operation_uncertain');
    } finally {
      if (!settled) cancel(new DomainError('operation_uncertain'));
      await drainAuthorizations();
      await claim.unlock();
    }
  });
  if (!result) throw new DomainError('operation_uncertain');
  return result;
}
