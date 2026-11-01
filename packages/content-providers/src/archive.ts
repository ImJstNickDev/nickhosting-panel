import { createHash } from 'node:crypto';
import { pipeline, type Readable, Transform } from 'node:stream';
import { crc32, createInflateRaw } from 'node:zlib';
import { type Entry, fromBuffer, type ZipFile } from 'yauzl';
import { openBufferedArchive } from './archive-reader.js';
import { type ContentLimits, contentLimits, fail, safeArchivePath } from './contracts.js';

export interface ArchiveFile {
  path: string;
  size: number;
  entry: Entry;
  open: (options?: { inflateChunkSize?: number }) => Promise<Readable>;
  /** Exact compressed member bytes. The caller must independently validate decoded size/CRC. */
  openRaw: () => Promise<Readable>;
}
async function openArchiveEntry(
  zip: ZipFile,
  entry: Entry,
  options: { inflateChunkSize?: number } = {},
): Promise<Readable> {
  const chunkSize = options.inflateChunkSize;
  if (
    chunkSize !== undefined &&
    (!Number.isSafeInteger(chunkSize) || chunkSize < 16 * 1024 || chunkSize > 1024 * 1024)
  )
    fail('archive_chunk_size');
  const inflate = chunkSize !== undefined && entry.compressionMethod === 8;
  const source = await new Promise<Readable>((resolve, reject) =>
    zip.openReadStream(entry, inflate ? { decompress: false } : {}, (error, stream) =>
      error || !stream ? reject(error ?? new Error('archive_stream')) : resolve(stream),
    ),
  );
  if (!inflate) return source;
  // yauzl defaults to 16KiB inflation output. Larger bounded chunks avoid thousands of
  // zlib callbacks for region files, while keeping size validation and cancellation intact.
  let size = 0;
  const output = new Transform({
    highWaterMark: chunkSize,
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > entry.uncompressedSize ? new Error('archive_size') : null, chunk);
    },
    flush(callback) {
      callback(size !== entry.uncompressedSize ? new Error('archive_size') : null);
    },
  });
  // The returned stream retains the pipeline error for its consumer; cancellation destroys
  // the inflater and ZIP reader as well. The callback consumes pipeline completion only.
  pipeline(source, createInflateRaw({ chunkSize }), output, () => {});
  return output;
}
/** Lazy processing bounds memory, while checking every entry, including ignored client overrides. */
export async function visitArchive(
  path: string | Uint8Array,
  visit: (file: ArchiveFile) => Promise<void>,
  options: Partial<ContentLimits> = {},
  visitDirectory?: (path: string) => Promise<void>,
): Promise<void> {
  return visitZip(path, visit, options, visitDirectory);
}
/** Metadata inspection never extracts opaque JAR entries onto a filesystem.
 * Only selected root records need extraction policy and ambiguity checks. */
async function visitZip(
  path: string | Uint8Array,
  visit: (file: ArchiveFile) => Promise<void>,
  options: Partial<ContentLimits>,
  visitDirectory?: (path: string) => Promise<void>,
  metadataNames?: ReadonlySet<string>,
): Promise<void> {
  const limits = contentLimits(options);
  if (typeof path !== 'string' && path.byteLength > limits.maxArchiveBytes) fail('archive_size');
  const config = {
    lazyEntries: true,
    autoClose: false,
    validateEntrySizes: true,
    strictFileNames: true,
  };
  const zip =
    typeof path === 'string'
      ? await openBufferedArchive(path, limits.maxArchiveBytes, config)
      : await new Promise<ZipFile>((resolve, reject) => {
          // Copy the bounded buffer so a caller cannot change entry bytes during validation.
          fromBuffer(Buffer.from(path), config, (error, value) =>
            error || !value ? reject(error ?? new Error('archive_open')) : resolve(value),
          );
        });
  let total = 0;
  let count = 0;
  const maxEntries = metadataNames ? limits.maxJarEntries : limits.maxEntries;
  const seen = new Set<string>();
  try {
    if (zip.entryCount > maxEntries) fail('archive_budget');
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          count++;
          if (count > maxEntries) fail('archive_budget');
          // Valid JARs can contain case-sensitive resource names and repeated
          // unrelated META-INF records. They are not files we will extract.
          if (metadataNames && !metadataNames.has(entry.fileName)) return;
          const name = safeArchivePath(entry.fileName);
          const key = name.replace(/\/$/, '').toLowerCase();
          if (seen.has(key)) fail('archive_duplicate');
          seen.add(key);
          const type = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (type !== 0 && type !== 0x8000 && type !== 0x4000) fail('archive_special_file');
          if ((entry.generalPurposeBitFlag & 1) !== 0) fail('archive_encrypted');
          if (![0, 8].includes(entry.compressionMethod)) fail('archive_compression');
          total += entry.uncompressedSize;
          if (
            total > limits.maxExpandedBytes ||
            entry.uncompressedSize > limits.maxFileBytes ||
            (entry.uncompressedSize > 0 &&
              entry.uncompressedSize / Math.max(entry.compressedSize, 1) >
                limits.maxCompressionRatio)
          )
            fail('archive_budget');
          if (name.endsWith('/')) {
            if (entry.uncompressedSize !== 0) fail('archive_directory');
            await visitDirectory?.(name);
            return;
          }
          if (type === 0x4000) fail('archive_directory');
          await visit({
            path: name,
            size: entry.uncompressedSize,
            entry,
            open: (options) => openArchiveEntry(zip, entry, options),
            openRaw: () =>
              new Promise<Readable>((resolve, reject) =>
                zip.openReadStream(
                  entry,
                  entry.compressionMethod === 8 ? { decompress: false } : {},
                  (error, stream) =>
                    error || !stream
                      ? reject(error ?? new Error('archive_stream'))
                      : resolve(stream),
                ),
              ),
          });
        })().then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}
