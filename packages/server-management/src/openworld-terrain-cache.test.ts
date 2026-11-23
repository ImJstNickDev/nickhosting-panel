import { expect, it, vi } from 'vitest';
import { OpenworldTerrainCache } from './openworld-terrain-cache.js';

const options = { bytes: 4, entries: 2, active: 3, perServer: 2 };
const live = () => new AbortController().signal;
const data = new Uint8Array([1, 2]);

it('retains a shared geometry read until its last viewer leaves, even if an earlier viewer closes', async () => {
  const cache = new OpenworldTerrainCache(options, Date.now),
    done = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
  const read = vi.fn((_: AbortSignal) => done.promise);
  const a = new AbortController(),
    b = new AbortController();
  const resultA = cache.get('mesh', 's', 10, a.signal, read);
  const resultB = cache.get('mesh', 's', 10, b.signal, read);
  await Promise.resolve();
  a.abort();
  await expect(resultA).rejects.toMatchObject({ code: 'game_not_ready' });
  expect(read.mock.calls[0]?.[0].aborted).toBe(false);
  b.abort();
  await expect(resultB).rejects.toMatchObject({ code: 'game_not_ready' });
  expect(read.mock.calls[0]?.[0].aborted).toBe(true);
  const clean = cache.get('mesh', 's', 10, live(), async () => new Uint8Array([5]));
  done.resolve(data);
  expect(await clean).toEqual(new Uint8Array([5]));
});
it('lets a peer finish its current frame while new readers see the edited revision', async () => {
  const cache = new OpenworldTerrainCache(options, Date.now),
    done = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
  const stale = cache.get('before', 's', 10, live(), () => done.promise);
  cache.invalidate((k) => k === 'before');
  const current = cache.get('before', 's', 10, live(), async () => new Uint8Array([42]));
  expect(await current).toEqual(new Uint8Array([42]));
  done.resolve(data);
  expect(await stale).toEqual(data);
  const load = vi.fn(async () => null);
  expect(await cache.get('before', 's', 10, live(), load)).toEqual(new Uint8Array([42]));
  expect(load).not.toHaveBeenCalled();
});
it('shares a per-server queue, skips work abandoned before dispatch and releases slots on failure', async () => {
  const cache = new OpenworldTerrainCache(
    { ...options, active: 5, perServer: 4, parallelPerServer: 1, finishStarted: true },
    Date.now,
  );
  const first = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
  const started: string[] = [];
  const waiting = new AbortController();
  const active = cache.get('s/a', 's', 100, live(), async (_, waited) => {
    started.push('a');
    expect(waited).toBe(false);
    return first.promise;
  });
  const abandoned = vi.fn(async () => data);
  const cancelled = cache.get('s/b', 's', 100, waiting.signal, abandoned);
  const failure = cache.get('s/c', 's', 100, live(), async (_, waited) => {
    started.push('c');
    expect(waited).toBe(true);
    throw new Error('native timeout');
  });
  const next = vi.fn(async (_: AbortSignal, waited: boolean) => {
    started.push('d');
    expect(waited).toBe(true);
    return data;
  });
  const last = cache.get('s/d', 's', 100, live(), next);
  const same = cache.get('s/d', 's', 100, live(), next);
  expect(() => cache.get('s/e', 's', 100, live(), next)).toThrow();
  await cache.get('t/a', 't', 100, live(), async (_, waited) => {
    started.push('other-server');
    expect(waited).toBe(false);
    return data;
  });
  waiting.abort();
  await expect(cancelled).rejects.toMatchObject({ code: 'game_not_ready' });
  expect(started).toEqual(['a', 'other-server']);
  const failed = expect(failure).rejects.toThrow('native timeout');
  first.resolve(data);
  await Promise.all([active, failed, last, same]);
  expect(abandoned).not.toHaveBeenCalled();
  expect(started).toEqual(['a', 'other-server', 'c', 'd']);
  expect(await cache.get('s/c', 's', 100, live(), async () => data)).toEqual(data);
});
it('bounds recently used binary assets and counts accepted generator jobs through viewer cancellation', async () => {
  let now = 0;
  const cache = new OpenworldTerrainCache(
    { ...options, finishStarted: true, perServer: 1 },
    () => now,
  );
  const controller = new AbortController(),
    done = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
  const read = vi.fn((_: AbortSignal) => done.promise);
  const cancelled = cache.get('first', 's', 100, controller.signal, read);
  await Promise.resolve();
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ code: 'game_not_ready' });
  expect(read.mock.calls[0]?.[0].aborted).toBe(false);
  expect(() => cache.get('another', 's', 100, live(), read)).toThrow();
  const other = cache.get('second', 't', 100, live(), async () => data),
    joined = cache.get('first', 's', 100, live(), read);
  done.resolve(data);
  await Promise.all([other, joined]);
  expect(read).toHaveBeenCalledTimes(1);
  await cache.get('second', 't', 100, live(), read);
  await cache.get('third', 's', 100, live(), async () => data);
  const reload = vi.fn(async () => data);
  await cache.get('first', 's', 100, live(), reload);
  expect(reload).toHaveBeenCalledTimes(1);
  now = 110;
  await cache.get('first', 's', 100, live(), reload);
  expect(reload).toHaveBeenCalledTimes(2);
});
