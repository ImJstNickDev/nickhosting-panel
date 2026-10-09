import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { type Entry, fromBuffer, open, type ZipFile } from 'yauzl';
import { type ContentLimits, contentLimits, fail, safeArchivePath } from './contracts.js';

export interface ArchiveFile {
  path: string;
  size: number;
  entry: Entry;
  open: () => Promise<Readable>;
}
/** Lazy processing bounds memory, while checking every entry, including ignored client overrides. */
export async function visitArchive(
  path: string | Uint8Array,
  visit: (file: ArchiveFile) => Promise<void>,
  options: Partial<ContentLimits> = {},
): Promise<void> {
  const limits = contentLimits(options);
  if (typeof path === 'string') {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limits.maxArchiveBytes)
      fail('archive_size');
  } else if (path.byteLength > limits.maxArchiveBytes) fail('archive_size');
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    const config = {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true,
      strictFileNames: true,
    };
    const done = (error: Error | null, value: ZipFile | undefined) =>
      error || !value ? reject(error ?? new Error('archive_open')) : resolve(value);
    if (typeof path === 'string') open(path, config, done);
    // Copy the bounded buffer so a caller cannot change entry bytes during validation.
    else fromBuffer(Buffer.from(path), config, done);
  });
  let total = 0;
  let count = 0;
  const seen = new Set<string>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          const name = safeArchivePath(entry.fileName);
          const key = name.replace(/\/$/, '').toLowerCase();
          if (seen.has(key)) fail('archive_duplicate');
          seen.add(key);
          const type = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (type !== 0 && type !== 0x8000 && type !== 0x4000) fail('archive_special_file');
          if ((entry.generalPurposeBitFlag & 1) !== 0) fail('archive_encrypted');
          if (![0, 8].includes(entry.compressionMethod)) fail('archive_compression');
          count++;
          total += entry.uncompressedSize;
          if (
            count > limits.maxEntries ||
            total > limits.maxExpandedBytes ||
            entry.uncompressedSize > limits.maxFileBytes ||
            (entry.uncompressedSize > 0 &&
              entry.uncompressedSize / Math.max(entry.compressedSize, 1) >
                limits.maxCompressionRatio)
          )
            fail('archive_budget');
          if (name.endsWith('/')) {
            if (entry.uncompressedSize !== 0) fail('archive_directory');
            return;
          }
          if (type === 0x4000) fail('archive_directory');
          await visit({
            path: name,
            size: entry.uncompressedSize,
            entry,
            open: () =>
              new Promise<Readable>((r, j) =>
                zip.openReadStream(entry, (e, s) =>
                  e || !s ? j(e ?? new Error('archive_stream')) : r(s),
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
/** Fabric declares an authoritative environment; Forge displayTest is NOT a side guarantee. */
export async function inspectJarSide(
  path: string,
  limits: Partial<ContentLimits> = {},
): Promise<JarSide> {
  const observations: JarSide[] = [];
  await visitArchive(
    path,
    async (file) => {
      if (file.path === 'fabric.mod.json') {
        const metadata = JSON.parse(
          (await readArchiveFile(file, contentLimits(limits).maxMetadataBytes)).toString('utf8'),
        ) as { environment?: unknown };
        if (metadata.environment === 'client') observations.push('client');
        else if (
          metadata.environment === 'server' ||
          metadata.environment === '*' ||
          metadata.environment === undefined
        )
          observations.push('server');
        else fail('jar_environment');
      }
      // Quilt/Forge/Paper metadata needs a reviewed loader-specific classifier, not a guessed side.
    },
    limits,
  );
  if (observations.includes('client')) return 'client';
  return observations.includes('server') ? 'server' : 'unknown';
}
