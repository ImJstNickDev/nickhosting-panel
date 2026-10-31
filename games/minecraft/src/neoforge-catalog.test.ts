import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  fetchNeoForgeCatalog,
  neoforgeCatalogMetadataClient,
  neoforgeCatalogSnapshotSchema,
  neoforgeCatalogUrls,
  parseNeoForgeVersions,
} from './neoforge-catalog.js';
import { neoforgeJavaMajor, neoforgeMinecraftVersion } from './neoforge-policy.js';
import type { RuntimeMetadataClient } from './runtime.js';

function xml(artifact: string, versions: string[]) {
  return `<?xml version="1.0" encoding="UTF-8"?><metadata><groupId>net.neoforged</groupId><artifactId>${artifact}</artifactId><versioning><latest>${versions[0]}</latest><release>${versions[0]}</release><versions>${versions.map((v) => `<version>${v}</version>`).join('')}</versions><lastUpdated>20261031000000</lastUpdated></versioning></metadata>`;
}
function fixture() {
  return {
    read: vi.fn(async (url: string) => {
      const bytes = new TextEncoder().encode(
        url === neoforgeCatalogUrls.legacy
          ? xml('forge', ['1.20.1-47.1.106'])
          : xml('neoforge', [
              '20.2.93',
              '21.0.1-beta',
              '21.1.9',
              '21.1.10',
              '26.1.0.1-beta',
              '26.1.2.9',
              '26.1.0.0-alpha.1+snapshot-1',
            ]),
      );
      return {
        bytes,
        evidence: {
          url,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          retrievedAt: '2026-10-31T00:00:00.000Z',
        },
      };
    }),
  } satisfies RuntimeMetadataClient;
}
it('derives exact legacy, modern and calendar pairs with numeric ordering using two aggregate reads', async () => {
  const client = fixture();
  const snapshot = await fetchNeoForgeCatalog(client);
  expect(client.read).toHaveBeenCalledTimes(2);
  expect(snapshot.versions.map((v) => [v.minecraftVersion, v.javaMajor])).toEqual([
    ['26.1.2', 25],
    ['26.1', 25],
    ['1.21.1', 21],
    ['1.21', 21],
    ['1.20.2', 17],
    ['1.20.1', 17],
  ]);
  expect(snapshot.versions[2]?.loaders.map((v) => v.version)).toEqual(['21.1.10', '21.1.9']);
  expect(snapshot.versions.at(-1)?.loaders[0]).toEqual({
    version: '1.20.1-47.1.106',
    coordinate: '1.20.1-47.1.106',
    latest: true,
    recommended: false,
  });
  expect(await fetchNeoForgeCatalog(client, { previous: snapshot })).toEqual(snapshot);
  const fallback = {
    read: vi.fn(async () => {
      throw new Error('fallback');
    }),
  };
  expect(
    (await neoforgeCatalogMetadataClient(snapshot, fallback).read(neoforgeCatalogUrls.versions))
      .bytes,
  ).toBeDefined();
  expect(fallback.read).not.toHaveBeenCalled();
  const first = snapshot.versions[0];
  if (!first) throw new Error('Missing version');
  first.minecraftVersion = '1.21.1';
  expect(neoforgeCatalogSnapshotSchema.safeParse(snapshot).success).toBe(false);
});
it.each([
  '<!DOCTYPE x><metadata/>',
  xml('neoforge', ['21.1.9', '21.1.9']),
  xml('forge', ['21.1.9']),
  xml('neoforge', ['&evil;']),
  xml('neoforge', ['../21']),
  xml('neoforge', ['21.1.9']).replace('</versions>', '<extra/></versions>'),
  'x'.repeat(4 * 1024 * 1024 + 1),
])('rejects malformed or unsafe XML (%#)', (value) => {
  expect(() => parseNeoForgeVersions(value, 'neoforge')).toThrow();
});
it('rejects bad source provenance and retains no partial refresh', async () => {
  const client = fixture();
  const read = client.read.getMockImplementation();
  if (!read) throw new Error('Missing mock');
  client.read.mockImplementation(async (url) => ({
    ...(await read(url)),
    evidence: { url, sha256: 'a'.repeat(64), retrievedAt: '2026-10-31T00:00:00Z' },
  }));
  await expect(fetchNeoForgeCatalog(client)).rejects.toThrow();
});
it('does not mistake malformed, snapshot or unrelated loader versions for supported pairs', () => {
  for (const v of [
    'latest',
    '21.01.1',
    '20.1.1',
    '26.1.0.0-alpha.1+snapshot-1',
    '27.1.0.1',
    '1.20.1-48.1.1',
  ])
    expect(neoforgeMinecraftVersion(v)).toBeUndefined();
  expect(neoforgeMinecraftVersion('21.0.1-beta')).toBe('1.21');
  expect(neoforgeJavaMajor('1.20.4')).toBe(17);
  expect(neoforgeJavaMajor('1.20.6')).toBe(21);
  expect(neoforgeJavaMajor('26.1')).toBe(25);
  expect(() => neoforgeJavaMajor('26.1-snapshot-1')).toThrow();
});
