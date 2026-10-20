import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import {
  createArchiveViewer,
  type ViewerArchiveLimits,
  viewerArchivePath,
} from './viewer-archive.js';
import { rar5, tarBz2, tarXz } from './viewer-archive-fixtures.js';
import { runSevenZipViewer, streamSevenZipViewer } from './viewer-archive-sevenzip.js';
import { ViewerCache, type ViewerReadSource } from './viewer-cache.js';

const cleanup: (() => Promise<void>)[] = [];
const require = createRequire(import.meta.url);
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((action) => action()));
});
async function setup(bytes: Buffer, name: string, limits?: Partial<ViewerArchiveLimits>) {
  const root = await mkdtemp(join(tmpdir(), 'nh-viewer-archive-'));
  const cache = new ViewerCache({ root });
  const source: ViewerReadSource = {
    size: bytes.length,
    mtimeMs: 1,
    read: vi.fn(async (offset, length) => bytes.subarray(offset, offset + length)),
    stream: vi.fn(
      (start = 0, end = bytes.length) =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.subarray(start, end));
            controller.close();
          },
        }),
    ),
  };
  cleanup.push(async () => {
    await cache.close();
    await rm(root, { recursive: true, force: true });
  });
  const viewer = await createArchiveViewer(source, { name, cache, key: name, limits });
  cleanup.push(async () => viewer.close());
  return { viewer, source };
}
async function zip(entries: [string, string][]) {
  const result = new ZipFile();
  for (const [name, contents] of entries) result.addBuffer(Buffer.from(contents), name);
  result.end();
  const chunks: Buffer[] = [];
  for await (const chunk of result.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function tar(symlink = false) {
  const result = pack();
  result.entry({ name: './', type: 'directory' });
  result.entry({ name: 'folder/', type: 'directory' });
  result.entry({ name: 'folder/hello.txt' }, 'hello');
  result.entry({ name: 'folder/deeper/test.json' }, '{"good":true}');
  if (symlink) result.entry({ name: 'bad', type: 'symlink', linkname: '/etc/passwd' });
  result.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of result) {
    if (!(chunk instanceof Uint8Array)) throw new Error('fixture_chunk');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
describe('archive virtual folders', () => {
  it.each(['example.jar.disabled', 'example.jar.pending', 'container.unknown'])(
    'recognizes ZIP bytes with an unknown filename suffix: %s',
    async (name) => {
      const { viewer, source } = await setup(
        await zip([['fabric.mod.json', '{"id":"example"}']]),
        name,
      );
      expect(viewer.format).toBe('zip');
      expect(source.read).toHaveBeenCalledWith(0, 4, expect.any(AbortSignal));
      expect(await new Response((await viewer.open('fabric.mod.json')).stream).text()).toBe(
        '{"id":"example"}',
      );
    },
  );
  it('rejects non-ZIP bytes under an unknown suffix', async () => {
    await expect(
      setup(Buffer.from('not a zip file'), 'example.jar.disabled'),
    ).rejects.toMatchObject({ code: 'viewer_archive_unsupported' });
  });
  it('reads ZIP/JAR index with coalesced ranges and opens only the selected entry', async () => {
    const bytes = await zip(
      Array.from({ length: 1000 }, (_, index) => [`folder/${index}.txt`, `entry ${index}`]),
    );
    const { viewer, source } = await setup(bytes, 'test.jar');
    expect(viewer.list().entries).toMatchObject([{ name: 'folder', directory: true }]);
    expect(viewer.list({ directory: 'folder', limit: 10 })).toMatchObject({
      total: 1000,
      nextOffset: 10,
    });
    expect(vi.mocked(source.read).mock.calls.length).toBeLessThan(10);
    const entry = await viewer.open('folder/999.txt');
    expect(await new Response(entry.stream).text()).toBe('entry 999');
    expect(source.stream).toHaveBeenCalledTimes(1);
  });
  it.each(['tar', 'tgz', 'tar.zst'])(
    'opens a selected entry in %s and keeps its parent index',
    async (format) => {
      const raw = await tar();
      const bytes =
        format === 'tgz' ? gzipSync(raw) : format === 'tar.zst' ? zstdCompressSync(raw) : raw;
      const { viewer } = await setup(bytes, `files.${format}`);
      expect(viewer.list({ directory: 'folder' }).entries.map((entry) => entry.name)).toEqual([
        'deeper',
        'hello.txt',
      ]);
      expect(await new Response((await viewer.open('folder/hello.txt')).stream).text()).toBe(
        'hello',
      );
      expect(await new Response((await viewer.open('folder/deeper/test.json')).stream).text()).toBe(
        '{"good":true}',
      );
    },
  );
  it.each([
    ['tar.xz', tarXz],
    ['tar.bz2', tarBz2],
  ])('streams %s into the bounded decoded cache', async (name, fixture) => {
    const { viewer } = await setup(Buffer.from(fixture as string, 'base64'), `files.${name}`);
    expect(await new Response((await viewer.open('folder/hello.txt')).stream).text()).toBe('hello');
  });
  it('reads a real RAR5 fixture through the isolated decoder', async () => {
    const { viewer } = await setup(Buffer.from(rar5, 'base64'), 'stored.rar');
    expect(viewer.list().entries[0]).toMatchObject({ name: 'helloworld.txt', size: 29 });
    expect(await new Response((await viewer.open('helloworld.txt')).stream).text()).toBe(
      'hello libarchive test suite!\n',
    );
  });
  it('lists and reads a 7z LZMA2 archive without extracting files to the server', async () => {
    const factory = require('sevenzip-wasm') as (options: object) => Promise<{
      FS: { writeFile(path: string, bytes: Uint8Array): void; readFile(path: string): Uint8Array };
      callMain(args: string[]): number;
    }>;
    const module = await factory({ print() {}, printErr() {} });
    module.FS.writeFile('/hello.txt', Buffer.from('hello 7z'));
    expect(module.callMain(['a', '-t7z', '/fixture.7z', '/hello.txt'])).toBe(0);
    const { viewer } = await setup(Buffer.from(module.FS.readFile('/fixture.7z')), 'fixture.7z');
    expect(viewer.list().entries).toMatchObject([{ name: 'hello.txt', size: 8 }]);
    expect(await new Response((await viewer.open('hello.txt')).stream).text()).toBe('hello 7z');
  });
  it.each([
    ['gz', gzipSync('hello single stream\n')],
    ['zst', zstdCompressSync('hello single stream\n')],
    [
      'bz2',
      Buffer.from(
        'QlpoOTFBWSZTWdZaNnQAAARRgAAQQAAi55wAIAAxAAAImjGpmh+nSTJFkA33MQaLuSKcKEhrLRs6AA==',
        'base64',
      ),
    ],
    [
      'xz',
      Buffer.from(
        '/Td6WFoAAATm1rRGAgAhARYAAAB0L+WjAQATaGVsbG8gc2luZ2xlIHN0cmVhbQoAt1wO6WCEq/8AASwU+AptAx+2830BAAAAAARZWg==',
        'base64',
      ),
    ],
  ] as const)(
    'exposes %s as a cached virtual file with its visible name',
    async (format, bytes) => {
      const { viewer, source } = await setup(bytes, `logs/hello.txt.${format}`);
      expect(viewer.format).toBe(format);
      expect(viewer.list().entries).toMatchObject([
        { path: 'hello.txt', directory: false, size: 20 },
      ]);
      expect(await new Response((await viewer.open('hello.txt')).stream).text()).toBe(
        'hello single stream\n',
      );
      expect(await new Response((await viewer.open('hello.txt')).stream).text()).toBe(
        'hello single stream\n',
      );
      expect(source.stream).toHaveBeenCalledTimes(1);
      await expect(viewer.open('../hello.txt')).rejects.toMatchObject({
        code: 'viewer_archive_path',
      });
    },
  );
  it('bounds single-stream decoded bytes and rejects corrupted checksums', async () => {
    await expect(
      setup(gzipSync('a'.repeat(100)), 'limited.gz', { maxEntryBytes: 16 }),
    ).rejects.toMatchObject({ code: 'viewer_file_too_large' });
    const corrupt = gzipSync('hello');
    corrupt[corrupt.length - 8] = (corrupt[corrupt.length - 8] ?? 0) ^ 1;
    await expect(setup(corrupt, 'corrupt.gz')).rejects.toThrow();
  });
  it('sorts and filters the complete directory before paging, always keeping directories first', async () => {
    const { viewer } = await setup(
      await zip([
        ['z-folder/a', 'a'],
        ['10.txt', '123456'],
        ['2.txt', '123'],
        ['a.txt', '1'],
      ]),
      'sort.zip',
    );
    expect(viewer.list({ sort: 'name', direction: 'asc' }).entries.map((e) => e.name)).toEqual([
      'z-folder',
      '2.txt',
      '10.txt',
      'a.txt',
    ]);
    expect(viewer.list({ sort: 'name', direction: 'desc' }).entries.map((e) => e.name)).toEqual([
      'z-folder',
      'a.txt',
      '10.txt',
      '2.txt',
    ]);
    expect(viewer.list({ sort: 'size', direction: 'asc' }).entries.map((e) => e.name)).toEqual([
      'z-folder',
      'a.txt',
      '2.txt',
      '10.txt',
    ]);
    expect(
      viewer.list({ sort: 'size', direction: 'desc', query: '.TXT', offset: 1, limit: 1 }),
    ).toMatchObject({ entries: [{ name: '2.txt' }], total: 3, nextOffset: 2 });
    const compare = vi.spyOn(Array.prototype, 'sort');
    try {
      viewer.list({ sort: 'size', direction: 'asc', offset: 1, limit: 1 });
      viewer.list({ sort: 'size', direction: 'asc', offset: 2, limit: 1 });
      expect(compare).not.toHaveBeenCalled();
    } finally {
      compare.mockRestore();
    }
  });
  it('sorts member modification timestamps with deterministic name ties', async () => {
    const result = pack();
    result.entry({ name: 'a', mtime: new Date('2024-02-01T00:00:00Z') }, 'a');
    result.entry({ name: 'b', mtime: new Date('2024-01-01T00:00:00Z') }, 'b');
    result.entry({ name: 'c', mtime: new Date('2024-01-01T00:00:00Z') }, 'c');
    result.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of result) {
      if (!(chunk instanceof Uint8Array)) throw new Error('fixture_chunk');
      chunks.push(Buffer.from(chunk));
    }
    const { viewer } = await setup(Buffer.concat(chunks), 'dates.tar');
    expect(viewer.list({ sort: 'modifiedAt' }).entries.map((e) => e.name)).toEqual(['b', 'c', 'a']);
    expect(
      viewer.list({ sort: 'modifiedAt', direction: 'desc' }).entries.map((e) => e.name),
    ).toEqual(['a', 'c', 'b']);
  });
  it('streams a real 65 MiB 7z archive/member with a 32 MiB decoder heap cap', async () => {
    const factory = require('sevenzip-wasm') as (options: object) => Promise<{
      FS: { writeFile(path: string, bytes: Uint8Array): void; readFile(path: string): Uint8Array };
      callMain(args: string[]): number;
    }>;
    const module = await factory({ print() {}, printErr() {} });
    const size = 65 * 1024 * 1024;
    module.FS.writeFile('/large.bin', Buffer.alloc(size, 42));
    expect(module.callMain(['a', '-t7z', '-mx=0', '/large.7z', '/large.bin'])).toBe(0);
    const bytes = Buffer.from(module.FS.readFile('/large.7z'));
    expect(bytes.length).toBeGreaterThan(64 * 1024 * 1024);
    const root = await mkdtemp(join(tmpdir(), 'nh-viewer-large-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'large.7z');
    await writeFile(path, bytes);
    const options = {
      maximumInputBytes: bytes.length,
      maximumOutputBytes: size,
      maximumHeapBytes: 32 * 1024 * 1024,
    };
    const started = performance.now();
    let received = 0;
    let chunks = 0;
    const reader = streamSevenZipViewer(path, { ...options, entry: 'large.bin' }).getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      expect(next.value.length).toBeLessThanOrEqual(64 * 1024);
      expect(next.value.every((value) => value === 42)).toBe(true);
      received += next.value.length;
      chunks++;
    }
    expect(received).toBe(size);
    expect(chunks).toBeGreaterThan(1000);
    console.info(
      `Atlas 7z: ${received} bytes, ${chunks} bounded chunks, ${Math.round(performance.now() - started)} ms, 32 MiB heap cap`,
    );
    const { viewer } = await setup(bytes, 'large.7z');
    expect(viewer.list().entries).toMatchObject([{ path: 'large.bin', size }]);
    const entry = await viewer.open('large.bin');
    let cachedBytes = 0;
    for await (const chunk of entry.stream) cachedBytes += chunk.length;
    expect(cachedBytes).toBe(size);
    const { stageFileArchive } = await import('./file-operations.js');
    const stage = join(root, 'staged');
    const { mkdir, stat } = await import('node:fs/promises');
    await mkdir(stage);
    const staged = await stageFileArchive(
      path,
      '7z',
      stage,
      undefined,
      { minimumFreeBytes: 0, minimumFreePercent: 0 },
      { entries: ['large.bin'] },
    );
    expect(staged).toHaveLength(1);
    expect((await stat(staged[0]?.local ?? '')).size).toBe(size);

    await expect(
      runSevenZipViewer(path, { ...options, maximumInputBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'viewer_archive_budget' });
  }, 30_000);
  it('releases blocked decoder workers on cancel, timeout and output bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-viewer-worker-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'fixture.rar');
    await writeFile(path, Buffer.from(rar5, 'base64'));
    const options = {
      maximumInputBytes: 1024 * 1024,
      maximumOutputBytes: 29,
      entry: 'helloworld.txt',
    };
    const stream = streamSevenZipViewer(path, options);
    await stream.cancel();
    await expect(
      runSevenZipViewer(path, { ...options, maximumOutputBytes: 2 }),
    ).rejects.toMatchObject({ code: 'viewer_archive_budget' });
    await expect(runSevenZipViewer(path, { ...options, timeoutMs: 1 })).rejects.toMatchObject({
      code: 'viewer_archive_timeout',
    });
    expect(new TextDecoder().decode(await runSevenZipViewer(path, options))).toBe(
      'hello libarchive test suite!\n',
    );
  });
  it('rejects special entries instead of following symlinks', async () => {
    await expect(setup(await tar(true), 'test.tar')).rejects.toMatchObject({
      code: 'viewer_archive_special_file',
    });
  });
  it.each(['../evil', '/absolute', 'ok/../evil', 'a\\b', 'a//b', 'C:bad', 'bad\u0000'])(
    'rejects unsafe member %s',
    (path) => {
      expect(() => viewerArchivePath(path)).toThrow();
    },
  );
  it('rejects a decompression bomb before exposing an entry', async () => {
    await expect(
      setup(await zip([['bomb', '0'.repeat(1024 * 1024)]]), 'bomb.zip'),
    ).rejects.toMatchObject({ code: 'viewer_archive_budget' });
  });
  it('rejects ambiguous duplicate members and a traversal path inside a real ZIP', async () => {
    await expect(
      setup(
        await zip([
          ['one', 'a'],
          ['one', 'b'],
        ]),
        'duplicate.zip',
      ),
    ).rejects.toMatchObject({ code: 'viewer_archive_duplicate' });
    const bytes = await zip([['hello.txt', 'hello']]);
    for (let at = bytes.indexOf('hello.txt'); at >= 0; at = bytes.indexOf('hello.txt'))
      bytes.write('../xx.txt', at);
    await expect(setup(bytes, 'traversal.zip')).rejects.toThrow();
  });
  it('closes active access without retaining usable streams or index', async () => {
    const { viewer } = await setup(await zip([['one', 'hello']]), 'one.zip');
    viewer.close();
    expect(() => viewer.list()).toThrow();
    await expect(viewer.open('one')).rejects.toBeDefined();
  });
});
