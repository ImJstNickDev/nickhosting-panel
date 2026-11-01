import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  fetchPaperCatalog,
  paperCatalogMetadataClient,
  paperCatalogSnapshotSchema,
  paperCatalogUrl,
} from './paper-catalog.js';
import type { RuntimeMetadataClient } from './runtime.js';

const timestamp = '2026-10-21T10:00:00.000Z';
const url = (version: string) => `${paperCatalogUrl}/versions/${version}`;
function fixture(versions = ['1.21.11', '1.7.10'], overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    [paperCatalogUrl]: { project: { id: 'paper' }, versions: { fixtures: versions } },
  };
  for (const version of versions) {
    responses[url(version)] = {
      version: { id: version, java: { version: { minimum: version === '1.7.10' ? 6 : 21 } } },
      builds: [3, 5, 4],
    };
    responses[`${url(version)}/builds/5`] = {
      id: 5,
      time: timestamp,
      channel: 'EXPERIMENTAL',
      downloads: {
        'server:default': {
          url: 'https://fill-data.papermc.io/v1/objects/pinned/server.jar',
          checksums: { sha256: 'a'.repeat(64) },
          size: 1234,
        },
      },
      unknownRetainedMetadata: true,
    };
  }
  Object.assign(responses, overrides);
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
  return { client, responses };
}

