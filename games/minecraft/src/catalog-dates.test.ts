import { describe, expect, it, vi } from 'vitest';
import { minecraftManifestUrl } from './catalog.js';
import { createMinecraftReleaseDateLookup } from './catalog-dates.js';

const versions = [
  { id: '1.21.11', type: 'release', releaseTime: '2025-12-09T12:00:00Z' },
  { id: '26.1-snapshot-1', type: 'snapshot', releaseTime: '2026-01-07T12:00:00Z' },
  { id: '26.1', type: 'release', releaseTime: '2026-03-24T12:00:00Z' },
  { id: 'b1.0', type: 'old_beta' },
].map((release) => ({
  ...release,
  url: 'https://piston-meta.mojang.com/v1/packages/fixture.json',
  sha1: 'a'.repeat(40),
}));
function document() {
  return {
    bytes: Buffer.from(JSON.stringify({ versions })),
    evidence: {
      url: minecraftManifestUrl,
      sha256: 'b'.repeat(64),
      retrievedAt: '2026-10-10T00:00:00Z',
    },
  };
}

describe('Owner release chronology metadata', () => {
  it('reads official dates across release families and never invents missing dates', async () => {
    const read = vi.fn(async () => document());
    const lookup = await createMinecraftReleaseDateLookup({ client: () => ({ read }) })('fixture');
    expect(lookup('26.1-snapshot-1')).toEqual({
      releaseTime: '2026-01-07T12:00:00Z',
      releaseTimeStatus: 'available',
    });
    expect(lookup('26.1').releaseTime).toBe('2026-03-24T12:00:00Z');
    expect(lookup('b1.0')).toEqual({ releaseTime: null, releaseTimeStatus: 'unknown' });
    expect(lookup('unlisted')).toEqual({ releaseTime: null, releaseTimeStatus: 'unknown' });
    expect(read).toHaveBeenCalledExactlyOnceWith(minecraftManifestUrl);
  });

  it('coalesces concurrent readers, caches five minutes and invalidates a changed user agent', async () => {
    let time = 0;
    const read = vi.fn(async () => document());
    const client = vi.fn(() => ({ read }));
    const lookup = createMinecraftReleaseDateLookup({ client, now: () => time });
    await Promise.all([lookup('first'), lookup('first'), lookup('first')]);
    expect(read).toHaveBeenCalledTimes(1);
    time = 299_999;
    await lookup('first');
    expect(read).toHaveBeenCalledTimes(1);
    time = 300_000;
    await lookup('first');
    expect(read).toHaveBeenCalledTimes(2);
    await lookup('second');
    expect(client).toHaveBeenLastCalledWith('second');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('reports a cached upstream failure without preventing existing catalog access, then retries', async () => {
    let time = 0;
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(document());
    const lookup = createMinecraftReleaseDateLookup({ client: () => ({ read }), now: () => time });
    expect((await lookup('fixture'))('26.1')).toEqual({
      releaseTime: null,
      releaseTimeStatus: 'unavailable',
    });
    await lookup('fixture');
    expect(read).toHaveBeenCalledTimes(1);
    time = 300_000;
    expect((await lookup('fixture'))('26.1').releaseTimeStatus).toBe('available');
  });

  it('does not expose invalid metadata or client configuration as a release date', async () => {
    const invalidDocument = createMinecraftReleaseDateLookup({
      client: () => ({ read: async () => ({ ...document(), bytes: Buffer.from('{broken') }) }),
    });
    expect((await invalidDocument('fixture'))('26.1').releaseTimeStatus).toBe('unavailable');
    const invalidConfig = createMinecraftReleaseDateLookup();
    expect((await invalidConfig(''))('26.1')).toEqual({
      releaseTime: null,
      releaseTimeStatus: 'unavailable',
    });
  });
});
