import { DomainError } from '@nickhosting/core';
import type { PterodactylAdapter, ServerFile } from '@nickhosting/pterodactyl-adapter';
import type { ArchiveEntry } from './file-browsing.js';
import { inspectFilePath } from './file-path-inspection.js';

const concurrentSmallFiles = 8;
const smallFileBytes = 512 * 1024;
const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

export function sameArchiveFile(observed: ServerFile, current: ServerFile | undefined) {
  return (
    current?.is_file &&
    !current.is_symlink &&
    current.size === observed.size &&
    current.modified_at === observed.modified_at &&
    current.created_at === observed.created_at &&
    current.mode === observed.mode &&
    current.mode_bits === observed.mode_bits
  );
}

async function readSmall(body: ReadableStream<Uint8Array>, size: number, signal: AbortSignal) {
  const reader = body.getReader();
  const result = new Uint8Array(size);
  let offset = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      if (item.value.byteLength > size - offset) throw new DomainError('conflict');
      result.set(item.value, offset);
      offset += item.value.byteLength;
    }
    signal.throwIfAborted();
    if (offset !== size) throw new DomainError('conflict');
    return result;
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function bytesStream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** ZIP requests its members in order. One fresh sibling observation gates one
 * concurrent set of opens; no directory observation survives between sets. */
export function archiveFileReader(
  adapter: PterodactylAdapter,
  id: string,
  entries: ArchiveEntry[],
  authorize: () => Promise<void>,
) {
  const files = entries.filter((entry) => entry.file.is_file);
  const buffered = new Map<string, Uint8Array<ArrayBuffer>>();
  let next = 0;
  return async (entry: ArchiveEntry, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> => {
    signal.throwIfAborted();
    await authorize();
    signal.throwIfAborted();
    const ready = buffered.get(entry.path);
    if (ready) {
      buffered.delete(entry.path);
      return bytesStream(ready);
    }
    if (files[next] !== entry) throw new DomainError('conflict');
    const directory = parent(entry.path);
    const wave = [entry];
    // Start the ZIP promptly and keep large bodies streaming under backpressure.
    if (next > 0 && entry.file.size <= smallFileBytes) {
      for (const sibling of files.slice(next + 1, next + concurrentSmallFiles)) {
        if (sibling.file.size > smallFileBytes || parent(sibling.path) !== directory) break;
        wave.push(sibling);
      }
    }
    next += wave.length;
    if (wave.length > 1 && typeof adapter.prefetchDownloads === 'function')
      await adapter.prefetchDownloads(
        id,
        wave.map((sibling) => sibling.path),
      );
    signal.throwIfAborted();
    if (directory) {
      const folder = await inspectFilePath(adapter, id, directory);
      if (!folder || folder.is_file) throw new DomainError('conflict');
    }
    const listing = new Map(
      (await adapter.listFiles(id, directory)).map((file) => [file.name, file]),
    );
    for (const sibling of wave) {
      if (!sameArchiveFile(sibling.file, listing.get(sibling.file.name)))
        throw new DomainError('conflict');
    }
    signal.throwIfAborted();
    if (wave.length === 1)
      return (
        await adapter.downloadFile(id, entry.path, {
          signal,
          authorize,
          refillGrant: false,
          maxBytes: entry.file.size,
        })
      ).body;

    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const results = await Promise.allSettled(
      wave.map(async (sibling) => {
        try {
          // The download adapter checks the current permission before it opens and while it reads.
          const source = await adapter.downloadFile(id, sibling.path, {
            signal: combined,
            refillGrant: false,
            authorize,
            maxBytes: sibling.file.size,
          });
          return [sibling.path, await readSmall(source.body, sibling.file.size, combined)] as const;
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      }),
    );
    signal.throwIfAborted();
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      buffered.set(...result.value);
    }
    await authorize();
    signal.throwIfAborted();
    const first = buffered.get(entry.path);
    if (!first) throw new DomainError('conflict');
    buffered.delete(entry.path);
    return bytesStream(first);
  };
}
