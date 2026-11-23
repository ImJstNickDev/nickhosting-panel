import { expect, it, vi } from 'vitest';
import { OpenworldTerrainHistory } from './openworld-terrain-history.js';

it('keeps compressible geometry within a byte budget and never renews its absolute lifetime', async () => {
  let now = 0;
  const cache = new OpenworldTerrainHistory({ bytes: 20000, entries: 4, ttl: 1000 }, () => now);
  const a = new Uint8Array(16000).fill(7);
  const b = new Uint8Array(16000).fill(8);
  await cache.remember('a', a, 24);
  await cache.remember('b', b, 25);
  now = 900;
  const validate = vi.fn(async () => true);
  expect(Buffer.from((await cache.restore('a', validate)) ?? []).equals(a)).toBe(true);
  expect(validate).toHaveBeenCalledWith(24);
  expect(await cache.restore('b', async () => false)).toBeUndefined();
  now = 1000;
  expect(await cache.restore('a', validate)).toBeUndefined();
  expect(validate).toHaveBeenCalledTimes(1);
});

it('bounds entries and bytes, respects LRU and rejects invalidation during validation', async () => {
  const cache = new OpenworldTerrainHistory({ bytes: 4, entries: 2, ttl: 1000 }, () => 10);
  const ok = async () => true;
  const a = Uint8Array.of(1, 2);
  await cache.remember('a', a, 1);
  await cache.remember('b', a, 1);
  expect(await cache.restore('a', ok)).toEqual(a);
  await cache.remember('c', a, 1);
  expect(await cache.restore('b', ok)).toBeUndefined();
  const done = Promise.withResolvers<boolean>();
  const reading = cache.restore('a', () => done.promise);
  cache.invalidate((key) => key === 'a');
  done.resolve(true);
  expect(await reading).toBeUndefined();
  await cache.remember('full', new Uint8Array(4), 1);
  expect(await cache.restore('c', ok)).toBeUndefined();
});
