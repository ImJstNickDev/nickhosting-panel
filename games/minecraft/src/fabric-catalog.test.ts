import { expect, it, vi } from 'vitest';
import {
  fabricCatalogSnapshotSchema,
  fabricCatalogUrls,
  fabricGameLoadersUrl,
  fetchFabricCatalog,
} from './fabric-catalog.js';
import type { RuntimeMetadataClient } from './runtime.js';

const timestamp = '2026-10-19T12:00:00.000Z';
const now = () => new Date(timestamp);
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
const pairs = (...items: string[]) => items.map((version) => ({ loader: { version } }));
it('reads root catalogs and per-game associations, preserving catalog order and stable flags', async () => {
  const source = fixture({
    games: [
      { version: '26.4-snapshot-1', stable: false },
      { version: '26.3', stable: true },
    ],
  });
  const result = await fetchFabricCatalog(source, { now });
  expect(result.games.map((item) => item.version)).toEqual(['26.4-snapshot-1', '26.3']);
  expect(result.games[0]?.stable).toBe(false);
  expect(result.loaders).toEqual([{ version: '1.0', stable: true }]);
  expect(source.read.mock.calls.map(([url]) => url)).toEqual([
    ...Object.values(fabricCatalogUrls),
    fabricGameLoadersUrl('26.4-snapshot-1'),
    fabricGameLoadersUrl('26.3'),
  ]);
  expect(result.relations).toEqual({
    checkedAt: timestamp,
    loaderSets: [['1.0']],
    gameLoaderSets: { '26.4-snapshot-1': 0, '26.3': 0 },
  });
});
it('normalizes equivalent associations without duplicating metadata or inferring unsupported pairs', async () => {
  const result = await fetchFabricCatalog(
    fixture(
      { games: versions('a', 'b', 'c', 'd'), loaders: versions('2.0', '1.0', '0.9') },
      { a: pairs('1.0', '2.0'), b: pairs('2.0', '1.0'), c: pairs('0.9'), d: [] },
    ),
    { now },
  );
  expect(result.relations).toEqual({
    checkedAt: timestamp,
    loaderSets: [['2.0', '1.0'], ['0.9'], []],
    gameLoaderSets: { a: 0, b: 0, c: 1, d: 2 },
  });
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
  expect(source.read).toHaveBeenCalledWith(
    'https://meta.fabricmc.net/v2/versions/loader/1.14%20Pre-Release%205',
  );
  await expect(fetchFabricCatalog(fixture({ loaders: historical }))).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
});
it('accepts the intermediary placeholder for unobfuscated Minecraft releases', async () => {
  await expect(
    fetchFabricCatalog(
      fixture(
        { games: versions('26.1') },
        {
          '26.1': [{ loader: { version: '1.0' }, intermediary: { version: '0.0.0' } }],
        },
      ),
    ),
  ).resolves.toMatchObject({ relations: { gameLoaderSets: { '26.1': 0 } } });
});
it.each([pairs('missing'), pairs('1.0', '1.0'), pairs('../bad'), [{ loader: { version: 1 } }], {}])(
  'rejects malformed, duplicate and unknown per-game loader versions',
  async (association) => {
    await expect(
      fetchFabricCatalog(fixture(undefined, { '1.0': association })),
    ).rejects.toMatchObject({
      details: { reason: 'fabric_metadata_invalid' },
    });
  },
);
it('reuses associations, checks new games only and retains the full refresh timestamp', async () => {
  const previous = await fetchFabricCatalog(fixture({ games: versions('a') }), { now });
  const unchanged = fixture({ games: versions('a') });
  const incremental = fixture({ games: versions('a', 'b') });
  await fetchFabricCatalog(unchanged, { previous });
  expect(unchanged.read).toHaveBeenCalledTimes(3);
  const result = await fetchFabricCatalog(incremental, { previous });
  expect(incremental.read.mock.calls.map(([url]) => url)).toEqual([
    ...Object.values(fabricCatalogUrls),
    fabricGameLoadersUrl('b'),
  ]);
  expect(result.relations?.checkedAt).toBe(timestamp);
});
it('refreshes every association after loader changes or explicit periodic revalidation', async () => {
  const previous = await fetchFabricCatalog(fixture({ games: versions('a', 'b') }), { now });
  const changed = fixture({ games: versions('a', 'b'), loaders: versions('1.1', '1.0') });
  const forced = fixture({ games: versions('a', 'b') });
  const later = () => new Date('2026-10-20T12:00:00.000Z');
  expect((await fetchFabricCatalog(changed, { previous, now: later })).relations?.checkedAt).toBe(
    later().toISOString(),
  );
  expect(
    (await fetchFabricCatalog(forced, { previous, forceRelationsRefresh: true, now: later }))
      .relations?.checkedAt,
  ).toBe(later().toISOString());
  expect(changed.read).toHaveBeenCalledTimes(5);
  expect(forced.read).toHaveBeenCalledTimes(5);
});
it('keeps legacy snapshots readable and backfills their missing associations', async () => {
  const previous = fabricCatalogSnapshotSchema.parse({
    games: versions('a'),
    loaders: versions('1.0'),
    installers: versions('1.0'),
  });
  const source = fixture({ games: versions('a') });
  expect((await fetchFabricCatalog(source, { previous })).relations).toBeDefined();
  expect(source.read).toHaveBeenCalledTimes(4);
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
  expect(onProgress).toHaveBeenCalledTimes(8);
});
it('waits for an in-flight sibling and schedules no further reads after a pair failure', async () => {
  const source = fixture({ games: versions('a', 'b', 'c') });
  const read = source.read.getMockImplementation();
  if (!read) throw new Error('Missing fixture implementation');
  const sibling = deferred();
  const started = deferred();
  source.read.mockImplementation(async (url) => {
    if (url === fabricGameLoadersUrl('a')) throw new Error('upstream unavailable');
    if (url === fabricGameLoadersUrl('b')) {
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
  expect(source.read).not.toHaveBeenCalledWith(fabricGameLoadersUrl('c'));
  sibling.resolve();
  await rejected;
  expect(source.read).not.toHaveBeenCalledWith(fabricGameLoadersUrl('c'));
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
  const snapshot = await fetchFabricCatalog(fixture({ games: versions('a', 'b') }), { now });
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
    // Model cumulative client bytes without allocating a half-gigabyte test buffer.
    Object.defineProperty(document.bytes, 'byteLength', { value: 180 * 1024 * 1024 });
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
