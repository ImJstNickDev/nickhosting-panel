import { createReadStream } from 'node:fs';
import { basename, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { DomainError } from '@nickhosting/core';
import type {
  PterodactylAdapter,
  ServerFile,
  UploadProxyOptions,
} from '@nickhosting/pterodactyl-adapter';
import type { reserveUploadIngestion } from '@nickhosting/server-management';
import type { StagedFile } from './file-operations.js';
import { inspectFilePath } from './file-path-inspection.js';

type Claim = Pick<
  Awaited<ReturnType<typeof reserveUploadIngestion>>,
  'complete' | 'rejectBeforeDispatch' | 'unlock'
>;
type Send = (input: UploadProxyOptions) => Promise<void>;

export async function publishExtractedFiles(options: {
  adapter: PterodactylAdapter;
  id: string;
  destination: string;
  files: StagedFile[];
  concurrency: number;
  batchBytes: number;
  signal: AbortSignal;
  authorize: () => Promise<void>;
  guard: (paths: string[]) => Promise<void>;
  reserve: (bytes: number, largest: number, count: number) => Promise<Claim>;
  completed: () => void;
}) {
  const { adapter, id, destination, signal, authorize, files } = options;
  const directories = new Set([destination]);
  const baseDepth = destination.split('/').length;
  const join = (path: string) => [destination, path].join('/');
  async function requireDirectory(path: string) {
    const entry = await inspectFilePath(adapter, id, path);
    if (!entry || entry.is_file) throw new DomainError('conflict');
  }
  async function ensureDirectory(path: string) {
    const parts = path.split('/');
    for (let depth = baseDepth + 1; depth <= parts.length; depth++) {
      const child = parts.slice(0, depth).join('/');
      if (directories.has(child)) continue;
      await authorize();
      const parent = dirname(child);
      await requireDirectory(parent);
      signal.throwIfAborted();
      await adapter.createDirectory(id, parent, basename(child));
      directories.add(child);
    }
  }
  async function publish(group: StagedFile[], directory: string): Promise<void> {
    const targets = group.map((file) => join(file.path));
    const names = new Set(group.map((file) => basename(file.path).toLowerCase()));
    const readDirectory = async (path: string) => {
      if (path !== directory) throw new DomainError('conflict');
      await requireDirectory(path);
      const entries = await adapter.listFiles(id, path);
      if (entries.some((entry) => names.has(entry.name.toLowerCase())))
        throw new DomainError('conflict');
      return entries;
    };
    await options.guard(targets);
    let claim: Claim;
    try {
      claim = await options.reserve(
        group.reduce((sum, file) => sum + file.size, 0),
        Math.max(...group.map((file) => file.size)),
        group.length,
      );
    } catch (error) {
      // A group may exceed current temporary disk headroom while its members
      // still fit individually. Only split a rejected, unreserved admission.
      if (
        group.length < 2 ||
        !(error instanceof DomainError) ||
        !(
          error.code === 'resources_unavailable' ||
          (error.code === 'validation_failed' && error.status === 413)
        )
      )
        throw error;
      const mid = Math.ceil(group.length / 2);
      await publish(group.slice(0, mid), directory);
      await publish(group.slice(mid), directory);
      return;
    }
    let dispatched = false;
    try {
      signal.throwIfAborted();
      await authorize();
      let planning: Promise<ServerFile[]> | undefined;
      const preparation = {
        signal,
        authorize,
        readDirectory: (path: string) => (planning ??= readDirectory(path)),
      };
      const batch =
        group.length > 1 && typeof adapter.prepareUploadBatch === 'function'
          ? await adapter.prepareUploadBatch(id, targets, preparation)
          : null;
      let sends: Send[];
      if (batch) sends = batch.uploads;
      else if (typeof adapter.prepareUpload === 'function') {
        const prepared = await Promise.allSettled(
          targets.map((target) => adapter.prepareUpload(id, target, preparation)),
        );
        sends = prepared.map((result) => {
          if (result.status === 'rejected') throw result.reason;
          return result.value;
        });
      } else
        sends = targets.map(
          (target) => (input) =>
            adapter.uploadFile(id, target, { ...input, readDirectory: preparation.readDirectory }),
        );
      if (sends.length !== group.length) throw new DomainError('conflict');
      // Do not carry preflight listings or credentials across batches. Grants
      // and claims may take time; check current permissions, parents and names
      // one last time before starting this group of independent publications.
      await authorize();
      await readDirectory(directory);
      signal.throwIfAborted();
      dispatched = true;
      const results = await Promise.allSettled(
        sends.map(async (send, i) => {
          const file = group[i];
          if (!file) throw new DomainError('conflict');
          const body = Readable.toWeb(createReadStream(file.local)) as ReadableStream<Uint8Array>;
          try {
            await send({ body, contentLength: file.size, maxBytes: file.size, signal, authorize });
            options.completed();
          } finally {
            if (!body.locked) await body.cancel().catch(() => {});
          }
        }),
      );
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      await claim.complete();
    } catch (error) {
      if (!dispatched) await claim.rejectBeforeDispatch();
      throw error;
    } finally {
      await claim.unlock();
    }
  }
  let group: StagedFile[] = [],
    bytes = 0,
    parent = '';
  async function flush() {
    if (!group.length) return;
    await publish(group, parent);
    group = [];
    bytes = 0;
  }
  for (const file of files) {
    signal.throwIfAborted();
    const target = join(file.path);
    const directory = file.directory ? target : dirname(target);
    if (
      file.directory ||
      parent !== directory ||
      group.length >= Math.min(options.concurrency, 4) ||
      bytes + file.size > options.batchBytes
    )
      await flush();
    await ensureDirectory(directory);
    if (file.directory) {
      options.completed();
      continue;
    }
    parent = directory;
    bytes += file.size;
    group.push(file);
  }
  await flush();
}
