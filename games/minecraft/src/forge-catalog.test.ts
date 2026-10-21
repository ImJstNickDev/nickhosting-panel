import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  fetchForgeCatalog,
  forgeCatalogMetadataClient,
  forgeCatalogSnapshotSchema,
  forgeCatalogUrls,
} from './forge-catalog.js';
import type { RuntimeMetadataClient } from './runtime.js';

const timestamp = '2026-10-21T10:00:00.000Z';
function fixture(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    [forgeCatalogUrls.versions]: {
      '1.7.10': ['1.7.10-10.13.4.1614-1.7.10', '1.7.10-10.13.4.1448', '1.7.10-10.13.4.1614-branch'],
      '1.21.4': ['1.21.4-54.0.9', '1.21.4-54.1.16', '1.21.4-54.1.9'],
      '1.6.4': ['1.6.4-9.11.1.965'],
      '26.1': ['26.1-64.0.1'],
    },
    [forgeCatalogUrls.promotions]: {
      promos: {
        '1.7.10-recommended': '10.13.4.1614',
        '1.21.4-recommended': '54.1.9',
        '1.21.4-latest': '54.1.16',
      },
    },
    ...overrides,
  };
  const client = {
    read: vi.fn(async (url: string) => {
      const bytes = new TextEncoder().encode(JSON.stringify(responses[url]));
      return {
        bytes,
        evidence: {
          url,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          retrievedAt: timestamp,
        },
      };
    }),
  } satisfies RuntimeMetadataClient;
  return { client, responses };
}
it('loads two aggregate documents, preserves coordinates and sorts numerically newest first', async () => {
  const { client } = fixture();
  const snapshot = await fetchForgeCatalog(client);
  expect(client.read).toHaveBeenCalledTimes(2);
  expect(snapshot.versions.map((entry) => [entry.minecraftVersion, entry.javaMajor])).toEqual([
    ['1.21.4', 21],
    ['1.7.10', 8],
  ]);
  expect(snapshot.versions[0]?.loaders.map((entry) => entry.version)).toEqual([
    '54.1.16',
    '54.1.9',
    '54.0.9',
  ]);
  expect(snapshot.versions[1]?.loaders.find((entry) => entry.recommended)).toEqual({
    version: '10.13.4.1614-1.7.10',
    coordinate: '1.7.10-10.13.4.1614-1.7.10',
    recommended: true,
    latest: false,
  });
  expect(
    snapshot.versions[1]?.loaders.find((entry) => entry.version.endsWith('-branch'))?.recommended,
  ).toBe(false);
});
it('keeps unchanged document observation dates and resolves locally before artifact fallback', async () => {
  const { client } = fixture();
  const first = await fetchForgeCatalog(client);
  const read = client.read.getMockImplementation();
  if (!read) throw new Error('Missing fixture');
  client.read.mockImplementation(async (url) => {
    const value = await read(url);
    return { ...value, evidence: { ...value.evidence, retrievedAt: '2026-10-21T12:00:00.000Z' } };
  });
  expect(await fetchForgeCatalog(client, { previous: first })).toEqual(first);
  const fallback = {
    read: vi.fn(async () => {
      throw new Error('Fallback used');
    }),
  };
  const cached = forgeCatalogMetadataClient(first, fallback);
  expect((await cached.read(forgeCatalogUrls.versions)).evidence.retrievedAt).toBe(timestamp);
  expect(fallback.read).not.toHaveBeenCalled();
  await expect(
    cached.read('https://maven.minecraftforge.net/pinned-installer.jar.sha1'),
  ).rejects.toThrow('Fallback used');
});
it.each([
  { '1.21.4': ['1.21.5-54.1.16'] },
  { '1.21.4': ['1.21.4-54.1.16', '1.21.4-54.1.16'] },
  { '1.21.4': ['1.21.4-../bad'] },
  {},
])('rejects malformed coordinate catalogs', async (metadata) => {
  await expect(
    fetchForgeCatalog(fixture({ [forgeCatalogUrls.versions]: metadata }).client),
  ).rejects.toThrow();
});
it('rejects corrupted provenance or derived selection, and never publishes a partial refresh', async () => {
  const { client } = fixture();
  const first = await fetchForgeCatalog(client);
  const changed = structuredClone(first);
  if (changed.versions[0]) changed.versions[0].javaMajor = 8;
  expect(forgeCatalogSnapshotSchema.safeParse(changed).success).toBe(false);
  const bad = structuredClone(first);
  const corrupted = bad.documents[forgeCatalogUrls.versions];
  if (corrupted) corrupted.evidence.sha256 = '0'.repeat(64);
  expect(forgeCatalogSnapshotSchema.safeParse(bad).success).toBe(false);
  const read = client.read.getMockImplementation();
  if (!read) throw new Error('Missing fixture');
  client.read.mockImplementation(async (url) => {
    if (url === forgeCatalogUrls.promotions) throw new Error('upstream unavailable');
    return read(url);
  });
  await expect(fetchForgeCatalog(client, { previous: first })).rejects.toThrow(
    'upstream unavailable',
  );
  expect(forgeCatalogSnapshotSchema.safeParse(first).success).toBe(true);
});
