import { describe, expect, it, vi } from 'vitest';
import { createUploadUrlCache } from './upload-url-cache.js';

const files: [{ id: string; path: string }, { id: string; path: string }] = [
  { id: 'a', path: '/world/a' },
  { id: 'b', path: '/world/b' },
];
const body = () => ({
  body: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'));
      controller.close();
    },
  }),
  contentLength: 1,
  maxBytes: 1,
});
describe('private bulk upload credentials', () => {
  it('normalizes the adapter boundary, reuses one issuance and consumes only on send', async () => {
    const cache = createUploadUrlCache();
    const send = vi.fn(async () => {});
    const issue = vi.fn(async (paths: string[]) => ({
      expiresAt: Date.now() + 900_000,
      uploads: paths.map(() => send),
    }));
    await Promise.all([cache.warm('binding', files, issue), cache.warm('binding', files, issue)]);
    expect(issue).toHaveBeenCalledExactlyOnceWith(['world/a', 'world/b']);
    const first = await cache.take('binding', files[0]);
    expect(await cache.take('binding', files[0])).toBeTypeOf('function');
    expect(send).not.toHaveBeenCalled();
    await first?.(body());
    expect(await cache.take('binding', files[0])).toBeUndefined();
    expect(await cache.take('binding', files[1])).toBeTypeOf('function');
  });
  it('refreshes unused tokens together near expiry and isolates credential bindings', async () => {
    let now = 0;
    const cache = createUploadUrlCache(() => now);
    const issue = vi.fn(async (paths: string[]) => ({
      expiresAt: now + 900_000,
      uploads: paths.map(() => async () => {}),
    }));
    await cache.warm('old-key', files, issue);
    expect(await cache.take('new-key', files[0])).toBeUndefined();
    now = 880_000;
    expect(await cache.take('old-key', files[0])).toBeUndefined();
    await Promise.all([
      cache.warm('old-key', files, issue, 'a'),
      cache.warm('old-key', files, issue, 'b'),
    ]);
    expect(issue).toHaveBeenCalledTimes(2);
  });
  it('rechecks the requested entry after joining issuance from a different recovery snapshot', async () => {
    const cache = createUploadUrlCache();
    const held = Promise.withResolvers<void>();
    const issue = vi.fn(async (paths: string[]) => {
      if (paths.length === 1) await held.promise;
      return { expiresAt: Date.now() + 900_000, uploads: paths.map(() => async () => {}) };
    });
    const b = cache.warm('group', [files[1]], issue, 'b');
    const a = cache.warm('group', files, issue, 'a');
    held.resolve();
    await Promise.all([a, b]);
    expect(await cache.take('group', files[0])).toBeTypeOf('function');
    expect(await cache.take('group', files[1])).toBeTypeOf('function');
    expect(issue).toHaveBeenCalledTimes(2);
  });
  it('evicts only disposable credentials and retries failed issuance without sticky rejection', async () => {
    const cache = createUploadUrlCache(Date.now, 1);
    const issue = vi.fn(async (paths: string[]) => ({
      expiresAt: Date.now() + 900_000,
      uploads: paths.map(() => async () => {}),
    }));
    await cache.warm('one', files, issue);
    await cache.warm('two', files, issue);
    expect(await cache.take('one', files[0])).toBeUndefined();
    await expect(
      cache.warm('failed', files, async () => {
        throw new Error('unavailable');
      }),
    ).rejects.toThrow('unavailable');
    await cache.warm('failed', files, issue);
    expect(await cache.take('failed', files[0])).toBeTypeOf('function');
    cache.forget('failed');
    expect(await cache.take('failed', files[0])).toBeUndefined();
  });
  it('remembers stock-provider fallback for the group and rejects path rebinding', async () => {
    const cache = createUploadUrlCache();
    const stock = vi.fn(async () => null);
    await cache.warm('stock', files, stock);
    await cache.warm('stock', files, stock);
    expect(await cache.take('stock', files[0])).toBeNull();
    expect(stock).toHaveBeenCalledTimes(1);
    await cache.warm('bulk', files, async (paths) => ({
      expiresAt: Date.now() + 900_000,
      uploads: paths.map(() => async () => {}),
    }));
    await expect(cache.take('bulk', { id: 'a', path: '/elsewhere' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
