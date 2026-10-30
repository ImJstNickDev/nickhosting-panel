import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { createArchiveViewer } from './viewer-archive.js';
import { archiveChain, selectArchiveEntries, ViewerArchiveTree } from './viewer-archive-tree.js';
import { ViewerCache, type ViewerReadSource } from './viewer-cache.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function zip(files: Record<string, Buffer>) {
  const zip = new ZipFile();
  for (const [name, data] of Object.entries(files)) zip.addBuffer(data, name);
  zip.end();
  const parts: Buffer[] = [];
  for await (const chunk of zip.outputStream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}
async function setup(bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'nh-atlas-tree-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cache = new ViewerCache({ root });
  cleanup.push(() => cache.close());
  let streams = 0,
    reads = 0;
  const source: ViewerReadSource = {
    size: bytes.length,
    mtimeMs: 1,
    read: async (offset, length) => {
      reads++;
      return bytes.subarray(offset, offset + length);
    },
    stream: (start = 0, end = bytes.length) => {
      streams++;
      return new ReadableStream({
        start(c) {
          c.enqueue(bytes.subarray(start, end));
          c.close();
        },
      });
    },
  };
  const controller = new AbortController();
  const session = await createArchiveViewer(source, {
    name: 'outer.zip',
    key: 'root',
    cache,
    signal: controller.signal,
  });
  const tree = new ViewerArchiveTree(session, {
    key: 'root',
    cache,
    signal: controller.signal,
    mtimeMs: 1,
  });
  cleanup.push(() => tree.close());
  return { tree, controller, counts: () => ({ streams, reads }) };
}
it('shares lazy nested indexes and downloads only opened containers', async () => {
  const inner = await zip({ 'folder/a.txt': Buffer.from('inner') });
  const { tree, counts } = await setup(await zip({ 'nested.zip': inner, 'unused.zip': inner }));
  const baseline = counts();
  const [a, b] = await Promise.all([tree.acquire(['nested.zip']), tree.acquire(['nested.zip'])]);
  expect(a.session).toBe(b.session);
  expect(a.session.list().entries[0]?.path).toBe('folder');
  const file = await a.session.open('folder/a.txt');
  expect(await new Response(file.stream).text()).toBe('inner');
  expect(counts().streams - baseline.streams).toBe(1);
  const after = counts();
  a.release();
  b.release();
  const cached = await tree.acquire(['nested.zip']);
  expect(counts()).toEqual(after);
  cached.release();
});
it('supports multiple nesting levels and rejects path/depth or missing containers', async () => {
  const { tree, controller } = await setup(
    await zip({ 'a.zip': await zip({ 'b.zip': await zip({ 'a.txt': Buffer.from('deep') }) }) }),
  );
  const deep = await tree.acquire(['a.zip', 'b.zip']);
  expect(deep.session.list().entries[0]?.name).toBe('a.txt');
  deep.release();
  await expect(tree.acquire(['absent.zip'])).rejects.toMatchObject({
    code: 'viewer_archive_not_found',
  });
  for (const chain of [['../a.zip'], ['a.zip', 'b', 'c', 'd', 'e']])
    await expect(tree.acquire(chain)).rejects.toMatchObject({ code: 'viewer_archive_path' });
  expect(() => archiveChain('[]')).toThrow();
  controller.abort();
  await expect(tree.acquire(['a.zip'])).rejects.toThrow();
});
it('resolves folder selection recursively once, excludes unrelated members and validates scope', async () => {
  const { tree } = await setup(
    await zip({
      'dir/a': Buffer.from('a'),
      'dir/sub/b': Buffer.from('b'),
      'other/c': Buffer.from('c'),
    }),
  );
  const entries = selectArchiveEntries(tree.root, ['dir', 'dir/sub/b']);
  expect(entries.map((entry) => entry.path)).toEqual(['dir', 'dir/a', 'dir/sub', 'dir/sub/b']);
  expect(selectArchiveEntries(tree.root, ['dir/a'], 'dir')).toHaveLength(1);
  expect(() => selectArchiveEntries(tree.root, ['other/c'], 'dir')).toThrow();
  expect(() => selectArchiveEntries(tree.root, ['dir/missing'])).toThrow();
});

it('aborts pending nested materialization before awaiting cache disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nh-atlas-close-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cache = new ViewerCache({ root });
  cleanup.push(() => cache.close());
  const started = Promise.withResolvers<void>();
  let cancelled = false;
  const tree = new ViewerArchiveTree(
    {
      format: 'zip',
      close() {},
      list: () => ({
        entries: [
          { path: 'held.zip', name: 'held.zip', directory: false, size: 10, modifiedAt: null },
        ],
        total: 1,
        nextOffset: null,
      }),
      open: async () => ({
        size: 10,
        stream: new ReadableStream<Uint8Array>({
          start() {
            started.resolve();
          },
          cancel() {
            cancelled = true;
          },
        }),
      }),
    },
    { key: 'held', cache, signal: new AbortController().signal, mtimeMs: 1 },
  );
  const pending = tree.acquire(['held.zip']);
  const rejected = expect(pending).rejects.toThrow();
  await started.promise;
  await tree.close();
  await rejected;
  expect(cancelled).toBe(true);
});

it('does not cancel shared nested creation when one caller leaves', async () => {
  const { tree } = await setup(
    await zip({ 'nested.zip': await zip({ 'a.txt': Buffer.from('a') }) }),
  );
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const original = tree.root.open.bind(tree.root);
  tree.root.open = async (path, signal) => {
    started.resolve();
    await gate.promise;
    return original(path, signal);
  };
  const controller = new AbortController();
  const first = tree.acquire(['nested.zip'], controller.signal);
  const cancelled = expect(first).rejects.toThrow();
  const second = tree.acquire(['nested.zip']);
  await started.promise;
  controller.abort();
  await cancelled;
  gate.resolve();
  const retained = await second;
  expect(retained.session.list().entries[0]?.name).toBe('a.txt');
  retained.release();
});
