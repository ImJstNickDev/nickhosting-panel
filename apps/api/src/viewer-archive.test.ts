import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { createArchiveViewer, viewerArchivePath } from './viewer-archive.js';
import { rar5, tarBz2, tarXz } from './viewer-archive-fixtures.js';
import { ViewerCache, type ViewerReadSource } from './viewer-cache.js';

const cleanup: (() => Promise<void>)[] = [];
const require = createRequire(import.meta.url);
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((action) => action()));
});
async function setup(bytes: Buffer, name: string) {
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
  const viewer = await createArchiveViewer(source, { name, cache, key: name });
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
