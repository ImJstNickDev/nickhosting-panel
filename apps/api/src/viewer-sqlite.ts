import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type {
  DatagridCell,
  DatagridCellDetail,
  DatagridColumn,
  DatagridQuery,
} from '@nickhosting/game-sdk/ui';
import { type ViewerCache, ViewerFormatError, type ViewerReadSource } from './viewer-cache.js';

export interface ViewerSqliteSource extends ViewerReadSource {
  restat(): Promise<{ size: number; mtimeMs: number }>;
  siblingExists(suffix: '-wal' | '-shm' | '-journal'): Promise<boolean>;
}
export type ViewerSqliteCell = DatagridCell;
export type ViewerSqliteCellQuery = DatagridQuery & {
  rowOffset: number;
  column: string;
  revision: string;
  start?: number;
};
export interface ViewerSqlitePage {
  columns: DatagridColumn[];
  rows: ViewerSqliteCell[][];
  offset: number;
  nextOffset: number | null;
}
export interface ViewerSqliteSession {
  /** Stable size/mtime and quick_check cannot certify a live application transaction snapshot. */
  consistency: 'unverified' | 'provider-snapshot';
  revision: string;
  /** Worker failure/timeout invalidates a retained session immediately. */
  closedSignal: AbortSignal;
  tables(): { name: string }[];
  rows(options: DatagridQuery, signal?: AbortSignal): Promise<ViewerSqlitePage>;
  cell(options: ViewerSqliteCellQuery, signal?: AbortSignal): Promise<DatagridCellDetail>;
  close(): Promise<void>;
}

export async function openSqliteViewer(
  source: ViewerSqliteSource,
  options: {
    key: string;
    cache: ViewerCache;
    signal?: AbortSignal;
    queryTimeoutMs?: number;
    providerSnapshot?: boolean;
  },
): Promise<ViewerSqliteSession> {
  options.signal?.throwIfAborted();
  const [header, sidecars] = await Promise.all([
    source.read(0, Math.min(100, source.size), options.signal),
    Promise.all(
      ['-wal', '-shm', '-journal'].map((suffix) =>
        source.siblingExists(suffix as '-wal' | '-shm' | '-journal'),
      ),
    ),
  ]);
  if (
    header.length < 100 ||
    Buffer.from(header.subarray(0, 16)).toString('binary') !== 'SQLite format 3\0'
  )
    throw new ViewerFormatError('viewer_sqlite_invalid');
  if (header[18] === 2 || header[19] === 2 || sidecars.some(Boolean))
    throw new ViewerFormatError('viewer_sqlite_wal');
  const lease = await options.cache.acquire(`${options.key}:sqlite`, source, options.signal);
  let worker: Worker | undefined;
  try {
    const after = await source.restat();
    if (after.size !== source.size || after.mtimeMs !== source.mtimeMs)
      throw new ViewerFormatError('viewer_sqlite_changed');
    // The standalone module runs with Node's native TypeScript stripping in source
    // checkouts and emitted JavaScript in runtime builds. Never serialize tsx output.
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const revision = createHash('sha256').update(options.key).digest('hex');
    worker = new Worker(new URL(`./viewer-sqlite-worker.${extension}`, import.meta.url), {
      execArgv: [],
      workerData: { path: lease.path, revision },
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    const timeout = options.queryTimeoutMs ?? 3000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000)
      throw new Error('viewer_sqlite_config');
    type Pending = { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void };
    const pending = new Map<number, Pending>();
    const closedController = new AbortController();
    let closed = false;
    let nextId = 1;
    const activeWorker = worker;
    const fail = (error: unknown) => {
      for (const item of pending.values()) {
        item.cleanup();
        item.reject(error);
      }
      pending.clear();
    };
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        closed = true;
        closedController.abort();
        options.signal?.removeEventListener('abort', onAbort);
        fail(new ViewerFormatError('viewer_session_closed'));
        await activeWorker.terminate();
        lease.release();
      })();
      return closePromise;
    };
    const onAbort = () => {
      void close();
    };
    const wait = <T>(id: number, signal?: AbortSignal): Promise<T> =>
      new Promise((resolve, reject) => {
        if (closed || signal?.aborted) {
          reject(new ViewerFormatError('viewer_session_closed'));
          return;
        }
        const abort = () => {
          // The query runs in one shared worker. Cancel this subscriber only,
          // retaining the deadline until its in-flight query has actually ended.
          signal?.removeEventListener('abort', abort);
          reject(signal?.reason ?? new ViewerFormatError('viewer_session_closed'));
        };
        const timer = setTimeout(() => {
          fail(new ViewerFormatError('viewer_sqlite_timeout'));
          void close();
        }, timeout);
        timer.unref();
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        };
        signal?.addEventListener('abort', abort, { once: true });
        pending.set(id, { resolve: (value) => resolve(value as T), reject, cleanup });
      });
    activeWorker.on('message', (message: { id: number; error?: string; result?: unknown }) => {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      item.cleanup();
      if (message.error) item.reject(new ViewerFormatError(message.error));
      else item.resolve(message.result);
    });
    activeWorker.once('error', () => {
      fail(new ViewerFormatError('viewer_sqlite_unavailable'));
      void close();
    });
    activeWorker.once('exit', () => {
      if (!closed) {
        fail(new ViewerFormatError('viewer_sqlite_unavailable'));
        void close();
      }
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const initial = await wait<{ tables: { name: string }[] }>(0, options.signal);
    return {
      consistency: options.providerSnapshot ? 'provider-snapshot' : 'unverified',
      revision,
      closedSignal: closedController.signal,
      tables() {
        if (closed) throw new ViewerFormatError('viewer_session_closed');
        return initial.tables;
      },
      async rows({ offset = 0, limit = 100, ...query }, signal) {
        if (closed) throw new ViewerFormatError('viewer_session_closed');
        signal?.throwIfAborted();
        const id = nextId++;
        const result = wait<ViewerSqlitePage>(id, signal);
        activeWorker.postMessage({ ...query, id, operation: 'rows', offset, limit });
        return result;
      },
      async cell(query, signal) {
        if (closed) throw new ViewerFormatError('viewer_session_closed');
        signal?.throwIfAborted();
        if (query.revision !== revision) throw new ViewerFormatError('viewer_sqlite_changed');
        const id = nextId++;
        const result = wait<DatagridCellDetail>(id, signal);
        activeWorker.postMessage({ ...query, id, operation: 'cell', start: query.start ?? 0 });
        return result;
      },
      close,
    };
  } catch (error) {
    await worker?.terminate();
    lease.release();
    throw error;
  }
}
