import { DomainError } from '@nickhosting/core';
import { ProviderRateLimitError } from '@nickhosting/external-services';
import { describe, expect, it, vi } from 'vitest';
import { createDnsAvailabilityCache } from './dns-availability.js';

const policy = { cacheSeconds: 30, requestsPerMinute: 60, concurrency: 2 };
describe('bounded advisory DNS cache', () => {
  it('coalesces concurrent probes, caches presence only and expires without extending on reads', async () => {
    let now = 0;
    const cache = createDnsAvailabilityCache(() => now);
    let finish!: (v: boolean) => void;
    const read = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const one = cache('token', 'key', 2, policy, read),
      two = cache('token', 'key', 2, policy, read);
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    finish(true);
    expect(await Promise.all([one, two])).toEqual([true, true]);
    now = 29_000;
    expect(await cache('token', 'key', 2, policy, read)).toBe(true);
    expect(read).toHaveBeenCalledOnce();
    now = 30_001;
    const again = cache('token', 'key', 2, policy, async () => false);
    expect(await again).toBe(false);
  });
  it('counts actual upstream reads across different requests and rejects excess without queueing', async () => {
    const cache = createDnsAvailabilityCache(() => 0),
      read = vi.fn(async () => true);
    await cache('token', 'first', 2, { ...policy, requestsPerMinute: 2 }, read);
    await expect(
      cache('token', 'second', 1, { ...policy, requestsPerMinute: 2 }, read),
    ).rejects.toMatchObject({ code: 'rate_limited', details: { retryAfterMs: 60_000 } });
    expect(read).toHaveBeenCalledOnce();
  });
  it('bounds concurrency and applies upstream Retry-After across names without caching unknown results', async () => {
    let now = 0;
    const cache = createDnsAvailabilityCache(() => now);
    let finish!: (v: boolean) => void;
    const first = cache(
      'token',
      'busy',
      1,
      { ...policy, concurrency: 1 },
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    await expect(
      cache('token', 'other', 1, { ...policy, concurrency: 1 }, async () => true),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    finish(false);
    await first;
    const rate = vi.fn(async () => {
      throw new ProviderRateLimitError(20_000);
    });
    await expect(cache('token', 'limited', 1, policy, rate)).rejects.toMatchObject({
      code: 'rate_limited',
      details: { retryAfterMs: 20_000 },
    });
    now = 10_000;
    await expect(cache('token', 'different', 1, policy, rate)).rejects.toMatchObject({
      details: { retryAfterMs: 10_000 },
    });
    expect(rate).toHaveBeenCalledOnce();
    now = 20_001;
    expect(await cache('token', 'limited', 1, policy, async () => true)).toBe(true);
  });
  it('does not cache transient failures as availability', async () => {
    const cache = createDnsAvailabilityCache(),
      read = vi.fn(async () => {
        throw new DomainError('integration_unavailable');
      });
    await expect(cache('token', 'same', 1, policy, read)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
    expect(await cache('token', 'same', 1, policy, async () => false)).toBe(false);
  });
  it('bounds cached names to 512 without extending their TTL', async () => {
    let now = 0;
    const cache = createDnsAvailabilityCache(() => now),
      read = vi.fn(async () => true),
      large = { ...policy, cacheSeconds: 300, requestsPerMinute: 200 };
    for (let i = 0; i < 513; i++) {
      if (i > 0 && i % 200 === 0) now += 61_000;
      await cache('token', String(i), 1, large, read);
    }
    await cache('token', '0', 1, large, read);
    expect(read).toHaveBeenCalledTimes(514);
  });
});
