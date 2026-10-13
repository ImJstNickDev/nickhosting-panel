import { Worker } from 'node:worker_threads';
import { type ViewerCache, ViewerFormatError, type ViewerReadSource } from './viewer-cache.js';
import { sqliteViewerWorker } from './viewer-sqlite-worker.js';

export interface ViewerSqliteSource extends ViewerReadSource {
  restat(): Promise<{ size: number; mtimeMs: number }>;
  siblingExists(suffix: '-wal' | '-shm' | '-journal'): Promise<boolean>;
}
export type ViewerSqliteCell =
  | { type: 'null'; value: null }
  | { type: 'integer'; value: string }
  | { type: 'real'; value: number }
  | { type: 'text'; value: string; truncated: boolean }
  | { type: 'blob'; bytes: number };
export interface ViewerSqlitePage {
  columns: { name: string; type: string; nullable: boolean; primaryKey: boolean }[];
  rows: ViewerSqliteCell[][];
  offset: number;
  nextOffset: number | null;
}
export interface ViewerSqliteSession {
  /** Stable size/mtime and quick_check cannot certify a live application transaction snapshot. */
  consistency: 'unverified' | 'provider-snapshot';
  /** Worker failure/timeout invalidates a retained session immediately. */
  closedSignal: AbortSignal;
  tables(): { name: string }[];
  rows(
    options: { table: string; offset?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<ViewerSqlitePage>;
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
    worker = new Worker(`(${sqliteViewerWorker.toString()})();`, {
      eval: true,
      workerData: { path: lease.path },
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
      closedSignal: closedController.signal,
      tables() {
        if (closed) throw new ViewerFormatError('viewer_session_closed');
        return initial.tables;
      },
      async rows({ table, offset = 0, limit = 100 }, signal) {
        if (closed) throw new ViewerFormatError('viewer_session_closed');
        signal?.throwIfAborted();
        const id = nextId++;
        const result = wait<ViewerSqlitePage>(id, signal);
        activeWorker.postMessage({ id, table, offset, limit });
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
