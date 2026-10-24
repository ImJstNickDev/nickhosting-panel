import { createHash, randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrivateTransferCache } from './private-transfer-cache.js';

let raw: Redis;
let redisUrl: string;
let prefix: string;
const databaseUrl =
  'postgresql://fixture:private-db-secret@example.invalid/fixture?options=-csearch_path%3Dfixture';
const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 17) } });
const caches: Array<ReturnType<typeof createPrivateTransferCache>> = [];
const owned = new Set<string>();
function fixture(database = databaseUrl, secret = codec) {
  const namespace = `${prefix}:private-transfer-v1:{${createHash('sha256')
    .update(JSON.stringify([prefix, database]))
    .digest('hex')}}`;
  const key = (value: string) => {
    const result = `${namespace}:${createHash('sha256').update(value).digest('hex')}`;
    owned.add(result);
    return result;
  };
  const metadata = {
    index: `${namespace}:index`,
    sizes: `${namespace}:sizes`,
    bytes: `${namespace}:bytes`,
  };
  for (const value of Object.values(metadata)) owned.add(value);
  const cache = createPrivateTransferCache({
    redisUrl,
    prefix,
    databaseUrl: database,
    codec: secret,
  });
  caches.push(cache);
  return { cache, key, metadata };
}
beforeEach(() => {
  redisUrl = process.env.NH_TEST_REDIS_URL ?? '';
  if (
    !redisUrl ||
    !['127.0.0.1', 'localhost', '[::1]', process.env.NH_TEST_VERIFIED_REDIS_HOST].includes(
      new URL(redisUrl).hostname,
    )
  )
    throw new Error('Only verified isolated Redis is permitted');
  prefix = `nh_test_transfer_${randomUUID().replaceAll('-', '')}`;
  raw = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
});
afterEach(async () => {
  await Promise.all(caches.splice(0).map((cache) => cache.close()));
  // Only exact keys created by this test's unique namespace; never FLUSHDB or wildcard deletion.
  if (owned.size) await raw.del(...owned);
  owned.clear();
  raw.disconnect();
});

describe('isolated encrypted transfer cache', () => {
  it('fences a paused collector after another replica acquires its publication lease', async () => {
    const a = fixture(),
      b = fixture();
    const lease = `${prefix}:installation-lease`;
    owned.add(lease);
    a.key('transcript');
    await raw.set(lease, 'collector-a', 'PX', 5000);
    await a.cache.put('transcript', 'first lines', 5000, { key: lease, token: 'collector-a' });
    await raw.set(lease, 'collector-b', 'PX', 5000);
    await b.cache.put('transcript', 'new complete history', 5000, {
      key: lease,
      token: 'collector-b',
    });
    await expect(
      a.cache.put('transcript', 'stale final flush', 5000, { key: lease, token: 'collector-a' }),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(await b.cache.get('transcript')).toBe('new complete history');
  });
  it('shares ciphertext across independent clients and consumes a grant exactly once', async () => {
    const a = fixture();
    const b = fixture();
    const key = 'private/server.properties';
    const value = 'https://wings.example.invalid/download/file?token=never-expose';
    const storedKey = a.key(key);
    await a.cache.put(key, value, 5000);
    const rawValue = await raw.get(storedKey);
    expect(rawValue).not.toContain(value);
    expect(rawValue).not.toContain('never-expose');
    expect(storedKey).not.toContain(key);
    expect(storedKey).not.toContain('private-db-secret');
    expect(await b.cache.get(key)).toBe(value);
    const taken = await Promise.all(
      Array.from({ length: 20 }, (_, index) => (index % 2 ? a : b).cache.take(key)),
    );
    expect(taken.filter((item) => item !== undefined)).toEqual([value]);
    expect(await a.cache.get(key)).toBeUndefined();
    expect(await raw.zcard(a.metadata.index)).toBe(0);
    expect(Number(await raw.get(a.metadata.bytes))).toBe(0);
  });

  it('uses native expiry and releases expired/replaced/deleted byte accounting', async () => {
    const f = fixture();
    const key = 'fixture-entry';
    const storedKey = f.key(key);
    await f.cache.put(key, 'first', 5000);
    const previous = Number(await raw.get(f.metadata.bytes));
    await f.cache.put(key, 'a longer replacement', 50);
    expect(await raw.zcard(f.metadata.index)).toBe(1);
    expect(Number(await raw.get(f.metadata.bytes))).toBeGreaterThan(previous);
    expect(await raw.pttl(storedKey)).toBeGreaterThan(0);
    await vi.waitFor(async () => expect(await f.cache.get(key)).toBeUndefined());
    expect(await raw.zcard(f.metadata.index)).toBe(0);
    expect(Number(await raw.get(f.metadata.bytes))).toBe(0);
    await f.cache.put(key, 'next', 5000);
    await f.cache.delete(key);
    expect(await f.cache.take(key)).toBeUndefined();
    expect(Number(await raw.get(f.metadata.bytes))).toBe(0);
  });

  it('isolates database/schema namespaces and refuses ciphertext swapping or another encryption key', async () => {
    const a = fixture();
    const b = fixture(`${databaseUrl}-other-schema`);
    const rotated = fixture(
      databaseUrl,
      new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 19) } }),
    );
    const aKey = a.key('a');
    const bKey = a.key('b');
    b.key('a');
    await a.cache.put('a', 'private-value', 5000);
    expect(await b.cache.get('a')).toBeUndefined();
    await expect(rotated.cache.get('a')).rejects.toMatchObject({ code: 'integration_unavailable' });
    await raw.set(bKey, (await raw.get(aKey)) ?? '', 'PX', 5000);
    await expect(a.cache.take('b')).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(await raw.get(bKey)).toBeNull();
    expect(await a.cache.get('a')).toBe('private-value');
  });

  it('enforces the global byte and entry caps atomically without replacing existing payloads', async () => {
    const f = fixture();
    const key = 'overflow';
    const storedKey = f.key(key);
    // Seed only this test's accounting boundary, without allocating 64 MiB of payloads.
    await raw.set(f.metadata.bytes, 64 * 1024 ** 2);
    await expect(f.cache.put(key, 'bounded', 5000)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
    expect(await raw.get(storedKey)).toBeNull();
    await raw.del(f.metadata.bytes);
    const expires = Date.now() + 60_000;
    await raw.zadd(
      f.metadata.index,
      ...Array.from({ length: 10_000 }, (_, index) => [
        expires,
        f.key(`fixture-slot-${index}`),
      ]).flat(),
    );
    await expect(f.cache.put(key, 'bounded', 5000)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
    expect(await raw.get(storedKey)).toBeNull();
    expect(await raw.zcard(f.metadata.index)).toBe(10_000);
  });

  it('rejects oversize payloads, invalid TTLs and closed clients before publication', async () => {
    const f = fixture();
    const storedKey = f.key('a');
    for (const ttl of [0, -1, 960_001, Number.NaN, 1.5])
      await expect(f.cache.put('a', 'private', ttl)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    await expect(f.cache.put('a', 'x'.repeat(1_048_577), 5000)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(await raw.get(storedKey)).toBeNull();
    await f.cache.close();
    await expect(f.cache.put('a', 'private', 5000)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
  });
});
