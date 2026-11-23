import { expect, it, vi } from 'vitest';
import { OpenworldTerrainHistory } from './openworld-terrain-history.js';

it('keeps compressible geometry within budget and renews only successfully validated entries', async () => {
  let now = 0;
  const cache = new OpenworldTerrainHistory({ bytes: 20000, entries: 4, ttl: 1000 }, () => now);
  const a = new Uint8Array(16000).fill(7);
  const b = new Uint8Array(16000).fill(8);
  await cache.remember('a', a, 24);
  await cache.remember('b', b, 25);
  now = 900;
  const validate = vi.fn(async () => 36);
  expect(Buffer.from((await cache.restore('a', validate)) ?? []).equals(a)).toBe(true);
  expect(validate).toHaveBeenCalledWith(24);
  expect(await cache.restore('b', async () => undefined)).toBeUndefined();
  now = 1000;
  expect(await cache.restore('b', validate)).toBeUndefined();
  expect(await cache.restore('a', validate)).toEqual(a);
  expect(validate.mock.calls).toEqual([[24], [36]]);
  now = 2000;
  expect(await cache.restore('a', validate)).toBeUndefined();
  expect(validate).toHaveBeenCalledTimes(2);
});

it('bounds entries and bytes, respects LRU and rejects invalidation during validation', async () => {
  const cache = new OpenworldTerrainHistory({ bytes: 4, entries: 2, ttl: 1000 }, () => 10);
  const ok = async () => 1;
  const slab = new Uint8Array(8192);
  const a = slab.subarray(10, 12);
  a.set([1, 2]);
  await cache.remember('a', a, 1);
  await cache.remember('b', a, 1);
  const retained = await cache.restore('a', ok);
  expect(retained).toEqual(a);
  expect(retained?.buffer.byteLength).toBe(2);
  await cache.remember('c', a, 1);
  expect(await cache.restore('b', ok)).toBeUndefined();
  const done = Promise.withResolvers<number>();
  const reading = cache.restore('a', () => done.promise);
  cache.invalidate((key) => key === 'a');
  done.resolve(1);
  expect(await reading).toBeUndefined();
  await cache.remember('full', new Uint8Array(4), 1);
  expect(await cache.restore('c', ok)).toBeUndefined();
});

it('does not revive expired, replaced or rewound assets and never rewinds a newer proof', async () => {
  let now = 0;
  const cache = new OpenworldTerrainHistory({ bytes: 32, entries: 4, ttl: 1000 }, () => now);
  const first = Uint8Array.of(1);
  const second = Uint8Array.of(2);
  await cache.remember('a', first, 5);
  const slow = Promise.withResolvers<number>();
  const waiting = cache.restore('a', () => slow.promise);
  now = 100;
  expect(await cache.restore('a', async () => 9)).toEqual(first);
  slow.resolve(6);
  expect(await waiting).toEqual(first);
  const rewind = vi.fn(async () => 8);
  expect(await cache.restore('a', rewind)).toBeUndefined();
  expect(rewind).toHaveBeenCalledWith(9);

  const expired = Promise.withResolvers<number>();
  const longRead = cache.restore('a', () => expired.promise);
  now = 1100;
  expired.resolve(10);
  expect(await longRead).toBeUndefined();

  await cache.remember('a', first, 10);
  const replaced = Promise.withResolvers<number>();
  const previous = cache.restore('a', () => replaced.promise);
  await cache.remember('a', second, 11);
  replaced.resolve(12);
  expect(await previous).toBeUndefined();
  expect(await cache.restore('a', async () => 11)).toEqual(second);
});

it('releases idle entries on their own deadlines using one timer and keeps an active neighbour', async () => {
  vi.useFakeTimers();
  try {
    const cache = new OpenworldTerrainHistory({ bytes: 32, entries: 4, ttl: 1000 }, Date.now);
    const data = Uint8Array.of(1);
    await cache.remember('first', data, 0);
    await vi.advanceTimersByTimeAsync(200);
    await cache.remember('next', data, 0);
    await vi.advanceTimersByTimeAsync(300);
    expect(vi.getTimerCount()).toBe(1);
    expect(await cache.restore('first', async () => 0)).toEqual(data);
    await vi.advanceTimersByTimeAsync(700);
    const validate = vi.fn(async () => 0);
    expect(await cache.restore('next', validate)).toBeUndefined();
    expect(validate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(vi.getTimerCount()).toBe(0);
    expect(await cache.restore('first', validate)).toBeUndefined();
    expect(validate).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
