import {
  createArchiveViewer,
  type ViewerArchiveEntry,
  type ViewerArchiveSession,
  viewerArchivePath,
} from './viewer-archive.js';
import {
  cachedFileSource,
  type ViewerCache,
  ViewerFormatError,
  type ViewerReadSource,
  ViewerSessionCache,
} from './viewer-cache.js';

export function archiveChain(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4 || value.some((item) => typeof item !== 'string'))
    throw new ViewerFormatError('viewer_archive_path');
  return value.map(viewerArchivePath);
}

/** One root index and bounded lazy child indexes. Only opened nested containers
 * are materialized; folders and pagination stay metadata-only. */
export class ViewerArchiveTree {
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  readonly children = new ViewerSessionCache<ViewerArchiveSession>({ maximum: 8 });
  constructor(
    readonly root: ViewerArchiveSession,
    readonly options: {
      key: string;
      cache: ViewerCache;
      signal: AbortSignal;
      mtimeMs: number;
    },
  ) {
    this.#signal = AbortSignal.any([options.signal, this.#controller.signal]);
  }
  async acquire(
    chain: string[],
    signal?: AbortSignal,
  ): Promise<{ session: ViewerArchiveSession; release(): void }> {
    archiveChain(chain);
    this.#signal.throwIfAborted();
    signal?.throwIfAborted();
    if (!chain.length) return { session: this.root, release() {} };
    const key = JSON.stringify(chain);
    // Acquire ancestors before entering this cache's creation/disposal path.
    // Shutdown must never wait for a factory that is waiting for the same lock.
    const parent = await this.acquire(chain.slice(0, -1), this.#signal);
    let adopted = false;
    try {
      return await this.children.acquire(
        key,
        async () => {
          // The shared creation belongs to the root lease, not its first HTTP caller.
          adopted = true;
          let materialized: Awaited<ReturnType<ViewerCache['acquire']>> | undefined;
          try {
            const name = chain.at(-1);
            if (!name) throw new ViewerFormatError('viewer_archive_path');
            // Delay opening the decoder until the cache actually needs the bytes.
            const selected = selectArchiveEntries(parent.session, [name]);
            const entry = selected.find((entry) => entry.path === name);
            if (!entry || entry.directory) throw new ViewerFormatError('viewer_archive_not_found');
            const source: ViewerReadSource = {
              size: entry.size,
              mtimeMs: this.options.mtimeMs,
              read: async () => {
                throw new Error('archive_materialization_read');
              },
              stream: (_start, _end, readSignal) => {
                let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
                return new ReadableStream<Uint8Array>({
                  async pull(controller) {
                    readSignal?.throwIfAborted();
                    reader ??= (await parent.session.open(name, readSignal)).stream.getReader();
                    const next = await reader.read();
                    if (next.done) {
                      reader.releaseLock();
                      controller.close();
                    } else controller.enqueue(next.value);
                  },
                  async cancel() {
                    await reader?.cancel().catch(() => {});
                  },
                });
              },
            };
            materialized = await this.options.cache.acquire(
              `${this.options.key}:nested:${key}`,
              source,
              this.#signal,
            );
            const file = materialized;
            const session = await createArchiveViewer(
              cachedFileSource(file.path, file.size, this.options.mtimeMs),
              {
                name,
                key: `${this.options.key}:nested:${key}`,
                cache: this.options.cache,
                signal: this.#signal,
              },
            );
            return {
              session,
              dispose: async () => {
                session.close();
                file.release();
              },
            };
          } catch (error) {
            materialized?.release();
            throw error;
          } finally {
            parent.release();
          }
        },
        signal,
      );
    } finally {
      if (!adopted) parent.release();
    }
  }
  async close() {
    this.#controller.abort(new ViewerFormatError('viewer_session_closed'));
    this.root.close();
    await this.children.close();
  }
}

/** Selection is resolved against the retained immutable index, without provider
 * listings. Ancestor selections subsume their descendants; names remain relative
 * to the visible directory when assembling a ZIP. */
export function selectArchiveEntries(
  session: ViewerArchiveSession,
  paths: string[],
  directory = '',
): ViewerArchiveEntry[] {
  if (!paths.length || paths.length > 25_000) throw new ViewerFormatError('viewer_page_invalid');
  const prefix = directory ? `${viewerArchivePath(directory)}/` : '';
  const selected = [...new Set(paths.map(viewerArchivePath))];
  if (selected.some((path) => !path.startsWith(prefix) || path === directory))
    throw new ViewerFormatError('viewer_archive_path');
  const result = new Map<string, ViewerArchiveEntry>();
  const listings = new Map<string, Map<string, ViewerArchiveEntry>>();
  const list = (folder: string) => {
    let entries = listings.get(folder);
    if (!entries) {
      entries = new Map();
      let offset = 0;
      while (true) {
        const page = session.list({ directory: folder, offset, limit: 500 });
        for (const entry of page.entries) entries.set(entry.path, entry);
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      listings.set(folder, entries);
    }
    return entries;
  };
  const pending: ViewerArchiveEntry[] = [];
  for (const path of selected) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const entry = list(parent).get(path);
    if (!entry) throw new ViewerFormatError('viewer_archive_not_found');
    pending.push(entry);
  }
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    if (result.has(entry.path)) continue;
    result.set(entry.path, entry);
    if (result.size > 25_000) throw new ViewerFormatError('viewer_archive_budget');
    if (entry.directory) pending.push(...list(entry.path).values());
  }
  return [...result.values()].sort((a, b) => a.path.localeCompare(b.path));
}
