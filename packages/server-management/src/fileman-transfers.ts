import { createHash } from 'node:crypto';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { getSettings } from '@nickhosting/database';
import {
  type FilemanJobServices,
  type FilemanTransferManifest,
  filemanTransferManifestSchema,
} from '@nickhosting/game-sdk';
import { isUploadNotDispatched, relativePath } from '@nickhosting/pterodactyl-adapter';
import type { Environment } from './admission.js';
import { createUploadUrlCache } from './file-upload-urls.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { assertServerStorageCapacity, serverStorageLimitBytes } from './storage-capacity.js';
import { reserveUploadIngestion } from './upload-admission.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function filemanTransferDigest(manifest: FilemanTransferManifest) {
  return hash(JSON.stringify(filemanTransferManifestSchema.parse(manifest)));
}
export const filemanTransferReceiptStep = (digest: string) => `fileman.transfer.${digest}`;

/** The same signed Wings streams and admission used by Fileman, under a durable
 * job instead of a browser session. The caller already holds the server lock. */
export function createFilemanJobServices(
  context: GameLifecycleContext,
  options: { env?: Environment; authorize: () => Promise<AuthContext> },
): FilemanJobServices {
  return {
    async uploadStaged(input) {
      const manifest = filemanTransferManifestSchema.parse({
        id: input.id,
        destinationRoot: input.destinationRoot,
        files: input.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
      });
      const digest = filemanTransferDigest(manifest);
      const prefix = filemanTransferReceiptStep(digest);
      const jobId = context.operation().job_id;
      const identifier = context.server.pterodactyl_identifier;
      if (!identifier) throw new DomainError('conflict');
      const receipt = {
        id: manifest.id,
        digest,
        files: manifest.files.length,
        bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
      };
      const rows = await context.db
        .selectFrom('job_steps')
        .select('step')
        .where('job_id', '=', jobId)
        .where('step', 'like', `${prefix}%`)
        .execute();
      const steps = new Set(rows.map((row) => row.step));
      if (steps.has(prefix)) return receipt;
      const done = (path: string) => `${prefix}.done.${hash(path)}`;
      const dispatched = (path: string) => `${prefix}.sent.${hash(path)}`;
      if (
        manifest.files.some(
          (file) => steps.has(dispatched(file.path)) && !steps.has(done(file.path)),
        )
      )
        throw new DomainError('operation_uncertain');
      const old = context.operation().plan.fileTransfer as
        | { id?: string; digest?: string }
        | undefined;
      if (old && (old.id !== manifest.id || old.digest !== digest))
        throw new DomainError('conflict');
      const actor = await options.authorize();
      // One queue for the pinned DB connection: concurrent streams cannot open
      // overlapping transactions or overwrite one another's progress snapshots.
      let tail: Promise<unknown> = Promise.resolve();
      function serial<T>(work: () => Promise<T>): Promise<T> {
        const result = tail.then(work);
        tail = result.catch(() => {});
        return result;
      }
      let checking: Promise<void> | undefined;
      const authorize = () => {
        checking ??= serial(async () => {
          await options.authorize();
          await input.beforeWrite?.();
        }).finally(() => {
          checking = undefined;
        });
        return checking;
      };
      const record = async (step: string) => {
        await context.db
          .insertInto('job_steps')
          .values({ job_id: jobId, step })
          .onConflict((conflict) => conflict.columns(['job_id', 'step']).doNothing())
          .execute();
        steps.add(step);
      };
      const forgetDispatch = (path: string) =>
        serial(async () => {
          await context.db
            .deleteFrom('job_steps')
            .where('job_id', '=', jobId)
            .where('step', '=', dispatched(path))
            .execute();
          steps.delete(dispatched(path));
        });
      let completedFiles = manifest.files.filter((file) => steps.has(done(file.path))).length;
      let completedBytes = manifest.files
        .filter((file) => steps.has(done(file.path)))
        .reduce((sum, file) => sum + file.size, 0);
      const progress = () =>
        context.update({
          plan: {
            ...context.operation().plan,
            fileTransfer: {
              id: manifest.id,
              digest,
              completedFiles,
              totalFiles: receipt.files,
              completedBytes,
              totalBytes: receipt.bytes,
            },
          },
        });
      await progress();
      const pending = manifest.files.filter((file) => !steps.has(done(file.path)));
      if (!pending.length) {
        const claim = await context.db
          .selectFrom('upload_ingestion_claims')
          .select('id')
          .where('server_id', '=', context.server.id)
          .executeTakeFirst();
        if (claim) throw new DomainError('operation_uncertain');
        await record(prefix);
        return receipt;
      }
      const { values } = await getSettings(context.db, options.env);
      const concurrency = Math.min(values.uploadConcurrency, pending.length);
      const total = pending.reduce((sum, file) => sum + file.size, 0);
      // A shared-pool server has no per-server disk quota to compare. Physical
      // free space and ingestion budgets are still reserved below for the batch.
      if (serverStorageLimitBytes(context.server.limits.disk) !== null) {
        const usage = await context.adapter.getResources(identifier);
        assertServerStorageCapacity(context.server.limits.disk, usage.resources.disk_bytes + total);
      }
      const urls = createUploadUrlCache();
      // A source is opened only when a stream slot is available. Memory is bounded
      // by concurrency, not by the size of an archive or its largest file.
      await context.effect(prefix, async () => {
        await authorize();
        // The integration declares a new tree (replacement, if approved, happened
        // beforehand). Ancestors are checked once; newly created dirs need no scan.
        const parts = relativePath(manifest.destinationRoot).slice(1).split('/');
        let parent = '';
        for (let index = 0; index < parts.length; index++) {
          const name = parts[index] as string;
          const directory = [parent, name].filter(Boolean).join('/');
          const marker = `${prefix}.directory.${hash(directory)}`;
          const listing = await context.adapter.listFiles(identifier, parent);
          const matches = listing.filter(
            (entry) => entry.name.toLowerCase() === name.toLowerCase(),
          );
          const entry = matches[0];
          if (
            matches.length > 1 ||
            (entry && (entry.name !== name || entry.is_file || entry.is_symlink))
          )
            throw new DomainError('conflict');
          if (index === parts.length - 1 && entry && !steps.has(marker))
            throw new DomainError('conflict');
          if (!entry) {
            if (steps.has(marker)) throw new DomainError('operation_uncertain');
            await context.adapter.createDirectory(identifier, parent, name);
            await record(marker);
          }
          parent = directory;
        }
        // Wings' native upload creates missing parents through UnixFS.Touch/MkdirAll.
        // Keep the destination root's collision/ownership marker above; descendants
        // need no separate provider calls or markers before their file transfers.
        let failure: unknown;
        const claim = await reserveUploadIngestion(
          context.db,
          actor,
          context.server.id,
          total,
          options.env,
          {
            operationId: jobId,
            multipartCount: concurrency,
            providerLargestFileBytes: Math.max(...pending.map((file) => file.size)),
          },
        );
        let uncertain = false;
        let settled = false;
        let confirmed = 0;
        const settle = async () => {
          if (confirmed) await claim.complete();
          else await claim.rejectBeforeDispatch();
          settled = true;
        };
        try {
          // Same disposable bulk grants as browser Fileman, at most 500 per window.
          for (let offset = 0; offset < pending.length && !failure; offset += 500) {
            const window = pending.slice(offset, offset + 500).sort((a, b) => a.size - b.size);
            const key = `${digest}:${offset}`;
            const tickets = () => window.map((file) => ({ id: file.path, path: `/${file.path}` }));
            await urls.warm(key, tickets(), (paths) =>
              context.adapter.prepareUploadBatch(identifier, paths),
            );
            const results = await Promise.allSettled(
              Array.from({ length: Math.min(concurrency, window.length) }, async (_, lane) => {
                while (window.length && !failure) {
                  // One lane takes the largest files; the other lanes drain small files.
                  const file = lane === 0 ? window.pop() : window.shift();
                  if (!file) break;
                  let sent = false;
                  let checked: ReadableStream<Uint8Array> | undefined;
                  try {
                    let send = await urls.take(key, { id: file.path, path: `/${file.path}` });
                    if (send === undefined) {
                      await urls.warm(
                        key,
                        [{ id: file.path, path: `/${file.path}` }, ...tickets()],
                        (paths) => context.adapter.prepareUploadBatch(identifier, paths),
                        file.path,
                      );
                      send = await urls.take(key, { id: file.path, path: `/${file.path}` });
                    }
                    if (send === undefined) throw new DomainError('integration_unavailable');
                    send ??= await context.adapter.prepareUpload(identifier, file.path);
                    await authorize();
                    if (failure) break;
                    const body = await input.open(file.path);
                    const digestStream = createHash('sha256');
                    let bytes = 0;
                    checked = body.pipeThrough(
                      new TransformStream<Uint8Array, Uint8Array>({
                        transform(chunk, controller) {
                          bytes += chunk.byteLength;
                          digestStream.update(chunk);
                          controller.enqueue(chunk);
                        },
                        flush() {
                          if (bytes !== file.size || digestStream.digest('hex') !== file.sha256)
                            throw new DomainError('conflict');
                        },
                      }),
                    );
                    if (failure) break;
                    await serial(() => record(dispatched(file.path)));
                    if (failure) {
                      await forgetDispatch(file.path);
                      break;
                    }
                    sent = true;
                    await send({
                      body: checked,
                      contentLength: file.size,
                      maxBytes: file.size,
                      authorize,
                    });
                    await serial(async () => {
                      await record(done(file.path));
                      confirmed++;
                      completedFiles++;
                      completedBytes += file.size;
                      await progress();
                    });
                  } catch (error) {
                    failure ??= error;
                    if (sent && isUploadNotDispatched(error)) {
                      await forgetDispatch(file.path);
                    } else if (sent) uncertain = true;
                  } finally {
                    if (checked && !checked.locked) await checked.cancel().catch(() => {});
                  }
                }
              }),
            );
            for (const result of results)
              if (result.status === 'rejected') {
                failure ??= result.reason;
                uncertain = true;
              }
            urls.forget(key);
          }
          await tail;
          if (!uncertain) {
            await settle();
          }
          // A rejected URL/read after an earlier write must never mark the whole
          // operation as a rejected, side-effect-free provider action.
          if (failure) throw new DomainError('operation_uncertain');
          await record(prefix);
        } catch (error) {
          if (error instanceof DomainError && error.code === 'operation_uncertain') throw error;
          throw new DomainError('operation_uncertain');
        } finally {
          try {
            if (!settled && !uncertain) await settle();
          } finally {
            await claim.unlock();
          }
        }
      });
      return receipt;
    },
  };
}
