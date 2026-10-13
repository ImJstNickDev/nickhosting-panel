import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createGunzip, createZstdDecompress } from 'node:zlib';
import { extract } from 'tar-stream';
import { type Entry, fromRandomAccessReaderPromise, RandomAccessReader } from 'yauzl';
import { parseSevenZipListing, runSevenZipViewer } from './viewer-archive-sevenzip.js';
import {
  cachedFileSource,
  type ViewerCache,
  type ViewerCacheLease,
  ViewerFormatError,
  type ViewerReadSource,
  viewerNodeReadable,
} from './viewer-cache.js';

export interface ViewerArchiveEntry {
  path: string;
  name: string;
  directory: boolean;
  size: number;
  modifiedAt: string | null;
}
export type ViewerArchiveFormat =
  | 'zip'
  | 'tar'
  | 'tar.gz'
  | 'tar.zst'
  | 'tar.bz2'
  | 'tar.xz'
  | '7z'
  | 'rar';
export interface ViewerArchiveSession {
  format: ViewerArchiveFormat;
  list(options?: { directory?: string; offset?: number; limit?: number; query?: string }): {
    entries: ViewerArchiveEntry[];
    total: number;
    nextOffset: number | null;
  };
  open(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ size: number; stream: ReadableStream<Uint8Array> }>;
  close(): void;
}
export interface ViewerArchiveLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
  maxCompressionRatio: number;
  maxMetadataBytes: number;
  maxWasmInputBytes: number;
  maxWasmEntryBytes: number;
}
const defaultLimits: ViewerArchiveLimits = {
  maxEntries: 25_000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 1000,
  maxMetadataBytes: 16 * 1024 * 1024,
  maxWasmInputBytes: 64 * 1024 * 1024,
  maxWasmEntryBytes: 64 * 1024 * 1024,
};

export function viewerArchivePath(input: string): string {
  const clean = input.replace(/\/$/, '');
  if (
    !clean ||
    clean.length > 1024 ||
    clean.startsWith('/') ||
    clean.includes('\\') ||
    clean.includes(':') ||
    [...clean].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    clean.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new ViewerFormatError('viewer_archive_path');
  return clean;
}

/** Small coalesced range cache prevents one remote SFTP request per ZIP header. */
class ZipSource extends RandomAccessReader {
  readonly #blocks = new Map<number, Promise<Uint8Array>>();
  constructor(
    readonly source: ViewerReadSource,
    readonly signal: AbortSignal,
  ) {
    super();
  }
  override _readStreamForRange(start: number, end: number): Readable {
    return viewerNodeReadable(this.source.stream(start, end, this.signal));
  }
  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    done: (error: Error | null) => void,
  ): void {
    void (async () => {
      this.signal.throwIfAborted();
      const blockSize = 256 * 1024;
      let copied = 0;
      while (copied < length) {
        const absolute = position + copied;
        const start = Math.floor(absolute / blockSize) * blockSize;
        let block = this.#blocks.get(start);
        if (!block) {
          block = this.source.read(
            start,
            Math.min(blockSize, this.source.size - start),
            this.signal,
          );
          this.#blocks.set(start, block);
          if (this.#blocks.size > 4)
            this.#blocks.delete(this.#blocks.keys().next().value as number);
        }
        const bytes = await block;
        const within = absolute - start;
        const count = Math.min(length - copied, bytes.length - within);
        if (count <= 0) throw new ViewerFormatError('viewer_archive_truncated');
        buffer.set(bytes.subarray(within, within + count), offset + copied);
        copied += count;
      }
    })().then(
      () => done(null),
      (error: unknown) => done(error instanceof Error ? error : new Error('archive_read')),
    );
  }
}

class ArchiveIndex {
  readonly entries = new Map<string, ViewerArchiveEntry>();
  readonly #explicit = new Set<string>();
  #children?: Map<string, ViewerArchiveEntry[]>;
  #expanded = 0;
  #metadata = 0;
  constructor(readonly limits: ViewerArchiveLimits) {}
  add(entry: ViewerArchiveEntry): void {
    this.#children = undefined;
    if (this.#explicit.has(entry.path)) throw new ViewerFormatError('viewer_archive_duplicate');
    this.#explicit.add(entry.path);
    this.#expanded += entry.size;
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > this.limits.maxEntryBytes ||
      this.#expanded > this.limits.maxExpandedBytes
    )
      throw new ViewerFormatError('viewer_archive_budget');
    const parts = entry.path.split('/');
    for (let length = 1; length < parts.length; length++) {
      const path = parts.slice(0, length).join('/');
      const old = this.entries.get(path);
      if (old && !old.directory) throw new ViewerFormatError('viewer_archive_duplicate');
      if (!old)
        this.#insert({
          path,
          name: parts[length - 1] as string,
          directory: true,
          size: 0,
          modifiedAt: null,
        });
    }
    const previous = this.entries.get(entry.path);
    if (previous && (!previous.directory || !entry.directory))
      throw new ViewerFormatError('viewer_archive_duplicate');
    this.#insert(entry);
  }
  #insert(entry: ViewerArchiveEntry) {
    if (!this.entries.has(entry.path)) this.#metadata += Buffer.byteLength(entry.path) + 160;
    this.entries.set(entry.path, entry);
    if (this.entries.size > this.limits.maxEntries || this.#metadata > this.limits.maxMetadataBytes)
      throw new ViewerFormatError('viewer_archive_budget');
  }
  list({
    directory = '',
    offset = 0,
    limit = 200,
    query = '',
  }: {
    directory?: string;
    offset?: number;
    limit?: number;
    query?: string;
  } = {}) {
    if (directory) {
      directory = viewerArchivePath(directory);
      if (!this.entries.get(directory)?.directory)
        throw new ViewerFormatError('viewer_archive_not_found');
    }
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new ViewerFormatError('viewer_page_invalid');
    if (!this.#children) {
      this.#children = new Map();
      for (const entry of this.entries.values()) {
        const parent = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/')));
        const siblings = this.#children.get(parent) ?? [];
        siblings.push(entry);
        this.#children.set(parent, siblings);
      }
      for (const siblings of this.#children.values())
        siblings.sort(
          (a, b) =>
            Number(b.directory) - Number(a.directory) ||
            a.name.localeCompare(b.name, 'en', { numeric: true }),
        );
    }
    const siblings = this.#children.get(directory) ?? [];
    const search = query.slice(0, 256).toLowerCase();
    const children = search
      ? siblings.filter((entry) => entry.name.toLowerCase().includes(search))
      : siblings;
    return {
      entries: children.slice(offset, offset + limit),
      total: children.length,
      nextOffset: offset + limit < children.length ? offset + limit : null,
    };
  }
}