it('selects the newest exact build regardless of channel and retains original documents', async () => {
  const { client, responses } = fixture();
  const snapshot = await fetchPaperCatalog(client);
  expect(snapshot.versions).toEqual([
    {
      version: '1.21.11',
      buildId: 5,
      javaMajor: 21,
      channel: 'EXPERIMENTAL',
      buildTime: timestamp,
    },
    { version: '1.7.10', buildId: 5, javaMajor: 8, channel: 'EXPERIMENTAL', buildTime: timestamp },
  ]);
  expect(client.read).toHaveBeenCalledTimes(5);
  expect(snapshot.documents[`${url('1.7.10')}/builds/5`]?.json).toBe(
    JSON.stringify(responses[`${url('1.7.10')}/builds/5`]),
  );
  expect(paperCatalogSnapshotSchema.safeParse(snapshot).success).toBe(true);
});
it('reuses unchanged exact builds and raw provenance without churn, fetching new builds only', async () => {
  const { client, responses } = fixture(['1.21.11']);
  const first = await fetchPaperCatalog(client);
  client.read.mockClear();
  const original = client.read.getMockImplementation();
  if (!original) throw new Error('Missing fixture implementation');
  client.read.mockImplementation(async (input) => {
    const document = await original(input);
    return {
      ...document,
      evidence: { ...document.evidence, retrievedAt: '2026-10-21T11:00:00.000Z' },
    };
  });
  const second = await fetchPaperCatalog(client, { previous: first });
  expect(second).toEqual(first);
  expect(client.read.mock.calls.map(([input]) => input)).toEqual([paperCatalogUrl, url('1.21.11')]);
  responses[url('1.21.11')] = {
    version: { id: '1.21.11', java: { version: { minimum: 21 } } },
    builds: [6, 5],
  };
  responses[`${url('1.21.11')}/builds/6`] = {
    ...(responses[`${url('1.21.11')}/builds/5`] as object),
    id: 6,
  };
  const third = await fetchPaperCatalog(client, { previous: second });
  expect(third.versions[0]?.buildId).toBe(6);
  expect(third.documents[`${url('1.21.11')}/builds/5`]).toBeUndefined();
  expect(first.versions[0]?.buildId).toBe(5);
});
it('accepts historical build zero and freezes it when it is the newest available build', async () => {
  const { client, responses } = fixture(['1.21.11']);
  responses[url('1.21.11')] = {
    version: { id: '1.21.11', java: { version: { minimum: 21 } } },
    builds: [0],
  };
  responses[`${url('1.21.11')}/builds/0`] = {
    ...(responses[`${url('1.21.11')}/builds/5`] as object),
    id: 0,
  };
  expect((await fetchPaperCatalog(client)).versions[0]?.buildId).toBe(0);
});
it('serves frozen Paper documents, delegates other metadata, and fails closed for uncached Paper URLs', async () => {
  const { client } = fixture(['1.21.11']);
  const snapshot = await fetchPaperCatalog(client);
  const fallback = {
    read: vi.fn(async () => {
      throw new Error('fallback reached');
    }),
  };
  const cached = paperCatalogMetadataClient(snapshot, fallback);
  const document = await cached.read(`${url('1.21.11')}/builds/5`);
  expect(document.evidence).toEqual(snapshot.documents[`${url('1.21.11')}/builds/5`]?.evidence);
  expect(fallback.read).not.toHaveBeenCalled();
  await expect(cached.read(`${url('1.21.11')}/builds/6`)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
  expect(fallback.read).not.toHaveBeenCalled();
  await expect(cached.read('https://piston-meta.mojang.com/fixture.json')).rejects.toThrow(
    'fallback reached',
  );
});
it('bounds concurrent requests to two and runs lease progress checks outside active requests', async () => {
  const { client } = fixture(['1.21.11', '1.20.4', '1.7.10']);
  const original = client.read.getMockImplementation();
  if (!original) throw new Error('Missing fixture implementation');
  let active = 0;
  let maximum = 0;
  client.read.mockImplementation(async (input) => {
    active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    try {
      return await original(input);
    } finally {
      active--;
    }
  });
  const onProgress = vi.fn(() => {
    expect(active).toBe(0);
  });
  await fetchPaperCatalog(client, { onProgress });
  expect(maximum).toBe(2);
  expect(onProgress).toHaveBeenCalledTimes(6);
});
it.each([
  { project: { id: 'folia' }, versions: { fixture: ['1.21.11'] } },
  { project: { id: 'paper' }, versions: { fixture: ['1.21.11', '1.21.11'] } },
  { project: { id: 'paper' }, versions: { fixture: [] } },
  { project: { id: 'paper' }, versions: { fixture: ['../invalid'] } },
])('rejects invalid project identities and version lists', async (project) => {
  const { client } = fixture(['1.21.11'], { [paperCatalogUrl]: project });
  await expect(fetchPaperCatalog(client)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
  expect(client.read).toHaveBeenCalledTimes(1);
});
it('rejects mismatched version/build identities and untrusted artifact downloads', async () => {
  const good = fixture(['1.21.11']);
  const version = good.responses[url('1.21.11')] as { version: { id: string }; builds: number[] };
  const build = good.responses[`${url('1.21.11')}/builds/5`] as {
    downloads: { 'server:default': object };
  };
  const failures = [
    { [url('1.21.11')]: { ...version, version: { ...version.version, id: '1.21.10' } } },
    { [url('1.21.11')]: { ...version, builds: [5, 5] } },
    { [`${url('1.21.11')}/builds/5`]: { ...build, id: 4 } },
    {
      [`${url('1.21.11')}/builds/5`]: {
        ...build,
        downloads: {
          'server:default': {
            ...build.downloads['server:default'],
            url: 'https://example.test/server.jar',
          },
        },
      },
    },
  ];
  for (const overrides of failures)
    await expect(fetchPaperCatalog(fixture(['1.21.11'], overrides).client)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
});
it('rejects invalid raw provenance and inconsistent persisted snapshots', async () => {
  const { client } = fixture(['1.21.11']);
  const snapshot = await fetchPaperCatalog(client);
  for (const altered of [
    { ...snapshot, versions: [{ ...snapshot.versions[0], buildId: 4 }] },
    {
      ...snapshot,
      documents: {
        ...snapshot.documents,
        [paperCatalogUrl]: { ...snapshot.documents[paperCatalogUrl], json: '{}' },
      },
    },
    {
      ...snapshot,
      documents: {
        ...snapshot.documents,
        'https://example.test/': snapshot.documents[paperCatalogUrl],
      },
    },
  ])
    expect(paperCatalogSnapshotSchema.safeParse(altered).success).toBe(false);
  client.read.mockResolvedValue({
    bytes: new TextEncoder().encode('{}'),
    evidence: { url: paperCatalogUrl, sha256: 'a'.repeat(64), retrievedAt: timestamp },
  });
  await expect(fetchPaperCatalog(client)).rejects.toMatchObject({
    details: { reason: 'paper_metadata_invalid' },
  });
});
it('does no provider I/O after lease loss and bounds catalog/request bytes', async () => {
  const { client } = fixture(['1.21.11']);
  await expect(
    fetchPaperCatalog(client, {
      onProgress: () => {
        throw new Error('lease lost');
      },
    }),
  ).rejects.toThrow('lease lost');
  expect(client.read).not.toHaveBeenCalled();
  const huge = fixture(Array.from({ length: 2_001 }, (_, index) => `1.${index}`));
  await expect(fetchPaperCatalog(huge.client)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
  expect(huge.client.read).toHaveBeenCalledTimes(1);
  const original = client.read.getMockImplementation();
  if (!original) throw new Error('Missing fixture implementation');
  client.read.mockImplementation(async (input) => {
    const document = await original(input);
    Object.defineProperty(document.bytes, 'byteLength', { value: 17 * 1024 * 1024 });
    return document;
  });
  await expect(fetchPaperCatalog(client)).rejects.toMatchObject({
    details: { reason: 'paper_metadata_budget_exceeded' },
  });
});
