import type { ConsoleEvent, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { describe, expect, it, vi } from 'vitest';
import { createFileDiskUsageCache, trackFileDiskMutations } from './file-disk-usage.js';

const stats = (disk_bytes = 100): ConsoleEvent => ({
  type: 'stats',
  data: { disk_bytes, cpu_absolute: 0, memory_bytes: 0 },
});

describe('authenticated Wings disk observations', () => {
  it('retains bounded, non-sliding observations across a closed relay without inventing missing data', () => {
    let clock = 0;
    const cache = createFileDiskUsageCache(() => clock);
    const observe = cache.observe('server', 'identity+credential');
    expect(cache.read('identity+credential')).toBeUndefined();
    observe(stats(0));
    expect(cache.read('identity+credential')).toBeUndefined();
    observe({ type: 'status', data: 'running' });
    observe(stats());
    observe({ type: 'closed' });
    observe(stats(0));
    clock = 29_999;
    expect(cache.read('identity+credential')).toBe(100);
    clock = 30_000;
    expect(cache.read('identity+credential')).toBeUndefined();
  });

  it('does not reuse values for another credential/server identity or offline/invalid stats', () => {
    const cache = createFileDiskUsageCache();
    const observe = cache.observe('server', 'old-binding');
    observe({ type: 'status', data: 'running' });
    observe(stats());
    expect(cache.read('new-binding')).toBeUndefined();
    observe({ type: 'status', data: 'offline' });
    observe(stats(0));
    expect(cache.read('old-binding')).toBeUndefined();
    observe({ type: 'status', data: 'running' });
    for (const bytes of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1]) {
      observe(stats(bytes));
      expect(cache.read('old-binding')).toBeUndefined();
    }
    observe(stats(0));
    expect(cache.read('old-binding')).toBe(0);
  });

  it('invalidates before/after writes and ignores samples across concurrent writes and failures', async () => {
    const cache = createFileDiskUsageCache();
    const observe = cache.observe('server', 'binding');
    observe({ type: 'status', data: 'running' });
    observe(stats());
    const one = Promise.withResolvers<void>(),
      two = Promise.withResolvers<void>();
    const first = cache.mutate('server', () => one.promise);
    const second = cache.mutate('server', () => two.promise);
    expect(cache.read('binding')).toBeUndefined();
    observe(stats());
    one.resolve();
    await first;
    observe(stats());
    expect(cache.read('binding')).toBeUndefined();
    two.reject(new Error('uncertain'));
    await expect(second).rejects.toThrow('uncertain');
    expect(cache.read('binding')).toBeUndefined();
    observe(stats(120));
    expect(cache.read('binding')).toBe(120);
  });

  it('bounds retained observations and isolates unrelated server writes', async () => {
    const cache = createFileDiskUsageCache();
    for (let i = 0; i < 1025; i++) {
      const observe = cache.observe(`server-${i}`, `scope-${i}`);
      observe({ type: 'status', data: 'running' });
      observe(stats());
    }
    expect(cache.read('scope-0')).toBeUndefined();
    expect(cache.read('scope-1')).toBe(100);
    await cache.mutate('server-1', async () => {});
    expect(cache.read('scope-1')).toBeUndefined();
    expect(cache.read('scope-1024')).toBe(100);
  });
});

describe('file write disk invalidation', () => {
  function fixture() {
    const cache = createFileDiskUsageCache();
    const observe = cache.observe('server', 'binding');
    observe({ type: 'status', data: 'running' });
    const sample = () => observe(stats());
    sample();
    return { cache, sample };
  }

  it.each([
    'writeFile',
    'deleteFiles',
    'guardedDeleteDirectory',
    'commitFileArchive',
    'extractArchive',
    'createDirectory',
    'renameFiles',
    'uploadFile',
    'restoreBackup',
    'reinstall',
    'reinstallWithConfirmation',
  ] as const)('invalidates %s without changing its call or result', async (method) => {
    const { cache, sample } = fixture();
    const effect = vi.fn(async () => {
      expect(cache.read('binding')).toBeUndefined();
      sample();
      return 'result';
    });
    const adapter = trackFileDiskMutations(
      { [method]: effect } as unknown as PterodactylAdapter,
      cache,
    );
    const args = method === 'reinstallWithConfirmation' ? [1, 'server', {}] : ['server', {}];
    expect(await Reflect.apply(adapter[method], adapter, args)).toBe('result');
    expect(effect).toHaveBeenCalledWith(...args);
    expect(cache.read('binding')).toBeUndefined();
  });

  it('does not invalidate at URL preparation, only when a prepared upload is actually sent', async () => {
    const { cache, sample } = fixture();
    const effect = vi.fn(async () => {
      expect(cache.read('binding')).toBeUndefined();
      sample();
    });
    const adapter = trackFileDiskMutations(
      {
        prepareUpload: async () => effect,
        prepareUploadBatch: async () => ({ expiresAt: 99, uploads: [effect, effect] }),
      } as unknown as PterodactylAdapter,
      cache,
    );
    const upload = await adapter.prepareUpload('server', 'a.txt');
    const batch = await adapter.prepareUploadBatch('server', ['b.txt', 'c.txt']);
    expect(cache.read('binding')).toBe(100);
    await upload({} as never);
    expect(cache.read('binding')).toBeUndefined();
    sample();
    await batch?.uploads[0]?.({} as never);
    expect(cache.read('binding')).toBeUndefined();
    expect(effect).toHaveBeenCalledTimes(2);
  });
});
