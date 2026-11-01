import { DomainError } from '@nickhosting/core';
import {
  type DirectoryBatchResult,
  PterodactylError,
  relativePath,
  type ServerFile,
} from '@nickhosting/pterodactyl-adapter';
import type { UploadTiming } from '@nickhosting/server-management';

const batchSize = 48;
const maxDirectories = 20_000;
const maxBatchBytes = 8 * 1024 * 1024;
const maxPlanBytes = 32 * 1024 * 1024;

function directoryPath(value: string) {
  relativePath(value, true);
  if (Buffer.byteLength(value, 'utf8') > 4096 || /\p{C}/u.test(value))
    throw new DomainError('validation_failed');
  return value;
}

/** Includes the requested directories and root, but never follows their children. */
export function fileDirectoryAncestors(directories: string[]): string[] {
  const ancestors = new Set<string>(['']);
  for (const value of directories) {
    directoryPath(value);
    let path = '';
    for (const part of value ? value.split('/') : []) {
      path = path ? `${path}/${part}` : part;
      ancestors.add(path);
    }
  }
  return [...ancestors];
}

interface PendingDirectory {
  path: string;
  resolve: (files: ServerFile[]) => void;
  reject: (error: unknown) => void;
}

function pathFailure(reason: string) {
  return new DomainError(
    reason === 'not_found'
      ? 'not_found'
      : reason === 'forbidden'
        ? 'forbidden'
        : 'integration_unavailable',
  );
}

/** Fresh metadata for one authorized operation only. No contents, signed URLs,
 * global cache or browser metadata; all consumers share the same pending reads. */
export function createFileDirectoryPlan(options: {
  batch: (paths: string[]) => Promise<DirectoryBatchResult[]>;
  single: (path: string) => Promise<ServerFile[]>;
  timing?: UploadTiming;
}) {
  const entries = new Map<string, Promise<ServerFile[]>>();
  const pending: PendingDirectory[] = [];
  let draining = false;
  let native = false;
  let retainedBytes = 0;
  let failure: unknown;
  const measure = <T>(name: string, work: () => Promise<T>) =>
    options.timing ? options.timing.measure(name, work) : work();

  function reserveMetadata(bytes: number) {
    if (bytes > maxBatchBytes || retainedBytes + bytes > maxPlanBytes) {
      failure = new DomainError('integration_unavailable');
      throw failure;
    }
    retainedBytes += bytes;
  }

  async function readNative(chunk: PendingDirectory[]) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < chunk.length) {
        const entry = chunk[cursor++];
        if (!entry) break;
        if (failure) {
          entry.reject(failure);
          continue;
        }
        try {
          const files = await measure('directory.native', () => options.single(entry.path));
          reserveMetadata(Buffer.byteLength(JSON.stringify(files), 'utf8'));
          entry.resolve(files);
        } catch (error) {
          entry.reject(
            error instanceof PterodactylError && error.reason === 'not_found'
              ? pathFailure('not_found')
              : error instanceof PterodactylError && error.reason === 'permission_denied'
                ? pathFailure('forbidden')
                : error,
          );
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  async function drain() {
    try {
      while (pending.length) {
        const chunk = pending.splice(0, batchSize);
        if (failure) {
          for (const entry of chunk) entry.reject(failure);
          continue;
        }
        if (native) {
          await readNative(chunk);
          continue;
        }
        let results: DirectoryBatchResult[];
        try {
          results = await measure('directory.batch', () =>
            options.batch(chunk.map(({ path }) => path)),
          );
        } catch (error) {
          // Only a missing optional extension permits native reads. An individual
          // path error is a result, never a reason to repeat the whole batch.
          if (error instanceof PterodactylError && [404, 405].includes(error.upstreamStatus ?? 0)) {
            native = true;
            await readNative(chunk);
            continue;
          }
          failure = error;
          for (const entry of chunk) entry.reject(error);
          continue;
        }
        if (
          results.length !== chunk.length ||
          results.some((result, index) => result.directory !== chunk[index]?.path)
        ) {
          failure = new DomainError('integration_unavailable');
          for (const entry of chunk) entry.reject(failure);
          continue;
        }
        try {
          reserveMetadata(Buffer.byteLength(JSON.stringify(results), 'utf8'));
        } catch (error) {
          for (const entry of chunk) entry.reject(error);
          continue;
        }
        for (let index = 0; index < chunk.length; index++) {
          const entry = chunk[index];
          const result = results[index];
          if (!entry || !result) continue;
          if (failure) entry.reject(failure);
          else if ('error' in result) entry.reject(pathFailure(result.error));
          else entry.resolve(result.files);
        }
      }
    } finally {
      draining = false;
    }
  }

  function list(path: string): Promise<ServerFile[]> {
    directoryPath(path);
    if (failure) return Promise.reject(failure);
    const cached = entries.get(path);
    if (cached) return cached;
    if (entries.size >= maxDirectories) throw new DomainError('validation_failed', 413);
    const promise = new Promise<ServerFile[]>((resolve, reject) => {
      pending.push({ path, resolve, reject });
    });
    entries.set(path, promise);
    // A failed read remains cached, including callers which consume it later.
    void promise.catch(() => {});
    if (!draining) {
      draining = true;
      queueMicrotask(() => void drain());
    }
    return promise;
  }

  async function prime(paths: string[]): Promise<void> {
    // Validate the entire seed before dispatching any reads.
    const unique = new Set(paths.map(directoryPath));
    const additions = [...unique].filter((path) => !entries.has(path)).length;
    if (entries.size + additions > maxDirectories) throw new DomainError('validation_failed', 413);
    // Keep the authorized operation alive until all dispatched reads have settled.
    const results = await Promise.allSettled([...unique].map(list));
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  }

  return { list, prime };
}
