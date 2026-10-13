import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Already-authorized transport. Authentication belongs to the shared viewer session. */
export interface ViewerReadSource {
  size: number;
  mtimeMs: number;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  stream(start?: number, endExclusive?: number, signal?: AbortSignal): ReadableStream<Uint8Array>;
}

export class ViewerFormatError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ViewerFormatError';
  }
}

export function viewerNodeReadable(stream: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0]);
}

export interface ViewerCacheLease {
  path: string;
  size: number;
  release(): void;
}

interface CachedFile {
  size: number;
  references: number;
  lastUsed: number;
  path: string;
  controller: AbortController;
  ready: boolean;
  promise: Promise<void>;
}

/** Process-owned temporary files only. Never removes another run's files on startup. */
export class ViewerCache {
  readonly #files = new Map<string, CachedFile>();
  readonly #root: string;
  readonly #maxBytes: number;
  readonly #maxFileBytes: number;
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  #directory?: Promise<string>;
  #bytes = 0;
  #residualBytes = 0;
  #closed = false;
  #lock = Promise.resolve();

  get maxFileBytes(): number {
    return this.#maxFileBytes;
  }

  constructor(options: {
    root: string;
    maxBytes?: number;
    maxFileBytes?: number;
    maxEntries?: number;
    ttlMs?: number;
  }) {
    this.#root = resolve(options.root);
    this.#maxBytes = options.maxBytes ?? 1024 * 1024 * 1024;
    this.#maxFileBytes = options.maxFileBytes ?? 256 * 1024 * 1024;
    this.#maxEntries = options.maxEntries ?? 128;
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
    for (const value of [this.#maxBytes, this.#maxFileBytes, this.#maxEntries, this.#ttlMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('viewer_cache_config');
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const before = this.#lock;
    const gate = Promise.withResolvers<void>();
    this.#lock = gate.promise;
    await before;
    try {
      return await operation();
    } finally {
      gate.resolve();
    }
  }

  #ownedDirectory(): Promise<string> {
    this.#directory ??= (async () => {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      // Reject a configured root which resolves through an unexpected symlink.
      if ((await realpath(this.#root)) !== this.#root) throw new Error('viewer_cache_root');
      // Startup-only accounting: previous/crashed runs still consume the disk budget.
      // A recognizable marker proves scope for accounting, never permission to remove data.
      const directories = await readdir(this.#root, { withFileTypes: true });
      if (directories.length > 4096) throw new ViewerFormatError('viewer_cache_busy');
      for (const directory of directories) {
        if (!directory.isDirectory() || !directory.name.startsWith('viewer-')) continue;
        const path = join(this.#root, directory.name);
        const marker = join(path, '.nickhosting-viewer-cache.json');
        let recognized = false;
        try {
          const info = await lstat(marker);
          if (!info.isFile() || info.size > 512) continue;
          const value = JSON.parse(await readFile(marker, 'utf8')) as {
            format?: unknown;
            directory?: unknown;
          };
          recognized =
            value.format === 'nickhosting-viewer-cache-v1' && value.directory === directory.name;
        } catch (error) {
          if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT')
            continue;
          throw error;
        }
        if (!recognized) continue;
        const files = await readdir(path, { withFileTypes: true });
        if (files.length > 4096) throw new ViewerFormatError('viewer_cache_busy');
        for (const file of files) {
          if (!file.isFile() || file.name === '.nickhosting-viewer-cache.json') continue;
          this.#residualBytes += (await lstat(join(path, file.name))).size;
          if (!Number.isSafeInteger(this.#residualBytes))
            throw new ViewerFormatError('viewer_cache_busy');
        }
      }
      const directory = await mkdtemp(join(this.#root, 'viewer-'));
      await writeFile(
        join(directory, '.nickhosting-viewer-cache.json'),
        JSON.stringify({
          format: 'nickhosting-viewer-cache-v1',
          directory: basename(directory),
        }),
        { flag: 'wx', mode: 0o600 },
      );
      return directory;
    })();
    return this.#directory;
  }

  async #remove(key: string, file: CachedFile): Promise<void> {
    if (this.#files.get(key) !== file) return;
    this.#files.delete(key);
    this.#bytes -= file.size;
    await rm(file.path, { force: true });
  }

  async acquire(
    key: string,
    source: ViewerReadSource,
    signal?: AbortSignal,
  ): Promise<ViewerCacheLease> {
    return this.#acquire(key, source, signal, true);
  }

  async acquireGenerated(
    key: string,
    options: {
      maximumBytes: number;
      stream(signal: AbortSignal): ReadableStream<Uint8Array>;
    },
    signal?: AbortSignal,
  ): Promise<ViewerCacheLease> {
    return this.#acquire(
      key,
      {
        size: options.maximumBytes,
        mtimeMs: 0,
        read: async () => {
          throw new Error('generated_source_read');
        },
        stream: (_start, _end, downloadSignal) => options.stream(downloadSignal as AbortSignal),
      },
      signal,
      false,
    );
  }

  async #acquire(
    key: string,
    source: ViewerReadSource,
    signal: AbortSignal | undefined,
    exactSize: boolean,
  ): Promise<ViewerCacheLease> {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > this.#maxFileBytes)
      throw new ViewerFormatError('viewer_file_too_large');
    const file = await this.#exclusive(async () => {
      if (this.#closed) throw new ViewerFormatError('viewer_session_closed');
      const directory = await this.#ownedDirectory();
      const existing = this.#files.get(key);
      if (
        existing &&
        (!exactSize || existing.size === source.size) &&
        !existing.controller.signal.aborted
      ) {
        existing.references++;
        existing.lastUsed = Date.now();
        return existing;
      }
      const idle = [...this.#files.entries()]
        .filter(([, value]) => value.ready && value.references === 0)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [oldKey, old] of idle) {
        if (
          this.#residualBytes + this.#bytes + source.size <= this.#maxBytes &&
          this.#files.size < this.#maxEntries &&
          Date.now() - old.lastUsed < this.#ttlMs
        )
          break;
        await this.#remove(oldKey, old);
      }
      if (
        this.#residualBytes + this.#bytes + source.size > this.#maxBytes ||
        this.#files.size >= this.#maxEntries
      )
        throw new ViewerFormatError('viewer_cache_busy');
      // A key is a revision identity supplied by the central session, never a raw user filename.
      if (existing) throw new ViewerFormatError('viewer_revision_changed');
      const path = join(directory, randomUUID());
      const created: CachedFile = {
        size: source.size,
        references: 1,
        lastUsed: Date.now(),
        path,
        controller: new AbortController(),
        ready: false,
        promise: Promise.resolve(),
      };
      this.#files.set(key, created);
      this.#bytes += source.size;
      created.promise = this.#download(source, created, exactSize).catch(async (error: unknown) => {
        await this.#exclusive(() => this.#remove(key, created));
        throw error;
      });
      // A caller may disconnect before the shared download settles.
      void created.promise.catch(() => undefined);
      return created;
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      file.references--;
      file.lastUsed = Date.now();
      if (!file.ready && file.references === 0) file.controller.abort();
    };
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal?.reason ?? new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      await Promise.race([file.promise, aborted.promise]);
      return { path: file.path, size: file.size, release };
    } catch (error) {
      release();
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #download(source: ViewerReadSource, file: CachedFile, exactSize: boolean): Promise<void> {
    let received = 0;
    const bounds = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        done(
          received > source.size
            ? new ViewerFormatError(exactSize ? 'viewer_revision_changed' : 'viewer_file_too_large')
            : null,
          chunk,
        );
      },
      flush(done) {
        done(
          exactSize && received !== source.size
            ? new ViewerFormatError('viewer_revision_changed')
            : null,
        );
      },
    });
    await pipeline(
      viewerNodeReadable(source.stream(0, source.size, file.controller.signal)),
      bounds,
      createWriteStream(file.path, { flags: 'wx', mode: 0o600 }),
      { signal: file.controller.signal },
    );
    if (!exactSize)
      await this.#exclusive(async () => {
        this.#bytes -= file.size - received;
        file.size = received;
      });
    file.controller.signal.throwIfAborted();
    file.ready = true;
  }

  async close(): Promise<void> {
    await this.#exclusive(async () => {
      this.#closed = true;
      for (const file of this.#files.values()) file.controller.abort();
    });
    await Promise.allSettled([...this.#files.values()].map((file) => file.promise));
    await this.#exclusive(async () => {
      this.#files.clear();
      this.#bytes = 0;
      if (this.#directory)
        await this.#directory.then(
          (directory) => rm(directory, { recursive: true, force: true }),
          () => undefined,
        );
    });
  }
}