export async function createArchiveViewer(
  source: ViewerReadSource,
  options: {
    name: string;
    key: string;
    cache: ViewerCache;
    signal?: AbortSignal;
    limits?: Partial<ViewerArchiveLimits>;
  },
): Promise<ViewerArchiveSession> {
  const limits = { ...defaultLimits, ...options.limits };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('viewer_archive_config');
  }
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const name = options.name.toLowerCase();
  if (name.endsWith('.7z') || name.endsWith('.rar'))
    return createSevenZipViewer(source, {
      ...options,
      limits,
      format: name.endsWith('.7z') ? '7z' : 'rar',
      signal,
      controller,
    });
  if (name.endsWith('.zip') || name.endsWith('.jar')) {
    const zip = await fromRandomAccessReaderPromise(new ZipSource(source, signal), source.size, {
      lazyEntries: true,
      autoClose: false,
      strictFileNames: true,
      validateEntrySizes: true,
    });
    const index = new ArchiveIndex(limits);
    const zipEntries = new Map<string, Entry>();
    try {
      for await (const entry of zip.eachEntry()) {
        signal.throwIfAborted();
        const path = viewerArchivePath(entry.fileName);
        const type = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (![0, 0x4000, 0x8000].includes(type))
          throw new ViewerFormatError('viewer_archive_special_file');
        if (entry.isEncrypted()) throw new ViewerFormatError('viewer_archive_encrypted');
        if (![0, 8].includes(entry.compressionMethod))
          throw new ViewerFormatError('viewer_archive_compression');
        if (entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.maxCompressionRatio)
          throw new ViewerFormatError('viewer_archive_budget');
        const directory = entry.fileName.endsWith('/');
        if ((directory && entry.uncompressedSize !== 0) || (!directory && type === 0x4000))
          throw new ViewerFormatError('viewer_archive_special_file');
        const date = entry.getLastModDate();
        index.add({
          path,
          name: path.split('/').at(-1) as string,
          size: entry.uncompressedSize,
          directory,
          modifiedAt: Number.isFinite(date.getTime()) ? date.toISOString() : null,
        });
        if (!directory) zipEntries.set(path, entry);
      }
    } catch (error) {
      controller.abort();
      zip.close();
      throw error;
    }
    return {
      format: 'zip',
      list: (page) => {
        signal.throwIfAborted();
        return index.list(page);
      },
      async open(path, requestSignal) {
        signal.throwIfAborted();
        const entry = zipEntries.get(viewerArchivePath(path));
        if (!entry) throw new ViewerFormatError('viewer_archive_not_found');
        const stream = await zip.openReadStreamPromise(entry);
        const operationSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
        let length = 0;
        let checksum = 0;
        const checked = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            length += chunk.length;
            checksum = crc32(chunk, checksum);
            done(
              length > entry.uncompressedSize
                ? new ViewerFormatError('viewer_archive_integrity')
                : null,
              chunk,
            );
          },
          flush(done) {
            done(
              length !== entry.uncompressedSize || checksum !== entry.crc32
                ? new ViewerFormatError('viewer_archive_integrity')
                : null,
            );
          },
        });
        void pipeline(stream, checked, { signal: operationSignal }).catch(() => undefined);
        return {
          size: entry.uncompressedSize,
          stream: Readable.toWeb(checked) as ReadableStream<Uint8Array>,
        };
      },
      close() {
        controller.abort();
        zip.close();
      },
    };
  }
  const format = name.endsWith('.tar')
    ? 'tar'
    : name.endsWith('.tar.gz') || name.endsWith('.tgz')
      ? 'tar.gz'
      : name.endsWith('.tar.zst')
        ? 'tar.zst'
        : name.endsWith('.tar.bz2')
          ? 'tar.bz2'
          : name.endsWith('.tar.xz')
            ? 'tar.xz'
            : null;
  if (!format) throw new ViewerFormatError('viewer_archive_unsupported');
  return createTarViewer(source, { ...options, limits, format, signal, controller });
}

