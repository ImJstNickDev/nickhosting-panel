import { createHash } from 'node:crypto';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { getSettings } from '@nickhosting/database';
import {
  isUploadCancelled,
  isUploadNotDispatched,
  isUploadNotPublished,
  relativePath,
  type ServerFile,
} from '@nickhosting/pterodactyl-adapter';
import {
  assertNoPendingUpload,
  cancelUploadBatchEntry,
  claimUploadBatchEntry,
  closeUploadBatch,
  createUploadBatch,
  type ManagementRuntime,
  parse,
  readUploadBatch,
  reserveUploadIngestion,
  serverStorageLimitBytes,
  type UploadTiming,
  uploadBatchMaxFiles,
  uploadBatchStatus,
} from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';
import { createUploadUrlCache, type UploadUrlCache } from './upload-url-cache.js';

type C = Context<{ Variables: Variables }>;
const fileSchema = z.strictObject({
  id: z.string().min(1).max(128),
  path: z.string().min(1).max(4096),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  overwrite: z.boolean(),
});
async function json(c: C) {
  if (!c.req.header('content-type')?.startsWith('application/json'))
    throw new DomainError('validation_failed');
  try {
    return await c.req.json();
  } catch {
    throw new DomainError('validation_failed');
  }
}

/** Prepare a bounded group once; retain independent binary requests and outcomes.
 * Filesystem preflight is an observation at preparation, not an external filesystem lock. */