export function cachedFileSource(path: string, size: number, mtimeMs: number): ViewerReadSource {
  return {
    size,
    mtimeMs,
    async read(offset, length, signal) {
      const result: Buffer[] = [];
      if (length === 0) return new Uint8Array();
      for await (const part of createReadStream(path, {
        start: offset,
        end: offset + length - 1,
        signal,
      }))
        result.push(Buffer.from(part));
      return Buffer.concat(result);
    },
    stream(start = 0, endExclusive = size, signal) {
      if (endExclusive === start)
        return new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
      return Readable.toWeb(
        createReadStream(path, { start, end: endExclusive - 1, signal }),
      ) as ReadableStream<Uint8Array>;
    },
  };
}

/** One parsed index/connection per revision, shared across independently authorized requests. */
export class ViewerSessionCache<T> {
  readonly #entries = new Map<
    string,
    {
      promise: Promise<{ session: T; dispose(): Promise<void> }>;
      references: number;
      lastUsed: number;
      disposing?: Promise<void>;
      retired?: boolean;
    }
  >();
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #maximum: number;
  readonly #idleMs: number;
  #closed = false;
  #lock = Promise.resolve();
  constructor({ maximum = 16, idleMs = 60_000 }: { maximum?: number; idleMs?: number } = {}) {
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      !Number.isSafeInteger(idleMs) ||
      idleMs < 1
    )
      throw new Error('viewer_session_cache_config');
    this.#maximum = maximum;
    this.#idleMs = idleMs;
    this.#timer = setInterval(
      () => {
        void this.#expire().catch(() => undefined);
      },
      Math.min(idleMs, 10_000),
    );
    this.#timer.unref();
  }

  async #exclusive<R>(operation: () => Promise<R>): Promise<R> {
    const before = this.#lock;
    const gate = Promise.withResolvers<void>();
    this.#lock = gate.promise;
    await before;
    try {
      return await operation();
    } finally {
      gate.resolve();
    }
  }

  async #dispose(
    key: string,
    entry: {
      promise: Promise<{ session: T; dispose(): Promise<void> }>;
      disposing?: Promise<void>;
    },
  ): Promise<void> {
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
    entry.disposing ??= entry.promise.then(
      (value) => value.dispose(),
      () => undefined,
    );
    await entry.disposing;
  }

  async #expire(): Promise<void> {
    await this.#exclusive(async () => {
      for (const [key, entry] of this.#entries) {
        if (entry.references === 0 && Date.now() - entry.lastUsed >= this.#idleMs)
          await this.#dispose(key, entry);
      }
    });
  }

  async acquire(
    key: string,
    create: () => Promise<{ session: T; dispose(): Promise<void> }>,
    signal?: AbortSignal,
  ): Promise<{ session: T; release(): void }> {
    signal?.throwIfAborted();
    const entry = await this.#exclusive(async () => {
      if (this.#closed) throw new ViewerFormatError('viewer_session_closed');
      const previous = this.#entries.get(key);
      if (previous) {
        previous.references++;
        return previous;
      }
      if (this.#entries.size >= this.#maximum) {
        const idle = [...this.#entries.entries()]
          .filter(([, item]) => item.references === 0)
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (!idle) throw new ViewerFormatError('viewer_cache_busy');
        await this.#dispose(...idle);
      }
      const created = {
        promise: Promise.resolve().then(create),
        references: 1,
        lastUsed: Date.now(),
        retired: false,
      };
      this.#entries.set(key, created);
      void created.promise.catch(() => {
        if (this.#entries.get(key) === created) this.#entries.delete(key);
      });
      return created;
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.references--;
      entry.lastUsed = Date.now();
      if (entry.retired && entry.references === 0)
        void this.#dispose(key, entry).catch(() => undefined);
    };
    const cancellation = Promise.withResolvers<never>();
    const onAbort = () => cancellation.reject(signal?.reason ?? new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      const value = await Promise.race([entry.promise, cancellation.promise]);
      if (this.#closed) throw new ViewerFormatError('viewer_session_closed');
      return { session: value.session, release };
    } catch (error) {
      release();
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async invalidate(key: string): Promise<void> {
    await this.#exclusive(async () => {
      const entry = this.#entries.get(key);
      if (!entry) return;
      this.#entries.delete(key);
      entry.retired = true;
      if (entry.references === 0) await this.#dispose(key, entry);
    });
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    await this.#exclusive(async () => {
      this.#closed = true;
      await Promise.all(
        [...this.#entries.entries()].map(([key, entry]) => this.#dispose(key, entry)),
      );
    });
  }
}
