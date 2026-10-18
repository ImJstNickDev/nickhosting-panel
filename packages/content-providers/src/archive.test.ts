import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { visitArchive } from './archive.js';

async function archive(bytes: Buffer, compress = true): Promise<Buffer> {
  const zip = new ZipFile();
  zip.addBuffer(bytes, 'region.mca', { compress });
  zip.end();
  const chunks: Buffer[] = [];
  await pipeline(
    zip.outputStream,
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
  );
  return Buffer.concat(chunks);
}

describe('bounded archive inflation', () => {
  it.each([false, true])(
    'reads exact stored/deflated bytes (compressed=%s)',
    async (compressed) => {
      const expected = randomBytes(512 * 1024);
      const bytes = await archive(expected, compressed);
      const chunks: Buffer[] = [];
      await visitArchive(bytes, async (file) => {
        for await (const chunk of await file.open({ inflateChunkSize: 256 * 1024 }))
          chunks.push(chunk);
      });
      expect(Buffer.concat(chunks)).toEqual(expected);
      if (compressed)
        expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeGreaterThan(16 * 1024);
    },
  );

  it.each([1, 1024 * 1024 + 1, Number.NaN])(
    'rejects an unbounded inflation chunk size (%s)',
    async (inflateChunkSize) => {
      const bytes = await archive(Buffer.from('fixture'));
      await expect(
        visitArchive(bytes, async (file) => {
          await file.open({ inflateChunkSize });
        }),
      ).rejects.toThrow();
    },
  );

  it.each([-1, 1])(
    'rejects inflated size differing from the declaration by %s',
    async (difference) => {
      const payload = randomBytes(256 * 1024);
      const bytes = await archive(payload);
      const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      expect(central).toBeGreaterThan(0);
      bytes.writeUInt32LE(payload.length + difference, central + 24);
      await expect(
        visitArchive(bytes, async (file) => {
          await pipeline(
            await file.open({ inflateChunkSize: 256 * 1024 }),
            new Writable({
              write(_chunk, _encoding, callback) {
                callback();
              },
            }),
          );
        }),
      ).rejects.toThrow('archive_size');
    },
  );

  it('cancels the complete inflation pipeline when its consumer aborts', async () => {
    const bytes = await archive(randomBytes(2 * 1024 ** 2));
    const controller = new AbortController();
    let received = 0;
    await expect(
      visitArchive(bytes, async (file) => {
        const stream = await file.open({ inflateChunkSize: 256 * 1024 });
        await pipeline(
          stream,
          new Writable({
            write(chunk: Buffer, _encoding, callback) {
              received += chunk.length;
              controller.abort();
              callback();
            },
          }),
          { signal: controller.signal },
        );
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThan(2 * 1024 ** 2);
  });

  it('propagates invalid DEFLATE data without leaving the reader running', async () => {
    const bytes = await archive(randomBytes(64 * 1024));
    const dataStart = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
    bytes[dataStart] = 0x07; // Reserved DEFLATE block type.
    await expect(
      visitArchive(bytes, async (file) => {
        await pipeline(
          await file.open({ inflateChunkSize: 256 * 1024 }),
          new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
        );
      }),
    ).rejects.toMatchObject({ code: 'Z_DATA_ERROR' });
  });
});