export async function readArchiveFile(file: ArchiveFile, maxBytes: number): Promise<Buffer> {
  if (file.size > maxBytes) fail('metadata_size');
  const chunks: Buffer[] = [];
  let size = 0;
  let checksum = 0;
  const stream = await file.open();
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes || size > file.size) {
      stream.destroy();
      fail('metadata_size');
    }
    checksum = crc32(buffer, checksum);
    chunks.push(buffer);
  }
  if (size !== file.size || checksum !== file.entry.crc32) fail('archive_integrity');
  return Buffer.concat(chunks);
}
export async function hashArchiveFile(file: ArchiveFile): Promise<string> {
  const hash = createHash('sha256');
  let size = 0;
  let checksum = 0;
  const stream = await file.open();
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > file.size) {
      stream.destroy();
      fail('archive_integrity');
    }
    hash.update(buffer);
    checksum = crc32(buffer, checksum);
  }
  if (size !== file.size || checksum !== file.entry.crc32) fail('archive_integrity');
  return hash.digest('hex');
}
export type JarSide = 'server' | 'client' | 'unknown';
export type JarEnvironment = JarSide | 'both';
export interface JarMetadata {
  environment: JarEnvironment;
  fabric?: { id: string; version?: string };
}
/** One existing bounded archive pass supplies side and runtime identity; no extra read per mod. */
export async function inspectJarMetadata(
  path: string,
  limits: Partial<ContentLimits> = {},
): Promise<JarMetadata> {
  const observations: JarEnvironment[] = [];
  let fabric: JarMetadata['fabric'];
  await visitZip(
    path,
    async (file) => {
      if (file.path === 'fabric.mod.json') {
        const metadata = JSON.parse(
          (await readArchiveFile(file, contentLimits(limits).maxMetadataBytes)).toString('utf8'),
        ) as { environment?: unknown; id?: unknown; version?: unknown };
        if (metadata.id !== undefined) {
          if (typeof metadata.id !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(metadata.id))
            fail('jar_mod_id');
          fabric = {
            id: metadata.id,
            ...(typeof metadata.version === 'string' && metadata.version.length <= 512
              ? { version: metadata.version }
              : {}),
          };
        }
        if (metadata.environment === 'client') observations.push('client');
        else if (metadata.environment === 'server') observations.push('server');
        else if (metadata.environment === '*' || metadata.environment === undefined)
          observations.push('both');
        else fail('jar_environment');
      }
      // Quilt/Forge/Paper metadata needs a reviewed loader-specific classifier, not a guessed side.
    },
    limits,
    undefined,
    new Set(['fabric.mod.json']),
  );
  const environment: JarEnvironment = observations.includes('client')
    ? 'client'
    : observations.includes('server')
      ? 'server'
      : observations.includes('both')
        ? 'both'
        : 'unknown';
  return { environment, ...(fabric ? { fabric } : {}) };
}
/** Fabric environment evidence; Forge displayTest is not a side guarantee. */
export async function inspectJarEnvironment(
  path: string,
  limits: Partial<ContentLimits> = {},
): Promise<JarEnvironment> {
  return (await inspectJarMetadata(path, limits)).environment;
}
/** Historical strict staging callers only distinguish server-capable from client-only. */
export async function inspectJarSide(
  path: string,
  limits: Partial<ContentLimits> = {},
): Promise<JarSide> {
  const environment = await inspectJarEnvironment(path, limits);
  return environment === 'both' ? 'server' : environment;
}
