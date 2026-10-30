import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { readArchiveFile, visitArchive } from './archive.js';
import { prepareArchiveTransfer } from './archive-transfer.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function source(bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'nh-archive-transfer-'));
  roots.push(root);
  const path = join(root, 'source.zip');
  await writeFile(path, bytes);
  return {
    path,
    verification: { path, sha256: sha256(bytes), identity: await lstat(path, { bigint: true }) },
  };
}

async function zip(files: { path: string; bytes: Buffer; compress?: boolean }[]) {
  const archive = new ZipFile();
  for (const file of files)
    archive.addBuffer(file.bytes, file.path, { compress: file.compress ?? true, mode: 0o100600 });
  archive.end();
  const chunks: Buffer[] = [];
  for await (const chunk of archive.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function consume(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks);
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
}

// Independent tiny ZIP writer permits deliberately inconsistent headers/payloads.
function malformed(options: {
  checksum?: number;
  size?: number;
  truncate?: boolean;
  trailing?: boolean;
}) {
  const payload = Buffer.from('region bytes '.repeat(100));
  let compressed = deflateRawSync(payload);
  if (options.truncate) compressed = compressed.subarray(0, -1);
  if (options.trailing) compressed = Buffer.concat([compressed, Buffer.from('trailing')]);
  const name = Buffer.from('source');
  const checksum = options.checksum ?? crc32(payload);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(options.size ?? payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(options.size ?? payload.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, end]);
}

describe('sanitized streaming ZIP transfer', () => {
  it('copies stored/deflated bytes without recompression, preserves UTF-8 names and verifies the completed output', async () => {
    const first = Buffer.from('level metadata');
    const second = Buffer.from('region bytes '.repeat(1000));
    const input = await source(
      await zip([
        { path: 'wrapper/level.dat', bytes: first, compress: false },
        { path: 'wrapper/region.mca', bytes: second },
        { path: 'wrapper/session.lock', bytes: Buffer.from('omit') },
      ]),
    );
    const transfer = await prepareArchiveTransfer(
      input.path,
      [
        { source: 'wrapper/level.dat', target: 'mondo/level.dat' },
        { source: 'wrapper/region.mca', target: 'mondo/region/é.mca' },
      ],
      input,
    );
    expect(transfer.files).toEqual([
      { path: 'mondo/level.dat', size: first.length },
      { path: 'mondo/region/é.mca', size: second.length },
    ]);
    const output = await consume(transfer.open());
    expect(output.length).toBe(transfer.contentLength);
    expect(() => transfer.open()).toThrow();
    expect(await transfer.completion).toEqual({
      files: [
        { path: 'mondo/level.dat', size: first.length, sha256: sha256(first) },
        { path: 'mondo/region/é.mca', size: second.length, sha256: sha256(second) },
      ],
      bytes: first.length + second.length,
    });
    const bodies: Buffer[] = [];
    const compressed = new Map<string, Buffer>();
    await visitArchive(input.path, async (file) => {
      const chunks: Buffer[] = [];
      for await (const chunk of await file.openRaw()) chunks.push(Buffer.from(chunk));
      compressed.set(file.path, Buffer.concat(chunks));
    });
    const outputPaths: string[] = [];
    await visitArchive(output, async (file) => {
      outputPaths.push(file.path);
      expect(file.entry.generalPurposeBitFlag).toBe(0x800);
      expect(file.entry.externalFileAttributes >>> 16).toBe(0o100644);
      expect(file.entry.extraFields).toEqual([]);
      bodies.push(await readArchiveFile(file, 1024 * 1024));
      const chunks: Buffer[] = [];
      for await (const chunk of await file.openRaw()) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(
        compressed.get(
          file.path.endsWith('level.dat') ? 'wrapper/level.dat' : 'wrapper/region.mca',
        ),
      );
    });
    expect(outputPaths).toEqual(['mondo/level.dat', 'mondo/region/é.mca']);
    expect(bodies).toEqual([first, second]);
  });

  it.each([
    { checksum: 1 },
    { checksum: 0 },
    { size: 0 },
    { size: 1299 },
    { size: 1301 },
    { truncate: true },
    { trailing: true },
  ])('rejects malformed entry %j before publishing a complete ZIP', async (options) => {
    const input = await source(malformed(options));
    const transfer = await prepareArchiveTransfer(
      input.path,
      [{ source: 'source', target: 'world/file' }],
      input,
    );
    const reader = transfer.open().getReader();
    const chunks: Buffer[] = [];
    await expect(
      (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          chunks.push(Buffer.from(next.value));
        }
      })(),
    ).rejects.toThrow();
    reader.releaseLock();
    await expect(transfer.completion).rejects.toThrow();
    expect(Buffer.concat(chunks).includes(Buffer.from('504b0506', 'hex'))).toBe(false);
  });

  it('explicitly rejects a stored entry CRC mismatch, including zero', async () => {
    for (const checksum of [0, 1]) {
      const bytes = await zip([
        { path: 'source', bytes: Buffer.from('stored data'), compress: false },
      ]);
      const central = bytes.indexOf(Buffer.from('504b0102', 'hex'));
      bytes.writeUInt32LE(checksum, 14);
      bytes.writeUInt32LE(checksum, central + 16);
      const input = await source(bytes);
      const transfer = await prepareArchiveTransfer(
        input.path,
        [{ source: 'source', target: 'target' }],
        input,
      );
      await expect(consume(transfer.open())).rejects.toThrow();
      await expect(transfer.completion).rejects.toThrow();
    }
  });

  it.each([
    [{ source: 'a', target: '../escape' }],
    [{ source: 'a', target: 'dir/' }],
    [
      { source: 'a', target: 'x' },
      { source: 'b', target: 'x/y' },
    ],
    [
      { source: 'a', target: 'X/a' },
      { source: 'b', target: 'x/b' },
    ],
    [
      { source: 'a', target: 'x' },
      { source: 'b', target: 'X' },
    ],
    [
      { source: 'a', target: 'x' },
      { source: 'a', target: 'y' },
    ],
    [{ source: 'missing', target: 'x' }],
  ])('rejects ambiguous or unsafe mappings %j', async (...mappings) => {
    const input = await source(
      await zip([
        { path: 'a', bytes: Buffer.from('a') },
        { path: 'b', bytes: Buffer.from('b') },
      ]),
    );
    await expect(prepareArchiveTransfer(input.path, mappings, input)).rejects.toThrow();
  });

  it('checks the immutable source seal before preparation and again before streaming', async () => {
    const input = await source(await zip([{ path: 'source', bytes: Buffer.from('a') }]));
    const mappings = [{ source: 'source', target: 'target' }];
    const transfer = await prepareArchiveTransfer(input.path, mappings, input);
    await writeFile(input.path, await zip([{ path: 'source', bytes: Buffer.from('changed') }]));
    await expect(prepareArchiveTransfer(input.path, mappings, input)).rejects.toThrow();
    await expect(consume(transfer.open())).rejects.toThrow();
    await expect(transfer.completion).rejects.toThrow();
  });

  it('rejects ZIP64 sentinel sizes explicitly so callers can select a different transport', async () => {
    const input = await source(malformed({ size: 0xffffffff }));
    await expect(
      prepareArchiveTransfer(input.path, [{ source: 'source', target: 'target' }], {
        ...input,
        limits: { maxCompressionRatio: Number.MAX_SAFE_INTEGER },
      }),
    ).rejects.toMatchObject({ details: { contentReason: 'archive_zip64' } });
  });

  it('validates budgets for omitted entries and refuses a proof for a different source', async () => {
    const input = await source(
      await zip([
        { path: 'source', bytes: Buffer.from('a') },
        { path: 'omitted', bytes: Buffer.alloc(10000) },
      ]),
    );
    await expect(
      prepareArchiveTransfer(input.path, [{ source: 'source', target: 'target' }], {
        ...input,
        limits: { maxExpandedBytes: 1000 },
      }),
    ).rejects.toThrow();
    await expect(
      prepareArchiveTransfer(input.path, [{ source: 'source', target: 'target' }], {
        verification: { ...input.verification, path: `${input.path}.other` },
      }),
    ).rejects.toThrow();
  });

  it('rejects a source modified during streaming before producing the central directory', async () => {
    const bytes = randomBytes(2 * 1024 * 1024);
    const input = await source(await zip([{ path: 'source', bytes, compress: false }]));
    const transfer = await prepareArchiveTransfer(
      input.path,
      [{ source: 'source', target: 'target' }],
      input,
    );
    const reader = transfer.open().getReader();
    await reader.read();
    // Rewrite identical bytes: metadata identity, rather than a repeated whole-file hash,
    // must reject even this same-size mutation.
    await writeFile(input.path, await readFile(input.path));
    await expect(
      (async () => {
        while (!(await reader.read()).done) {}
      })(),
    ).rejects.toThrow();
    reader.releaseLock();
    await expect(transfer.completion).rejects.toThrow();
  });

  it('releases sources and rejects completion when a consumer cancels under backpressure', async () => {
    const input = await source(
      await zip([{ path: 'source', bytes: randomBytes(2 * 1024 * 1024) }]),
    );
    const transfer = await prepareArchiveTransfer(
      input.path,
      [{ source: 'source', target: 'target' }],
      input,
    );
    const reader = transfer.open().getReader();
    await reader.read();
    await reader.cancel(new Error('upload authorization revoked'));
    await expect(transfer.completion).rejects.toThrow();
    reader.releaseLock();
  });

  it('supports cancellation before dispatch, including an external authorization signal', async () => {
    const input = await source(await zip([{ path: 'source', bytes: Buffer.from('a') }]));
    const controller = new AbortController();
    const transfer = await prepareArchiveTransfer(
      input.path,
      [{ source: 'source', target: 'target' }],
      { ...input, signal: controller.signal },
    );
    controller.abort(new Error('permission revoked'));
    expect(() => transfer.open()).toThrow('permission revoked');
    await expect(transfer.completion).rejects.toThrow('permission revoked');
  });
});
