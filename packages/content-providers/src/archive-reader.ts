import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fromRandomAccessReader, type Options, RandomAccessReader, type ZipFile } from 'yauzl';
import { fail } from './contracts.js';

// yauzl reads each central-directory header and filename separately. A small
// read-ahead window turns tens of thousands of tiny disk reads into sequential
// reads, without loading the archive or replacing yauzl's ZIP/ZIP64 parser.
const windowBytes = 256 * 1024;
class ArchiveReader extends RandomAccessReader {
  private cache: Buffer = Buffer.alloc(0);
  private cacheStart = 0;

  constructor(
    private readonly file: FileHandle,
    private readonly size: number,
  ) {
    super();
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const file = this.file;
    // The ZIP reader owns the shared fd. Native fs streams close it when yauzl
    // destroys an individual member stream, even with autoClose disabled.
    return Readable.from(
      (async function* () {
        let position = start;
        while (position < end) {
          const bytes = Buffer.allocUnsafe(Math.min(windowBytes, end - position));
          const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
          if (!bytesRead) throw new Error('unexpected EOF');
          position += bytesRead;
          yield bytes.subarray(0, bytesRead);
        }
      })(),
      { objectMode: false, highWaterMark: windowBytes },
    );
  }

  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (error: Error | null) => void,
  ): void {
    void this.readRange(buffer, offset, length, position).then(
      () => callback(null),
      (error: unknown) => callback(error instanceof Error ? error : new Error('archive_read')),
    );
  }

  private async readRange(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      length < 0 ||
      position + length > this.size
    )
      throw new Error('unexpected EOF');
    if (position >= this.cacheStart && position + length <= this.cacheStart + this.cache.length) {
      this.cache.copy(
        buffer,
        offset,
        position - this.cacheStart,
        position - this.cacheStart + length,
      );
      return;
    }
    // ZIP header reads are bounded (filename, comment and extra fields each use
    // UInt16 lengths). Larger requests bypass the cache rather than growing it.
    const cached = length <= windowBytes;
    const bytes = cached
      ? Buffer.allocUnsafe(Math.min(windowBytes, this.size - position))
      : buffer.subarray(offset, offset + length);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await this.file.read(bytes, read, bytes.length - read, position + read);
      if (!bytesRead) throw new Error('unexpected EOF');
      read += bytesRead;
    }
    if (cached) {
      this.cache = bytes;
      this.cacheStart = position;
      bytes.copy(buffer, offset, 0, length);
    }
  }

  override close(callback: (error: Error | null) => void): void {
    this.cache = Buffer.alloc(0);
    void this.file.close().then(
      () => callback(null),
      (error: Error) => callback(error),
    );
  }
}

export async function openBufferedArchive(
  path: string,
  maxBytes: number,
  options: Options,
): Promise<ZipFile> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) fail('archive_size');
    return await new Promise<ZipFile>((resolve, reject) => {
      fromRandomAccessReader(
        new ArchiveReader(file, stat.size),
        stat.size,
        options,
        (error, zip) => (error || !zip ? reject(error ?? new Error('archive_open')) : resolve(zip)),
      );
    });
  } catch (error) {
    await file.close();
    throw error;
  }
}
