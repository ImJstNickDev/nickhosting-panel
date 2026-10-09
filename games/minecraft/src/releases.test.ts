import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createMinecraftProtocolAdapter } from './protocol.js';
import { fetchMinecraftProtocols } from './releases.js';

function fixture(value: unknown) {
  const body = JSON.stringify(value);
  return {
    source: { commit: 'a'.repeat(40), sha256: createHash('sha256').update(body).digest('hex') },
    fetcher: vi.fn(async () => new Response(body)),
  };
}
describe('pinned updateable release/protocol metadata', () => {
  it('keeps release names, family and wire identity separate, including legacy ID reuse', async () => {
    const data = fixture([
      { minecraftVersion: '1.4.2', version: 47, usesNetty: false },
      { minecraftVersion: '1.8', version: 47, usesNetty: true, releaseType: 'release' },
      { minecraftVersion: '26.3', version: 777, usesNetty: true, releaseType: 'release' },
      {
        minecraftVersion: '26.4-snapshot-2',
        version: 1073742164,
        usesNetty: true,
        releaseType: 'snapshot',
      },
    ]);
    const result = await fetchMinecraftProtocols(data.source, data.fetcher);
    expect(result.releases.get('1.4.2')?.releaseType).toBe('unknown');
    expect(result.releases.get('26.3')).toMatchObject({ protocolId: 777, transfer: true });
    expect(result.releases.get('26.4-snapshot-2')?.transfer).toBe(false);
    expect(() =>
      createMinecraftProtocolAdapter({
        versions: [...result.releases.values()],
        supportedReleases: ['26.3'],
      }),
    ).not.toThrow();
    expect(data.fetcher).toHaveBeenCalledWith(
      expect.stringContaining(data.source.commit),
      expect.objectContaining({ redirect: 'error' }),
    );
  });
  it('fails closed on changed bytes, duplicate identities, malformed metadata or invalid pins', async () => {
    const rows = [
      { minecraftVersion: '26.3', version: 777, usesNetty: true, releaseType: 'release' },
    ];
    const good = fixture(rows);
    await expect(
      fetchMinecraftProtocols({ ...good.source, sha256: '0'.repeat(64) }, good.fetcher),
    ).rejects.toThrow('integration_unavailable');
    const duplicate = fixture([...rows, ...rows]);
    await expect(fetchMinecraftProtocols(duplicate.source, duplicate.fetcher)).rejects.toThrow(
      'integration_unavailable',
    );
    const malformed = fixture([{ ...rows[0], version: -1 }]);
    await expect(fetchMinecraftProtocols(malformed.source, malformed.fetcher)).rejects.toThrow(
      'integration_unavailable',
    );
    await expect(
      fetchMinecraftProtocols({ ...good.source, commit: '../main' }, good.fetcher),
    ).rejects.toThrow('configuration_invalid');
    const huge = vi.fn(async () => new Response(' '.repeat(4 * 1024 * 1024 + 1)));
    await expect(fetchMinecraftProtocols(good.source, huge)).rejects.toThrow(
      'integration_unavailable',
    );
  });
});