export function registerUploadBatchRoutes(
  app: Hono<{ Variables: Variables }>,
  options: ServerRouteOptions,
) {
  const urls = createUploadUrlCache();
  app.post('/v1/servers/:id/files/upload-batches', async (c) => {
    const trace = options.logger?.isEnabled('debug') ?? false;
    const started = trace ? performance.now() : 0;
    const context = await options.principal(c),
      service = await options.management();
    const input = parse(
      z.strictObject({ id: z.uuid(), files: z.array(fileSchema).min(1).max(uploadBatchMaxFiles) }),
      await json(c),
    );
    const files = input.files.map((file) => ({ ...file, path: relativePath(file.path) }));
    const manifestHash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    const paths = new Set(files.map((file) => file.path.toLowerCase()));
    if (
      paths.size !== files.length ||
      new Set(files.map((file) => file.id)).size !== files.length ||
      files.some((file) =>
        file.path
          .slice(1)
          .split('/')
          .slice(0, -1)
          .some((_, index) =>
            paths.has(
              `/${file.path
                .slice(1)
                .split('/')
                .slice(0, index + 1)
                .join('/')}`.toLowerCase(),
            ),
          ),
      )
    )
      throw new DomainError('validation_failed');
    const serverId = c.req.param('id');
    const release = options.acquireUploadSlot();
    try {
      return c.json(
        await service.uploadBatchAccess(
          context,
          serverId,
          async (identifier, connection, current, server) => {
            const bindingHash = service.uploadBatchBinding(server);
            const credentialBinding = await service.consoleBindingForServer(serverId);
            const cacheKey = `${input.id}:${bindingHash}:${credentialBinding}`;
            const previous = await readUploadBatch(
              connection,
              current,
              serverId,
              input.id,
              bindingHash,
            );
            if (previous) {
              if (previous.manifestHash !== manifestHash) throw new DomainError('conflict');
              const queued = previous.files.filter((file) => file.state === 'queued');
              if (queued.length)
                await urls.warm(cacheKey, queued, (paths) =>
                  service.adapter.prepareUploadBatch(identifier, paths),
                );
              return previous;
            }
            await assertNoPendingUpload(connection, serverId);
            const listings = new Map<string, Promise<ServerFile[]>>();
            const listFiles = (root: string) => {
              const key = root.replace(/^\//, '');
              let pending = listings.get(key);
              if (!pending) {
                pending = service.adapter.listFiles(identifier, key);
                listings.set(key, pending);
              }
              return pending;
            };
            const rejected: Array<{ id: string; code: 'file_exists' | 'conflict' }> = [];
            const results = await Promise.allSettled([
              (async () => {
                const directories = [
                  ...new Set(
                    files.map((file) => file.path.slice(0, file.path.lastIndexOf('/')).slice(1)),
                  ),
                ];
                let next = 0;
                const reads = await Promise.allSettled(
                  Array.from({ length: Math.min(4, directories.length) }, async () => {
                    for (;;) {
                      const directory = directories[next++];
                      if (directory === undefined) break;
                      await listFiles(directory);
                    }
                  }),
                );
                for (const read of reads) if (read.status === 'rejected') throw read.reason;
                const accepted: typeof files = [];
                let growth = 0;
                for (const file of files) {
                  const directory = file.path.slice(0, file.path.lastIndexOf('/')).slice(1);
                  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
                  const matches = (await listFiles(directory)).filter(
                    (entry) => entry.name.toLowerCase() === name.toLowerCase(),
                  );
                  const existing = matches[0];
                  if (existing && !file.overwrite) {
                    rejected.push({ id: file.id, code: 'file_exists' });
                    continue;
                  }
                  if (
                    matches.length > 1 ||
                    (existing &&
                      (!existing.is_file || existing.is_symlink || existing.name !== name))
                  ) {
                    rejected.push({ id: file.id, code: 'conflict' });
                    continue;
                  }
                  // No shrink credit: a later failed/cancelled overwrite must not fund another entry.
                  growth += Math.max(0, file.bytes - (existing?.size ?? 0));
                  accepted.push(file);
                }
                // Shared fresh observations protect the admitted group once. A rejected
                // leaf does not prevent unrelated entries from being prepared.
                if (accepted.length)
                  await service.assertFileMutation(
                    serverId,
                    accepted.map((file) => file.path.slice(1)),
                    connection,
                    { providerIdentifier: identifier, listFiles },
                  );
                return { accepted, growth };
              })(),
              service.adapter.getResources(identifier),
              getSettings(connection, options.env),
              urls.warm(cacheKey, files, (paths) =>
                service.adapter.prepareUploadBatch(identifier, paths, { readDirectory: listFiles }),
              ),
            ]);
            const [prepared, observed, configured, tickets] = results;
            if (
              prepared.status === 'rejected' ||
              observed.status === 'rejected' ||
              configured.status === 'rejected' ||
              tickets.status === 'rejected'
            ) {
              urls.forget(cacheKey);
              for (const result of results) if (result.status === 'rejected') throw result.reason;
              throw new DomainError('integration_unavailable');
            }
            const concurrency = configured.value.values.uploadConcurrency;
            const { accepted, growth } = prepared.value;
            if (!accepted.length) {
              urls.forget(cacheKey);
              return { id: null, concurrency, rejected, files: [] };
            }
            const bytes = accepted.reduce((sum, file) => sum + file.bytes, 0);
            const maxBytes = serverStorageLimitBytes(server.limits.disk);
            if (
              !Number.isSafeInteger(bytes) ||
              !Number.isSafeInteger(growth) ||
              (maxBytes !== null &&
                (observed.value.resources.disk_bytes + growth > maxBytes ||
                  accepted.some((file) => file.bytes > maxBytes)))
            )
              throw new DomainError('validation_failed', 413);
            c.req.raw.signal.throwIfAborted();
            await service.authorizeTransfer(current, serverId, true, connection);
            const claim = await reserveUploadIngestion(
              connection,
              current,
              serverId,
              bytes,
              options.env,
              {
                claimId: input.id,
                providerLargestFileBytes: Math.max(...accepted.map((file) => file.bytes)),
                multipartCount: Math.min(concurrency, accepted.length),
              },
            );
            try {
              c.req.raw.signal.throwIfAborted();
              const batch = await createUploadBatch(connection, current, serverId, claim.id, {
                bindingHash,
                concurrency,
                files: accepted,
                manifestHash,
                rejected,
              });
              try {
                if (trace)
                  options.logger?.log('debug', 'server.files_upload_prepared', {
                    requestId: c.get('requestId'),
                    serverId,
                    files: accepted.length,
                    bytes,
                    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
                  });
              } catch {}
              return batch;
            } catch (error) {
              urls.forget(cacheKey);
              await claim.rejectBeforeDispatch();
              throw error;
            } finally {
              await claim.unlock();
            }
          },
          true,
        ),
      );
    } finally {
      release();
    }
  });
  app.get('/v1/servers/:id/files/upload-batches/:batchId', async (c) => {
    const context = await options.principal(c),
      service = await options.management();
    const serverId = parse(z.uuid(), c.req.param('id')),
      batchId = parse(z.uuid(), c.req.param('batchId'));
    const release = options.acquireUploadSlot();
    try {
      return c.json(
        await service.uploadBatchAccess(
          context,
          serverId,
          async (_id, connection, current, server) =>
            uploadBatchStatus(
              connection,
              current,
              serverId,
              batchId,
              service.uploadBatchBinding(server),
            ),
        ),
      );
    } finally {
      release();
    }
  });
  for (const action of ['close', 'cancel'] as const) {
    const handler = async (c: C) => {
      const context = await options.principal(c),
        service = await options.management();
      const serverId = parse(z.uuid(), c.req.param('id')),
        batchId = parse(z.uuid(), c.req.param('batchId'));
      const entryId =
        action === 'cancel'
          ? parse(z.strictObject({ entryId: z.string().min(1).max(128) }), await json(c)).entryId
          : undefined;
      const release = options.acquireUploadSlot();
      try {
        await service.uploadBatchAccess(
          context,
          serverId,
          async (_id, connection, current, server) => {
            const cacheKey = `${batchId}:${service.uploadBatchBinding(server)}:${await service.consoleBindingForServer(serverId)}`;
            if (action === 'close') urls.forget(cacheKey);
            // Completion already released the reservation: close is idempotent.
            const exists = await connection
              .selectFrom('upload_ingestion_claims')
              .select('id')
              .where('id', '=', batchId)
              .executeTakeFirst();
            if (!exists) return;
            const binding = service.uploadBatchBinding(server);
            if (entryId !== undefined)
              await cancelUploadBatchEntry(
                connection,
                current,
                serverId,
                batchId,
                entryId,
                binding,
              );
            else await closeUploadBatch(connection, current, serverId, batchId, binding);
          },
        );
      } finally {
        release();
      }
      return c.body(null, 204);
    };
    if (action === 'close') app.delete('/v1/servers/:id/files/upload-batches/:batchId', handler);
    else app.post('/v1/servers/:id/files/upload-batches/:batchId/cancel', handler);
  }
  return (c: C, input: Parameters<typeof runBatchUpload>[2]) =>
    runBatchUpload(c, options, input, urls);
}

async function runBatchUpload(
  c: C,
  options: ServerRouteOptions,
  input: {
    path: string;
    overwrite: boolean;
    contentLength: number;
    started: number;
    context: AuthContext;
    service: ManagementRuntime;
    timing?: UploadTiming;
  },
  urls: UploadUrlCache,
) {
  const batchId = parse(z.uuid(), c.req.query('batchId'));
  const entryId = parse(z.string().min(1).max(128), c.req.query('entryId'));
  if (c.req.queries('batchId')?.length !== 1 || c.req.queries('entryId')?.length !== 1)
    throw new DomainError('validation_failed');
  const { context, service, timing } = input;
  const serverId = parse(z.uuid(), c.req.param('id')),
    release = options.acquireUploadSlot();
  let outcome = 'failed';
  const durations: Record<string, number> = {};
  const measure = async <T>(key: string, work: () => Promise<T>) => {
    if (!timing) return work();
    const since = performance.now();
    try {
      return await work();
    } finally {
      durations[key] = Math.round((performance.now() - since) * 1000) / 1000;
    }
  };
  try {
    await service.uploadBatchAccess(
      context,
      serverId,
      async (identifier, connection, current, server) => {
        if (timing)
          durations.accessMs = Math.round((performance.now() - input.started) * 1000) / 1000;
        const bindingHash = service.uploadBatchBinding(server);
        const admission = measure('admissionMs', () =>
          claimUploadBatchEntry(
            connection,
            current,
            serverId,
            batchId,
            {
              bindingHash,
              id: entryId,
              path: relativePath(input.path),
              bytes: input.contentLength,
              overwrite: input.overwrite,
            },
            timing,
          ),
        );
        const [admitted, signed] = await Promise.allSettled([
          admission,
          measure('signedUrlMs', async () => {
            const key = `${batchId}:${bindingHash}:${await service.consoleBindingForServer(serverId, timing)}`;
            const file = { id: entryId, path: relativePath(input.path) };
            let send = await (timing
              ? timing.measure('url.cacheLookup', () => urls.take(key, file))
              : urls.take(key, file));
            if (send === undefined) {
              // Restart/expiry loses only disposable credentials. Reissue tokens
              // for queued entries and this admitted entry, never replay a write.
              const lease = await admission;
              await urls.warm(
                key,
                lease.pendingFiles,
                (paths) => service.adapter.prepareUploadBatch(identifier, paths),
                entryId,
              );
              send = await urls.take(key, file);
            }
            if (send === undefined) throw new DomainError('conflict');
            return (
              send ??
              service.adapter.prepareUpload(identifier, input.path, { signal: c.req.raw.signal })
            );
          }),
        ]);
        if (admitted.status === 'rejected') throw admitted.reason;
        const lease = admitted.value;
        try {
          if (signed.status === 'rejected') {
            await lease.rejectBeforeDispatch();
            throw signed.reason;
          }
          let received = false;
          try {
            await measure('providerMs', () =>
              signed.value({
                body:
                  c.req.raw.body ??
                  new ReadableStream({
                    start(controller) {
                      controller.close();
                    },
                  }),
                contentLength: input.contentLength,
                maxBytes: serverStorageLimitBytes(server.limits.disk) ?? input.contentLength,
                signal: c.req.raw.signal,
                authorize: () =>
                  service.authorizeTransfer(current, serverId, true, connection, timing, server),
              }),
            );
            received = true;
            await measure('settlementMs', () => lease.complete());
          } catch (error) {
            if (!received) {
              if (isUploadNotDispatched(error)) await lease.rejectBeforeDispatch();
              else if (isUploadCancelled(error)) await lease.cancelConfirmed();
              else if (isUploadNotPublished(error)) await lease.rejectBeforePublication();
              else await lease.uncertain();
            }
            throw error;
          }
        } finally {
          await lease.unlock();
        }
      },
      false,
      timing,
      true,
    );
    outcome = 'succeeded';
  } finally {
    release();
    try {
      if (timing)
        options.logger?.log('debug', 'server.files_upload', {
          requestId: c.get('requestId'),
          serverId,
          bytes: input.contentLength,
          outcome,
          batch: true,
          ...durations,
          durationMs: Math.round((performance.now() - input.started) * 1000) / 1000,
          atomic: timing?.snapshot(),
        });
    } catch {}
  }
  return c.body(null, 204);
}