async function createSevenZipViewer(
  source: ViewerReadSource,
  options: {
    key: string;
    cache: ViewerCache;
    limits: ViewerArchiveLimits;
    format: '7z' | 'rar';
    signal: AbortSignal;
    controller: AbortController;
  },
): Promise<ViewerArchiveSession> {
  if (source.size > options.limits.maxWasmInputBytes)
    throw new ViewerFormatError('viewer_archive_budget');
  const lease = await options.cache.acquire(
    `${options.key}:sevenzip-source`,
    source,
    options.signal,
  );
  const index = new ArchiveIndex(options.limits);
  try {
    const listing = parseSevenZipListing(
      await runSevenZipViewer(lease.path, {
        maximumInputBytes: options.limits.maxWasmInputBytes,
        maximumOutputBytes: options.limits.maxMetadataBytes,
        signal: options.signal,
      }),
    );
    for (const record of listing) {
      const path = viewerArchivePath(record.Path as string);
      if (
        record['Symbolic Link'] ||
        record['Hard Link'] ||
        /\s[lbcps]/.test(record.Attributes ?? '')
      )
        throw new ViewerFormatError('viewer_archive_special_file');
      if (record.Encrypted === '+') throw new ViewerFormatError('viewer_archive_encrypted');
      const directory = record.Folder === '+' || record.Attributes?.startsWith('D') === true;
      const size = Number(record.Size);
      if (directory && size !== 0) throw new ViewerFormatError('viewer_archive_special_file');
      index.add({
        path,
        name: path.split('/').at(-1) as string,
        size,
        directory,
        modifiedAt: null,
      });
    }
    return {
      format: options.format,
      list: (page) => {
        options.signal.throwIfAborted();
        return index.list(page);
      },
      async open(path, requestSignal) {
        options.signal.throwIfAborted();
        const item = index.entries.get(viewerArchivePath(path));
        if (!item || item.directory) throw new ViewerFormatError('viewer_archive_not_found');
        if (item.size > options.limits.maxWasmEntryBytes)
          throw new ViewerFormatError('viewer_archive_budget');
        const signal = requestSignal
          ? AbortSignal.any([options.signal, requestSignal])
          : options.signal;
        const decoded = await options.cache.acquireGenerated(
          `${options.key}:sevenzip-entry:${path}`,
          {
            maximumBytes: Math.max(1, item.size),
            stream(downloadSignal) {
              return new ReadableStream({
                async start(controller) {
                  try {
                    const bytes = await runSevenZipViewer(lease.path, {
                      entry: path,
                      maximumInputBytes: options.limits.maxWasmInputBytes,
                      maximumOutputBytes: item.size,
                      signal: AbortSignal.any([downloadSignal, options.signal]),
                    });
                    controller.enqueue(bytes);
                    controller.close();
                  } catch (error) {
                    controller.error(error);
                  }
                },
              });
            },
          },
          signal,
        );
        const reader = cachedFileSource(decoded.path, decoded.size, source.mtimeMs)
          .stream(0, decoded.size, signal)
          .getReader();
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            decoded.release();
          }
        };
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const result = await reader.read();
              if (result.done) {
                release();
                controller.close();
              } else controller.enqueue(result.value);
            } catch (error) {
              release();
              controller.error(error);
            }
          },
          async cancel(reason) {
            release();
            await reader.cancel(reason);
          },
        });
        return { size: item.size, stream };
      },
      close() {
        options.controller.abort();
        lease.release();
      },
    };
  } catch (error) {
    options.controller.abort();
    lease.release();
    throw error;
  }
}

