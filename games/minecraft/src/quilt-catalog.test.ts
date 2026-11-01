import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  fetchQuiltCatalog,
  quiltCatalogMetadataClient,
  quiltCatalogSnapshotSchema,
  quiltCatalogUrls,
} from './quilt-catalog.js';
import type { RuntimeMetadataClient } from './runtime.js';

const installer = {
  version: '0.15.1',
  maven: 'org.quiltmc:quilt-installer:0.15.1',
  url: 'https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.15.1/quilt-installer-0.15.1.jar',
  file_size: 500,
  hashes: { sha256: 'a'.repeat(64) },
};
function fixture(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    [quiltCatalogUrls.games]: [
      { version: '26.4-snapshot-6', stable: false },
      { version: '26.3', stable: true },
    ],
    [quiltCatalogUrls.loaders]: [
      {
        version: '0.30.2',
        maven: 'org.quiltmc:quilt-loader:0.30.2',
        file_size: 500,
        hashes: { sha256: 'b'.repeat(64) },
      },
      {
        version: '0.31.0-beta.5',
        maven: 'org.quiltmc:quilt-loader:0.31.0-beta.5',
        file_size: 500,
        hashes: { sha256: 'c'.repeat(64) },
      },
    ],
    [quiltCatalogUrls.installers]: [installer],
    ...overrides,
  };
  const calls: string[] = [];
  const client: RuntimeMetadataClient = {
    async read(url) {
      calls.push(url);
      const bytes = Buffer.from(JSON.stringify(values[url]));
      return {
        bytes,
        evidence: {
          url,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          retrievedAt: '2026-10-31T00:00:00Z',
        },
      };
    },
  };
  return { client, calls };
}
describe('Quilt exact independent catalog', () => {
  it('discovers releases, snapshots and loader prereleases with only three bounded requests', async () => {
    const f = fixture();
    const snapshot = await fetchQuiltCatalog(f.client);
    expect(f.calls).toEqual(Object.values(quiltCatalogUrls));
    expect(snapshot.games[0]).toEqual({ version: '26.4-snapshot-6', stable: false });
    expect(snapshot.loaders.map((item) => item.stable)).toEqual([true, false]);
    expect(snapshot.installers[0]).toMatchObject({
      version: '0.15.1',
      sha256: 'a'.repeat(64),
      size: 500,
    });
    expect(snapshot).not.toHaveProperty('relations');
  });
  it.each([
    { ...installer, url: 'https://example.org/a.jar' },
    { ...installer, maven: 'org.other:installer:0.15.1' },
    { ...installer, hashes: { sha256: 'bad' } },
    { ...installer, file_size: 0 },
  ])('rejects invalid installer identity or integrity %j', async (value) => {
    await expect(
      fetchQuiltCatalog(fixture({ [quiltCatalogUrls.installers]: [value] }).client),
    ).rejects.toThrow();
  });
  it('rejects duplicates and invalid game identifiers', async () => {
    await expect(
      fetchQuiltCatalog(fixture({ [quiltCatalogUrls.installers]: [installer, installer] }).client),
    ).rejects.toThrow();
    await expect(
      fetchQuiltCatalog(
        fixture({ [quiltCatalogUrls.games]: [{ version: '../26.3', stable: true }] }).client,
      ),
    ).rejects.toThrow();
  });
  it('rejects source checksum or normalized cache tampering', async () => {
    const snapshot = await fetchQuiltCatalog(fixture().client);
    const altered = structuredClone(snapshot);
    const first = altered.games[0];
    if (!first) throw new Error('Missing fixture');
    first.stable = true;
    expect(quiltCatalogSnapshotSchema.safeParse(altered).success).toBe(false);
    const raw = structuredClone(snapshot);
    const document = raw.documents[quiltCatalogUrls.games];
    if (!document) throw new Error('Missing fixture');
    document.json += ' ';
    expect(quiltCatalogSnapshotSchema.safeParse(raw).success).toBe(false);
  });
  it('freezes accepted installer bytes while allowing exact pair metadata fallback', async () => {
    const f = fixture();
    const snapshot = await fetchQuiltCatalog(f.client);
    const fallbackCalls: string[] = [];
    const client = quiltCatalogMetadataClient(snapshot, {
      async read(url) {
        fallbackCalls.push(url);
        return f.client.read(quiltCatalogUrls.loaders);
      },
    });
    expect(
      JSON.parse(Buffer.from((await client.read(quiltCatalogUrls.installers)).bytes).toString()),
    ).toEqual([installer]);
    expect(fallbackCalls).toEqual([]);
    await client.read('https://meta.quiltmc.org/v3/versions/loader/26.3/0.30.2');
    expect(fallbackCalls).toHaveLength(1);
  });
  it('preserves original evidence timestamps for unchanged refreshed bytes', async () => {
    const f = fixture();
    const previous = await fetchQuiltCatalog(f.client);
    const refreshed = await fetchQuiltCatalog(
      {
        async read(url) {
          const source = await f.client.read(url);
          return {
            ...source,
            evidence: { ...source.evidence, retrievedAt: '2026-11-01T00:00:00Z' },
          };
        },
      },
      { previous },
    );
    expect(refreshed).toEqual(previous);
  });
  it('checks publication progress around each request and rejects mismatched provenance', async () => {
    let progress = 0;
    await fetchQuiltCatalog(fixture().client, {
      onProgress: () => {
        progress++;
      },
    });
    expect(progress).toBe(6);
    const f = fixture();
    await expect(
      fetchQuiltCatalog({
        async read(url) {
          const d = await f.client.read(url);
          return { ...d, evidence: { ...d.evidence, sha256: '0'.repeat(64) } };
        },
      }),
    ).rejects.toThrow();
  });
});
