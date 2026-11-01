import { createHash } from 'node:crypto';
import type { PrivateTransferCache } from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMinecraftWorldPreparation } from './minecraft-world-preparation.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = 1_800_000_000_000;
const ttlMs = 900_000;
const content = 'level-name=world\nsecret=private-value\n';
const snapshot = {
  worlds: [
    { name: 'world', status: 'verified', validation: { dataVersion: 3955, sha256: hash('level') } },
  ],
  properties: { content, hash: hash(content) },
};
type Server = Parameters<ReturnType<typeof createMinecraftWorldPreparation>['read']>[0];
const server = {
  id: 'server-id',
  owner_id: 'owner-private',
  node_id: 'node-id',
  provider_user_id: 21,
  pterodactyl_id: 41,
  pterodactyl_uuid: 'provider-uuid',
  pterodactyl_identifier: 'provider-short',
  external_id: 'external-id',
  mapping_id: 'mapping-id',
  deleted_at: null,
} as Server;
function fixture() {
  const values = new Map<string, string>();
  const cache: PrivateTransferCache = {
    get: vi.fn(async (key) => values.get(key)),
    take: vi.fn(async (key) => {
      const value = values.get(key);
      values.delete(key);
      return value;
    }),
    put: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key) => {
      values.delete(key);
    }),
  };
  return {
    values,
    cache,
    helper: createMinecraftWorldPreparation(cache, 'private-provider-binding'),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('private Minecraft world preparation', () => {
  it('invalidates only the inspected binding and tolerates unavailable storage', async () => {
    const f = fixture();
    await f.helper.save(server, 'combination', snapshot);
    await f.helper.save(server, 'other-combination', snapshot);
    await f.helper.invalidate(server, 'combination');
    expect(await f.helper.read(server, 'combination')).toBeUndefined();
    expect(await f.helper.read(server, 'other-combination')).toBeDefined();
    expect(f.cache.delete).toHaveBeenCalledOnce();
    vi.mocked(f.cache.delete).mockRejectedValue(new Error('private storage failure'));
    await expect(f.helper.invalidate(server, 'other-combination')).resolves.toBeUndefined();
  });
  it('has a cold fallback, stores only verified worlds and never exposes private values in the key', async () => {
    const f = fixture();
    expect(await f.helper.read(server, 'combination')).toBeUndefined();
    await f.helper.save(server, 'combination', {
      ...snapshot,
      worlds: [
        ...snapshot.worlds,
        {
          name: 'old',
          status: 'incompatible',
          validation: { dataVersion: 100, sha256: hash('old') },
        },
        { name: 'unproven', status: 'verified' },
        {
          name: 'negative',
          status: 'verified',
          validation: { dataVersion: -1, sha256: hash('x') },
        },
        {
          name: '../escape',
          status: 'verified',
          validation: { dataVersion: 3955, sha256: hash('x') },
        },
      ],
    });
    expect(await f.helper.read(server, 'combination')).toEqual({
      observedAt: now,
      worlds: [{ name: 'world', dataVersion: 3955, sha256: hash('level') }],
      properties: snapshot.properties,
    });
    const call = vi.mocked(f.cache.put).mock.calls[0];
    expect(call?.[0]).toMatch(/^minecraft\.world-preparation\.v1:[a-f0-9]{64}$/);
    expect(call?.[0]).not.toMatch(/owner-private|private-provider-binding|private-value|world\n/);
    expect(call?.[2]).toBe(ttlMs);
    expect(f.cache.take).not.toHaveBeenCalled();
  });

  it('expires independently of the cache transport and rejects future observations', async () => {
    const f = fixture();
    await f.helper.save(server, 'combination', snapshot);
    vi.setSystemTime(now + ttlMs - 1);
    expect(await f.helper.read(server, 'combination')).toBeDefined();
    vi.setSystemTime(now + ttlMs);
    expect(await f.helper.read(server, 'combination')).toBeUndefined();
    vi.setSystemTime(now - 1);
    expect(await f.helper.read(server, 'combination')).toBeUndefined();
  });

  it('invalidates automatically for owner, runtime, provider and server identity changes', async () => {
    const f = fixture();
    await f.helper.save(server, 'combination', snapshot);
    for (const patch of [
      { owner_id: 'another' },
      { mapping_id: 'another' },
      { node_id: 'another' },
      { provider_user_id: 22 },
      { pterodactyl_uuid: 'another' },
      { external_id: 'another' },
      { deleted_at: new Date(now) },
    ])
      expect(await f.helper.read({ ...server, ...patch }, 'combination')).toBeUndefined();
    expect(await f.helper.read(server, 'different-runtime-combination')).toBeUndefined();
    expect(
      await createMinecraftWorldPreparation(f.cache, 'changed-provider').read(
        server,
        'combination',
      ),
    ).toBeUndefined();
    expect(await f.helper.read(server, 'combination')).toBeDefined();
  });

  it('falls back on malformed metadata, changed properties bytes and unavailable storage', async () => {
    const f = fixture();
    await f.helper.save(server, 'combination', snapshot);
    const original = [...f.values.values()][0];
    if (!original) throw new Error('Missing cache fixture');
    for (const invalid of [
      '{',
      JSON.stringify({ ...JSON.parse(original), extra: true }),
      JSON.stringify({
        ...JSON.parse(original),
        properties: { content: 'changed', hash: hash(content) },
      }),
    ]) {
      vi.mocked(f.cache.get).mockResolvedValueOnce(invalid);
      expect(await f.helper.read(server, 'combination')).toBeUndefined();
    }
    vi.mocked(f.cache.get).mockRejectedValue(new Error('private storage failure'));
    expect(await f.helper.read(server, 'combination')).toBeUndefined();
    await expect(
      f.helper.updateProperties(server, 'combination', hash(content), 'new'),
    ).resolves.toBeUndefined();
    vi.mocked(f.cache.put).mockRejectedValue(new Error('private storage failure'));
    await expect(f.helper.save(server, 'combination', snapshot)).resolves.toBeUndefined();
  });

  it('bounds retained worlds and encoded data', async () => {
    const f = fixture();
    await f.helper.save(server, 'combination', {
      ...snapshot,
      worlds: Array.from({ length: 120 }, (_, index) => ({
        name: `world_${index}`,
        status: 'verified',
        validation: { dataVersion: 3955, sha256: hash(`${index}`) },
      })),
    });
    expect((await f.helper.read(server, 'combination'))?.worlds).toHaveLength(100);
    vi.mocked(f.cache.put).mockClear();
    for (const value of ['x'.repeat(1024 ** 2 + 1), '\n'.repeat(600_000)]) {
      await f.helper.save(server, 'oversized', {
        ...snapshot,
        properties: { content: value, hash: hash(value) },
      });
    }
    expect(f.cache.put).not.toHaveBeenCalled();
  });

  it('updates matching properties without extending observation freshness and accepts an acknowledged replay', async () => {
    const f = fixture();
    await f.helper.save(server, 'combination', snapshot);
    vi.setSystemTime(now + 60_000);
    const changed = 'level-name=adventure\n';
    await f.helper.updateProperties(server, 'combination', hash(content), changed);
    expect(await f.helper.read(server, 'combination')).toEqual({
      observedAt: now,
      worlds: [{ name: 'world', dataVersion: 3955, sha256: hash('level') }],
      properties: { content: changed, hash: hash(changed) },
    });
    expect(vi.mocked(f.cache.put).mock.lastCall?.[2]).toBe(ttlMs - 60_000);
    vi.setSystemTime(now + 90_000);
    await f.helper.updateProperties(server, 'combination', hash(content), changed);
    expect(vi.mocked(f.cache.put).mock.lastCall?.[2]).toBe(ttlMs - 90_000);
    vi.setSystemTime(now + ttlMs);
    expect(await f.helper.read(server, 'combination')).toBeUndefined();
  });

  it('does not replace newer properties or revive an expired observation', async () => {
    const f = fixture();
    await f.helper.save(server, 'combination', snapshot);
    vi.mocked(f.cache.put).mockClear();
    await f.helper.updateProperties(server, 'combination', hash('different-base'), 'changed');
    expect((await f.helper.read(server, 'combination'))?.properties).toEqual(snapshot.properties);
    expect(f.cache.put).not.toHaveBeenCalled();
    vi.setSystemTime(now + ttlMs);
    await f.helper.updateProperties(server, 'combination', hash(content), 'changed');
    expect(f.cache.put).not.toHaveBeenCalled();
  });
});
