import { DomainError } from '@nickhosting/core';
import {
  type DirectoryBatchResult,
  type PterodactylAdapter,
  PterodactylError,
  relativePath,
} from '@nickhosting/pterodactyl-adapter';
import type {
  FilemanDirectoryResult,
  FilemanEntry,
  FilemanReadRequest,
  FilemanReadService,
} from '../../game-sdk/src/fileman-read.js';

const singleLimit = 8 * 1024 ** 2;
const batchLimit = 16 * 1024 ** 2;
const parallelism = 4;
const entry = (
  file: Awaited<ReturnType<PterodactylAdapter['listFiles']>>[number],
): FilemanEntry => ({
  name: file.name,
  kind: file.is_symlink ? 'symlink' : file.is_file ? 'file' : 'directory',
  size: file.size,
});
async function parallel<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(parallelism, items.length) }, async () => {
      while (!failed) {
        const index = next++;
        if (index >= items.length) return;
        try {
          results[index] = await work(items[index] as T);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  for (const result of workers) if (result.status === 'rejected') throw result.reason;
  return results;
}
/** Same Fileman transports, privately scoped to one authorized request/job phase.
 * Directory snapshots are request-local; file bytes are never cached across calls.
 * Callers create a new scope after mutations, so verification cannot reuse stale data. */
export function createFilemanReadService(options: {
  adapter: PterodactylAdapter;
  identifier: string;
  authorize: () => Promise<void>;
  signal?: AbortSignal;
  /** Runtime supplies Fileman's Owner-configured, bounded Blueprint batch transport. */
  listDirectories?: (directories: string[]) => Promise<DirectoryBatchResult[]>;
}): FilemanReadService {
  const { adapter, identifier, authorize, signal } = options;
  const directories = new Map<string, Promise<readonly FilemanEntry[]>>();
  const check = () => signal?.throwIfAborted();
  const validate = (request: FilemanReadRequest) => {
    relativePath(request.path);
    if (
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes < 1 ||
      request.maxBytes > singleLimit
    )
      throw new DomainError('validation_failed');
  };
  async function bytes(request: FilemanReadRequest) {
    check();
    try {
      if (request.maxBytes <= 1024 ** 2) {
        const data = await adapter.readFileForEditor(identifier, request.path, request.maxBytes);
        check();
        return data;
      }
      const response = await adapter.downloadFile(identifier, request.path, {
        maxBytes: request.maxBytes,
        signal,
      });
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          check();
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > request.maxBytes) throw new DomainError('validation_failed', 413);
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      if (
        request.missing === 'allow' &&
        error instanceof PterodactylError &&
        error.reason === 'not_found' &&
        error.upstreamStatus === 404
      )
        return undefined;
      throw error;
    }
  }
  async function prepare(paths: readonly string[], authorized = false) {
    if (!paths.length || paths.length > 128) throw new DomainError('validation_failed');
    for (const path of paths) relativePath(path);
    check();
    if (!authorized) await authorize();
    try {
      await adapter.prefetchDownloads(identifier, [...paths]);
    } catch (error) {
      if (!(error instanceof PterodactylError && [404, 405].includes(error.upstreamStatus ?? 0)))
        throw error;
    }
  }
  async function readMany(requests: readonly FilemanReadRequest[]) {
    if (!requests.length || requests.length > 128) throw new DomainError('validation_failed');
    for (const request of requests) validate(request);
    if (
      new Set(requests.map(({ path }) => path)).size !== requests.length ||
      requests.reduce((sum, request) => sum + request.maxBytes, 0) > batchLimit
    )
      throw new DomainError('validation_failed');
    check();
    await authorize();
    if (requests.length > 1)
      await prepare(
        requests.map(({ path }) => path),
        true,
      );
    const values = await parallel(requests, bytes);
    await authorize();
    return new Map(requests.map(({ path }, index) => [path, values[index]]));
  }
  async function list(directory: string) {
    relativePath(directory, true);
    let pending = directories.get(directory);
    if (!pending) {
      if (directories.size >= 128) throw new DomainError('validation_failed');
      pending = (async () => {
        check();
        await authorize();
        const files = await adapter.listFiles(identifier, directory);
        check();
        await authorize();
        return files.map(entry);
      })();
      directories.set(directory, pending);
    }
    return pending;
  }
  async function listMany(paths: readonly string[]): Promise<readonly FilemanDirectoryResult[]> {
    if (!paths.length || paths.length > 100 || new Set(paths).size !== paths.length)
      throw new DomainError('validation_failed');
    for (const path of paths) relativePath(path, true);
    check();
    await authorize();
    if (options.listDirectories) {
      try {
        const results = await options.listDirectories([...paths]);
        check();
        await authorize();
        return results.map((result) => {
          if ('error' in result) return result;
          const files = result.files.map(entry);
          directories.set(result.directory, Promise.resolve(files));
          return { directory: result.directory, files };
        });
      } catch (error) {
        if (!(error instanceof PterodactylError && [404, 405].includes(error.upstreamStatus ?? 0)))
          throw error;
      }
    }
    const results = await parallel(paths, async (directory): Promise<FilemanDirectoryResult> => {
      try {
        check();
        const files = (await adapter.listFiles(identifier, directory)).map(entry);
        directories.set(directory, Promise.resolve(files));
        return { directory, files };
      } catch (error) {
        check();
        if (
          error instanceof DomainError &&
          (error.status === 401 || error.status === 403 || error.code === 'provenance_mismatch')
        )
          throw error;
        if (error instanceof PterodactylError && [401, 403].includes(error.upstreamStatus ?? 0))
          throw error;
        return {
          directory,
          error:
            error instanceof PterodactylError && error.upstreamStatus === 404
              ? 'not_found'
              : 'unavailable',
        };
      }
    });
    await authorize();
    return results;
  }
  return {
    prepare: (paths) => prepare(paths),
    read: async (request) => (await readMany([request])).get(request.path),
    readMany,
    list,
    listMany,
  };
}
