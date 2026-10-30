import { expect, it, vi } from 'vitest';
import {
  fabricCatalogSnapshotSchema,
  fabricCatalogUrls,
  fetchFabricCatalog,
} from './fabric-catalog.js';
import type { RuntimeMetadataClient } from './runtime.js';

const timestamp = '2026-10-19T12:00:00.000Z';
function deferred() {
  let resolve: () => void = () => {
    throw new Error('Deferred not initialized');
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function fixture(
  documents?: Partial<Record<keyof typeof fabricCatalogUrls, unknown>>,
  associations?: Record<string, unknown>,
) {
  return {
    read: vi.fn(async (url: string) => {
      const kind = Object.entries(fabricCatalogUrls).find(([, value]) => value === url)?.[0] as
        | keyof typeof fabricCatalogUrls
        | undefined;
      const game = decodeURIComponent(url.slice(`${fabricCatalogUrls.loaders}/`.length));
      return {
        bytes: new TextEncoder().encode(
          JSON.stringify(
            kind
              ? (documents?.[kind] ?? [{ version: '1.0', stable: true, ignored: 'metadata' }])
              : (associations?.[game] ?? [
                  { loader: { version: '1.0' }, intermediary: { version: game } },
                ]),
          ),
        ),
        evidence: { url, sha256: 'a'.repeat(64), retrievedAt: timestamp },
      };
    }),
  } satisfies RuntimeMetadataClient;
}
const versions = (...items: string[]) => items.map((version) => ({ version, stable: true }));
it('reads exactly three catalogs, preserving upstream order and recommendation flags', async () => {
  const source = fixture({
    games: [
      { version: '26.4-snapshot-1', stable: false },
      { version: '26.3', stable: true },
    ],
  });
  const result = await fetchFabricCatalog(source);
  expect(result.games.map((item) => item.version)).toEqual(['26.4-snapshot-1', '26.3']);
  expect(result.games[0]?.stable).toBe(false);
  expect(source.read.mock.calls.map(([url]) => url)).toEqual(Object.values(fabricCatalogUrls));
  expect(result.relations).toBeUndefined();
});
it('does not expand thousands of independent game/loader selections', async () => {
  const source = fixture({
    games: versions(...Array.from({ length: 1000 }, (_, i) => `1.${i}`)),
    loaders: versions(...Array.from({ length: 2500 }, (_, i) => `0.${i}`)),
  });
  const result = await fetchFabricCatalog(source);
  expect(result.games).toHaveLength(1000);
  expect(result.loaders).toHaveLength(2500);
  expect(source.read).toHaveBeenCalledTimes(3);
  expect(result.relations).toBeUndefined();
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
it('encodes historical game IDs and rejects them as loader coordinates', async () => {
  const historical = [{ version: '1.14 Pre-Release 5', stable: false }];
  const source = fixture({ games: historical });
  expect((await fetchFabricCatalog(source)).games).toEqual(historical);
  expect(source.read).toHaveBeenCalledTimes(3);
  await expect(fetchFabricCatalog(fixture({ loaders: historical }))).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
});
it('checks progress before and after each batch, bounding all requests to two in flight', async () => {
  const source = fixture({ games: versions('a', 'b', 'c') });
  const read = source.read.getMockImplementation();
  if (!read) throw new Error('Missing fixture implementation');
  let active = 0;
  let maximum = 0;
  source.read.mockImplementation(async (url) => {
    active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    const result = await read(url);
    active--;
    return result;
  });
  const onProgress = vi.fn(async () => {
    expect(active).toBe(0);
  });
  await fetchFabricCatalog(source, { onProgress });
  expect(maximum).toBe(2);
  expect(onProgress).toHaveBeenCalledTimes(4);
});
it('settles in-flight root requests before failing without scheduling further reads', async () => {
  const source = fixture();
  const read = source.read.getMockImplementation();
  if (!read) throw new Error('Missing fixture implementation');
  const sibling = deferred();
  const started = deferred();
  source.read.mockImplementation(async (url) => {
    if (url === fabricCatalogUrls.games) throw new Error('upstream unavailable');
    if (url === fabricCatalogUrls.loaders) {
      started.resolve();
      await sibling.promise;
    }
    return read(url);
  });
  let settled = false;
  const result = fetchFabricCatalog(source).finally(() => {
    settled = true;
  });
  const rejected = expect(result).rejects.toThrow('upstream unavailable');
  await started.promise;
  expect(settled).toBe(false);
  sibling.resolve();
  await rejected;
  expect(source.read).not.toHaveBeenCalledWith(fabricCatalogUrls.installers);
});
it('stops before issuing requests when the progress hook rejects', async () => {
  const source = fixture();
  await expect(
    fetchFabricCatalog(source, {
      onProgress: async () => {
        throw new Error('lease lost');
      },
    }),
  ).rejects.toThrow('lease lost');
  expect(source.read).not.toHaveBeenCalled();
});
it('bounds the number of per-game requests before fetching associations', async () => {
  const source = fixture({ games: versions(...Array.from({ length: 2001 }, (_, i) => String(i))) });
  await expect(fetchFabricCatalog(source)).rejects.toMatchObject({
    details: { reason: 'fabric_metadata_budget_exceeded' },
  });
  expect(source.read).toHaveBeenCalledTimes(3);
});
it('rejects dangling, missing, foreign and duplicate normalized relations', async () => {
  const snapshot = await fetchFabricCatalog(fixture({ games: versions('a', 'b') }));
  const malformed = [
    { loaderSets: [['1.0']], gameLoaderSets: { a: 0 } },
    { loaderSets: [['1.0']], gameLoaderSets: { a: 0, b: 1 } },
    { loaderSets: [['1.0']], gameLoaderSets: { a: 0, c: 0 } },
    { loaderSets: [['unknown']], gameLoaderSets: { a: 0, b: 0 } },
    { loaderSets: [['1.0', '1.0']], gameLoaderSets: { a: 0, b: 0 } },
    { loaderSets: [['1.0'], ['1.0']], gameLoaderSets: { a: 0, b: 1 } },
    { loaderSets: [['1.0'], []], gameLoaderSets: { a: 0, b: 0 } },
  ];
  for (const relations of malformed)
    expect(
      fabricCatalogSnapshotSchema.safeParse({
        ...snapshot,
        relations: { checkedAt: timestamp, ...relations },
      }).success,
    ).toBe(false);
});

it('bounds cumulative bytes before decoding further documents', async () => {
  const source = fixture({ games: versions('a', 'b', 'c') });
  const read = source.read.getMockImplementation();
  if (!read) throw new Error('Missing fixture implementation');
  source.read.mockImplementation(async (url) => {
    const document = await read(url);
    // Model cumulative client bytes without allocating a large test buffer.
    Object.defineProperty(document.bytes, 'byteLength', { value: 3 * 1024 * 1024 });
    return document;
  });
  await expect(fetchFabricCatalog(source)).rejects.toMatchObject({
    details: { reason: 'fabric_metadata_budget_exceeded' },
  });
  expect(source.read).toHaveBeenCalledTimes(3);
});
it('does not schedule the installer or per-game reads after a root-list failure', async () => {
  const source = fixture({ games: [] });
  await expect(fetchFabricCatalog(source)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
  expect(source.read.mock.calls.map(([url]) => url)).toEqual([
    fabricCatalogUrls.games,
    fabricCatalogUrls.loaders,
  ]);
});
