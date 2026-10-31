import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  fetchPurpurCatalog,
  purpurCatalogMetadataClient,
  purpurCatalogSnapshotSchema,
  purpurCatalogUrl,
} from './purpur-catalog.js';
import type { RuntimeMetadataClient } from './runtime.js';

const timestamp = '2026-10-31T10:00:00.000Z';
const url = (version: string) => `${purpurCatalogUrl}/${version}`;
function fixture(versions = ['1.21.11', '26.3']) {
  const responses: Record<string, unknown> = {
    [purpurCatalogUrl]: { project: 'purpur', versions },
  };
  for (const version of versions) {
    responses[url(version)] = {
      project: 'purpur',
      version,
      builds: { latest: '5', all: ['3', '5', '4'] },
    };
    responses[`${url(version)}/5`] = {
      project: 'purpur',
      version,
      build: '5',
      result: 'SUCCESS',
      timestamp: Date.parse(timestamp),
      md5: 'a'.repeat(32),
      metadata: { retained: true },
    };
  }
  const client = {
    read: vi.fn(async (input: string) => {
      if (!Object.hasOwn(responses, input)) throw new Error('Unavailable fixture');
      const bytes = new TextEncoder().encode(JSON.stringify(responses[input]));
      return {
        bytes,
        evidence: {
          url: input,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          retrievedAt: timestamp,
        },
      };
    }),
  } satisfies RuntimeMetadataClient;
  return { responses, client };
}
it('selects exact successful latest builds and retains original response bytes', async () => {
  const { client, responses } = fixture();
  const snapshot = await fetchPurpurCatalog(client);
  expect(snapshot.versions).toEqual([
    { version: '1.21.11', buildId: 5, javaMajor: 21, buildTime: timestamp },
    { version: '26.3', buildId: 5, javaMajor: 25, buildTime: timestamp },
  ]);
  expect(snapshot.documents[`${url('26.3')}/5`]?.json).toBe(
    JSON.stringify(responses[`${url('26.3')}/5`]),
  );
  expect(client.read).toHaveBeenCalledTimes(5);
  expect(purpurCatalogSnapshotSchema.safeParse(snapshot).success).toBe(true);
});
it('reuses unchanged exact build metadata and replaces only the next snapshot on newer latest', async () => {
  const { client, responses } = fixture(['26.3']);
  const first = await fetchPurpurCatalog(client);
  client.read.mockClear();
  expect(await fetchPurpurCatalog(client, { previous: first })).toEqual(first);
  expect(client.read.mock.calls.map(([value]) => value)).toEqual([purpurCatalogUrl, url('26.3')]);
  responses[url('26.3')] = {
    project: 'purpur',
    version: '26.3',
    builds: { latest: '6', all: ['5', '6'] },
  };
  responses[`${url('26.3')}/6`] = { ...(responses[`${url('26.3')}/5`] as object), build: '6' };
  const next = await fetchPurpurCatalog(client, { previous: first });
  expect(next.versions[0]?.buildId).toBe(6);
  expect(next.documents[`${url('26.3')}/5`]).toBeUndefined();
  expect(first.versions[0]?.buildId).toBe(5);
});
it.each([
  { project: 'paper' },
  { version: '1.21.11' },
  { build: '15' },
  { build: '05' },
  { result: 'FAILURE' },
  { md5: 'a'.repeat(31) },
  { timestamp: -1 },
  { build: '9007199254740993' },
])('fails closed on invalid latest build metadata %j', async (override) => {
  const { client, responses } = fixture(['26.3']);
  responses[`${url('26.3')}/5`] = { ...(responses[`${url('26.3')}/5`] as object), ...override };
  await expect(fetchPurpurCatalog(client)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
});
it.each([
  { latest: '5', all: ['15'] },
  { latest: '5', all: ['5', '5'] },
  { latest: 'latest', all: ['5'] },
])('requires exact membership and unambiguous build identifiers %j', async (builds) => {
  const { client, responses } = fixture(['26.3']);
  responses[url('26.3')] = { project: 'purpur', version: '26.3', builds };
  await expect(fetchPurpurCatalog(client)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
});
it.each([['26.3', '26.3'], ['../26.3'], ['26.3;id'], []])(
  'rejects invalid project versions %j',
  async (...versions) => {
    const { client } = fixture(versions);
    await expect(fetchPurpurCatalog(client)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
  },
);
it('rejects modified derived values, document digests and unexpected cached origins', async () => {
  const snapshot = await fetchPurpurCatalog(fixture().client);
  for (const mutate of [
    (s: typeof snapshot) => {
      if (s.versions[0]) s.versions[0].buildId = 99;
    },
    (s: typeof snapshot) => {
      if (s.versions[0]) s.versions[0].javaMajor = 8;
    },
    (s: typeof snapshot) => {
      const d = s.documents[purpurCatalogUrl];
      if (d) d.evidence.sha256 = 'b'.repeat(64);
    },
    (s: typeof snapshot) => {
      const d = s.documents[purpurCatalogUrl];
      if (d) s.documents['https://evil.test/'] = d;
    },
  ]) {
    const changed = structuredClone(snapshot);
    mutate(changed);
    expect(purpurCatalogSnapshotSchema.safeParse(changed).success).toBe(false);
  }
});
it('never falls back to mutable Purpur metadata when an exact snapshot document is absent', async () => {
  const snapshot = await fetchPurpurCatalog(fixture().client);
  const fallback = {
    read: vi.fn(async () => {
      throw new Error('fallback reached');
    }),
  };
  const client = purpurCatalogMetadataClient(snapshot, fallback);
  expect((await client.read(`${url('26.3')}/5`)).evidence).toEqual(
    snapshot.documents[`${url('26.3')}/5`]?.evidence,
  );
  await expect(client.read(`${url('26.3')}/6`)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
  expect(fallback.read).not.toHaveBeenCalled();
  await expect(client.read('https://piston-meta.mojang.com/fixture')).rejects.toThrow(
    'fallback reached',
  );
});
it('rejects evidence mismatches before caching', async () => {
  const { client } = fixture();
  const original = client.read.getMockImplementation();
  if (!original) throw new Error('fixture missing');
  client.read.mockImplementation(async (input) => {
    const result = await original(input);
    return { ...result, evidence: { ...result.evidence, sha256: 'b'.repeat(64) } };
  });
  await expect(fetchPurpurCatalog(client)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
});