async function createTarViewer(
  source: ViewerReadSource,
  options: {
    key: string;
    cache: ViewerCache;
    limits: ViewerArchiveLimits;
    format: 'tar' | 'tar.gz' | 'tar.zst' | 'tar.bz2' | 'tar.xz';
    signal: AbortSignal;
    controller: AbortController;
  },
): Promise<ViewerArchiveSession> {
  const decode = options.format === 'tar' ? undefined : await createTarDecoder(options.format);
  const index = new ArchiveIndex(options.limits);
  const offsets = new Map<string, { offset: number; size: number }>();
  let lease: ViewerCacheLease | undefined;
  let expandedSource = source;
  try {
    if (options.format !== 'tar') {
      // The compression format is sequential. Cache one bounded decoded TAR, never one file per entry.
      lease = await options.cache.acquireGenerated(
        `${options.key}:tar-decoded`,
        {
          maximumBytes: Math.min(
            options.cache.maxFileBytes,
            options.limits.maxExpandedBytes,
            Math.max(source.size, 1) * options.limits.maxCompressionRatio,
          ),
          stream(signal) {
            const remote = source.stream(0, source.size, signal);
            if (!decode) throw new ViewerFormatError('viewer_archive_format');
            return decode(remote, signal);
          },
        },
        options.signal,
      );
      expandedSource = cachedFileSource(lease.path, lease.size, source.mtimeMs);
    }
    // tar-stream handles PAX/GNU metadata; v3.2.2 exposes the decoded data offset on each header.
    const parser = extract();
    parser.on('entry', (header, stream, next) => {
      try {
        if (
          (header.name === '.' || header.name === './') &&
          header.type === 'directory' &&
          !header.size
        ) {
          stream.on('end', next);
          stream.resume();
          return;
        }
        const path = viewerArchivePath(header.name.replace(/^\.\//, ''));
        if (header.type !== 'file' && header.type !== 'directory')
          throw new ViewerFormatError('viewer_archive_special_file');
        const size = header.size ?? 0;
        if (header.type === 'directory' && size !== 0)
          throw new ViewerFormatError('viewer_archive_special_file');
        index.add({
          path,
          name: path.split('/').at(-1) as string,
          directory: header.type === 'directory',
          size,
          modifiedAt:
            header.mtime && Number.isFinite(header.mtime.getTime())
              ? header.mtime.toISOString()
              : null,
        });
        if (header.type === 'file') {
          const offset = (header as typeof header & { byteOffset: number }).byteOffset;
          if (!Number.isSafeInteger(offset) || offset < 512 || offset + size > expandedSource.size)
            throw new ViewerFormatError('viewer_archive_truncated');
          offsets.set(path, { offset, size });
        }
        stream.on('error', (error) => parser.destroy(error));
        stream.on('end', next);
        stream.resume();
      } catch (error) {
        parser.destroy(error instanceof Error ? error : new Error('archive_entry'));
      }
    });
    await pipeline(
      viewerNodeReadable(expandedSource.stream(0, expandedSource.size, options.signal)),
      parser,
      { signal: options.signal },
    );
    return {
      format: options.format,
      list: (page) => {
        options.signal.throwIfAborted();
        return index.list(page);
      },
      async open(path, requestSignal) {
        options.signal.throwIfAborted();
        const entry = offsets.get(viewerArchivePath(path));
        if (!entry) throw new ViewerFormatError('viewer_archive_not_found');
        const signal = requestSignal
          ? AbortSignal.any([options.signal, requestSignal])
          : options.signal;
        return {
          size: entry.size,
          stream: expandedSource.stream(entry.offset, entry.offset + entry.size, signal),
        };
      },
      close() {
        options.controller.abort();
        lease?.release();
      },
    };
  } catch (error) {
    options.controller.abort();
    lease?.release();
    throw error;
  }
}

/** Shared streaming decoder; callers impose their own expanded-size and disk budgets. */
export async function createTarDecoder(format: 'tar.gz' | 'tar.zst' | 'tar.bz2' | 'tar.xz') {
  const xz = format === 'tar.xz' ? await import('xz-decompress') : undefined;
  const bzip2 = format === 'tar.bz2' ? (await import('unbzip2-stream')).default : undefined;
  return (remote: ReadableStream<Uint8Array>, signal?: AbortSignal): ReadableStream<Uint8Array> => {
    if (xz) return new xz.XzReadableStream(remote);
    const compressed = viewerNodeReadable(remote);
    const decoder = format === 'tar.gz' ? createGunzip() : bzip2 ? bzip2() : createZstdDecompress();
    void pipeline(compressed, decoder, { signal }).catch(() => undefined);
    const readable = decoder instanceof Readable ? decoder : new Readable().wrap(decoder);
    return Readable.toWeb(readable) as ReadableStream<Uint8Array>;
  };
}
