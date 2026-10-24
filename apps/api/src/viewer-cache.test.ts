import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewerCache, type ViewerReadSource, ViewerSessionCache } from './viewer-cache.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((action) => action()));
});
async function setup(maxBytes = 100) {
  const root = await mkdtemp(join(tmpdir(), 'nh-viewer-cache-'));
  const cache = new ViewerCache({ root, maxBytes, maxFileBytes: maxBytes });
  cleanup.push(async () => {
    await cache.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, cache };
}
function source(value: string): ViewerReadSource {
  const bytes = Buffer.from(value);
  return {
    size: bytes.length,
    mtimeMs: 1,
    read: vi.fn(async (offset, length) => bytes.subarray(offset, offset + length)),
    stream: vi.fn(
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    ),
  };
}
describe('viewer temporary cache', () => {
  it('coalesces duplicate downloads and removes only its own directory on shutdown', async () => {
    const { cache, root } = await setup();
    await writeFile(join(root, 'unrelated'), 'keep');
    const input = source('hello');
    const [first, second] = await Promise.all([
      cache.acquire('revision', input),
      cache.acquire('revision', input),
    ]);
    expect(first.path).toBe(second.path);
    expect(input.stream).toHaveBeenCalledTimes(1);
    expect(await readFile(first.path, 'utf8')).toBe('hello');
    first.release();
    second.release();
    await cache.close();
    expect(await readdir(root)).toEqual(['unrelated']);
  });
  it('reserves aggregate capacity atomically and evicts idle files instead of pinned files', async () => {
    const { cache } = await setup(8);
    const first = await cache.acquire('first', source('12345678'));
    await expect(cache.acquire('second', source('a'))).rejects.toMatchObject({
      code: 'viewer_cache_busy',
    });
    first.release();
    const second = await cache.acquire('second', source('a'));
    expect(await readFile(second.path, 'utf8')).toBe('a');
    await expect(readFile(first.path)).rejects.toMatchObject({ code: 'ENOENT' });
    second.release();
  });
  it('rejects truncated/oversized sources and releases their budget', async () => {
    const { cache } = await setup();
    const input = source('hello');
    await expect(cache.acquire('short', { ...input, size: 6 })).rejects.toMatchObject({
      code: 'viewer_revision_changed',
    });
    await expect(cache.acquire('long', { ...input, size: 4 })).rejects.toMatchObject({
      code: 'viewer_revision_changed',
    });
    const valid = await cache.acquire('short', input);
    valid.release();
  });
  it('streams generated data to a bounded file and reuses its actual size', async () => {
    const { cache } = await setup();
    const stream = vi.fn(() => source('abc').stream());
    const first = await cache.acquireGenerated('decoded', { maximumBytes: 80, stream });
    const second = await cache.acquireGenerated('decoded', { maximumBytes: 80, stream });
    expect(first.size).toBe(3);
    expect(second.size).toBe(3);
    expect(stream).toHaveBeenCalledTimes(1);
    first.release();
    second.release();
  });
  it('one canceled subscriber does not cancel a download still required by another', async () => {
    const { cache } = await setup();
    const gate = Promise.withResolvers<void>();
    const input = source('abc');
    input.stream = () =>
      new ReadableStream({
        async start(controller) {
          await gate.promise;
          controller.enqueue(Buffer.from('abc'));
          controller.close();
        },
      });
    const controller = new AbortController();
    const first = cache.acquire('a', input, controller.signal);
    const second = cache.acquire('a', input);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(first).rejects.toBeDefined();
    gate.resolve();
    const lease = await second;
    expect(await readFile(lease.path, 'utf8')).toBe('abc');
    lease.release();
  });
  it('accounts previous run files on restart without deleting them or unrelated content', async () => {
    const { cache: previous, root } = await setup(10);
    const original = await previous.acquire('old', source('12345678'));
    original.release();
    await writeFile(join(root, 'unrelated'), 'keep');
    // A new process sees the same state as an unclean prior shutdown. It must not reset its budget to zero.
    const restarted = new ViewerCache({ root, maxBytes: 10, maxFileBytes: 10 });
    cleanup.push(() => restarted.close());
    await expect(restarted.acquire('too-much', source('abc'))).rejects.toMatchObject({
      code: 'viewer_cache_busy',
    });
    const small = await restarted.acquire('fits', source('ab'));
    small.release();
    await restarted.close();
    expect(await readFile(original.path, 'utf8')).toBe('12345678');
    expect(await readFile(join(root, 'unrelated'), 'utf8')).toBe('keep');
  });
});

describe('shared parsed viewer sessions', () => {
  it('singleflights creation, preserves active leases, and evicts idle connections', async () => {
    const cache = new ViewerSessionCache<{ version: number }>({ maximum: 1, idleMs: 60_000 });
    cleanup.push(() => cache.close());
    const dispose = vi.fn(async () => undefined);
    const create = vi.fn(async () => ({ session: { version: 1 }, dispose }));
    const [one, two] = await Promise.all([
      cache.acquire('one', create),
      cache.acquire('one', create),
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    await expect(cache.acquire('two', create)).rejects.toMatchObject({ code: 'viewer_cache_busy' });
    one.release();
    two.release();
    const next = await cache.acquire('two', create);
    expect(dispose).toHaveBeenCalledTimes(1);
    next.release();
    await cache.close();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
  it('cleans idle connections without another request', async () => {
    const cache = new ViewerSessionCache<string>({ idleMs: 10 });
    cleanup.push(() => cache.close());
    const dispose = vi.fn(async () => undefined);
    (await cache.acquire('a', async () => ({ session: 'a', dispose }))).release();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });
  it('invalidates a revoked index immediately while releasing active leases once', async () => {
    const cache = new ViewerSessionCache<string>();
    cleanup.push(() => cache.close());
    const dispose = vi.fn(async () => undefined);
    const first = await cache.acquire('same', async () => ({ session: 'first', dispose }));
    await cache.invalidate('same');
    const second = await cache.acquire('same', async () => ({ session: 'second', dispose }));
    expect(second.session).toBe('second');
    expect(dispose).not.toHaveBeenCalled();
    first.release();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    second.release();
  });
});
