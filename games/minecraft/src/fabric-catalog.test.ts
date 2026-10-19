import { expect, it, vi } from 'vitest';
import { fabricCatalogUrls, fetchFabricCatalog } from './fabric-catalog.js';
import type { RuntimeMetadataClient } from './runtime.js';

function fixture(documents?: Partial<Record<keyof typeof fabricCatalogUrls, unknown>>) {
  return {
    read: vi.fn(async (url: string) => ({
      bytes: new TextEncoder().encode(
        JSON.stringify(
          documents?.[
            Object.entries(fabricCatalogUrls).find(
              ([, value]) => value === url,
            )?.[0] as keyof typeof fabricCatalogUrls
          ] ?? [{ version: '1.0', stable: true, ignored: 'metadata' }],
        ),
      ),
      evidence: { url, sha256: 'a'.repeat(64), retrievedAt: new Date().toISOString() },
    })),
  } satisfies RuntimeMetadataClient;
}
it('reads precisely three catalogs concurrently, preserving upstream order and stable flags', async () => {
  const source = fixture({
    games: [
      { version: '26.4-snapshot-1', stable: false },
      { version: '26.3', stable: true },
    ],
  });
  const result = await fetchFabricCatalog(source);
  expect(result.games.map((item) => item.version)).toEqual(['26.4-snapshot-1', '26.3']);
  expect(result.games[0]?.stable).toBe(false);
  expect(result.loaders).toEqual([{ version: '1.0', stable: true }]);
  expect(source.read.mock.calls.map(([url]) => url)).toEqual(Object.values(fabricCatalogUrls));
});
it.each(
  [
    [],
    [
      { version: 'a', stable: true },
      { version: 'a', stable: false },
    ],
    [{ version: '../bad', stable: true }],
    [{ version: '1.0', stable: 'true' }],
    Array.from({ length: 20_001 }, (_, i) => ({ version: String(i), stable: true })),
  ].map((games) => ({ games })),
)('rejects an invalid complete snapshot', async ({ games }) => {
  await expect(fetchFabricCatalog(fixture({ games }))).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
});
it('rejects malformed JSON/UTF8 without exposing upstream contents', async () => {
  const source = fixture();
  source.read.mockResolvedValue({
    bytes: new Uint8Array([255]),
    evidence: { url: 'secret', sha256: '', retrievedAt: '' },
  });
  await expect(fetchFabricCatalog(source)).rejects.toMatchObject({
    details: { reason: 'fabric_metadata_invalid' },
  });
});

it('retains historical Minecraft pre-release names without accepting them as loader coordinates', async () => {
  const historical = [{ version: '1.14 Pre-Release 5', stable: false }];
  expect((await fetchFabricCatalog(fixture({ games: historical }))).games).toEqual(historical);
  await expect(fetchFabricCatalog(fixture({ loaders: historical }))).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
});
