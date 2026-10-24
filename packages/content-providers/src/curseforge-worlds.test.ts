import { describe, expect, it, vi } from 'vitest';
import type { ContentHttp } from './contracts.js';
import { CurseForgeProvider } from './curseforge.js';
import { worldCatalogFilesSchema, worldCatalogProjectsSchema } from './world-catalog.js';

const project = {
  id: 101,
  gameId: 432,
  classId: 17,
  slug: 'fixture-world',
  name: 'Fixture world',
  summary: 'A world fixture.',
  downloadCount: 1234,
  authors: [{ name: 'Builder' }],
  logo: { thumbnailUrl: 'https://media.forgecdn.net/avatars/1/2/world.png' },
  links: { websiteUrl: 'https://unsafe.invalid/untrusted' },
  isAvailable: true,
  allowModDistribution: true,
};
const file = {
  id: 202,
  modId: 101,
  gameId: 432,
  fileName: 'Fixture World.zip',
  displayName: 'Fixture World 1.7.10',
  fileDate: '2026-10-18T12:00:00Z',
  fileLength: 4096,
  downloadUrl: 'https://edge.forgecdn.net/files/1/2/world.zip',
  isAvailable: true,
  gameVersions: ['1.7.10'],
  hashes: [{ algo: 1, value: 'A'.repeat(40) }],
};
const category = { id: 17, gameId: 432, slug: 'worlds', isClass: true };
function fixture(
  options: {
    project?: Record<string, unknown>;
    file?: Record<string, unknown>;
    categories?: unknown[];
    pagination?: Record<string, unknown>;
  } = {},
) {
  const json = vi.fn<ContentHttp['json']>(async (url) => {
    const target = new URL(url);
    const pagination = {
      index: Number(target.searchParams.get('index') ?? '0'),
      pageSize: 20,
      resultCount: 1,
      totalCount: 150,
      ...options.pagination,
    };
    if (target.pathname === '/v1/categories') return { data: options.categories ?? [category] };
    if (target.pathname === '/v1/mods/search')
      return { data: [{ ...project, ...options.project }], pagination };
    if (target.pathname === '/v1/mods/101') return { data: { ...project, ...options.project } };
    if (target.pathname === '/v1/mods/101/files')
      return { data: [{ ...file, ...options.file }], pagination };
    if (target.pathname === '/v1/mods/101/files/202') return { data: { ...file, ...options.file } };
    throw new Error(`Unexpected fixture URL ${target.pathname}`);
  });
  return {
    json,
    provider: new CurseForgeProvider(
      { json, download: vi.fn() },
      { apiKey: 'fixture-key-private' },
    ),
  };
}

describe('CurseForge world catalog', () => {
  it('discovers the Worlds class, searches without runtime/version filters, and returns only public metadata', async () => {
    const { provider, json } = fixture();
    const result = await provider.searchWorlds('adventure & puzzle', 20);
    expect(result).toEqual({
      items: [
        {
          id: '101',
          name: 'Fixture world',
          summary: 'A world fixture.',
          websiteUrl: 'https://www.curseforge.com/minecraft/worlds/fixture-world',
          imageUrl: project.logo.thumbnailUrl,
          authors: ['Builder'],
          downloads: 1234,
        },
      ],
      offset: 20,
      limit: 20,
      total: 150,
    });
    const url = new URL(json.mock.calls[1]?.[0] ?? '');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      gameId: '432',
      classId: '17',
      searchFilter: 'adventure & puzzle',
      index: '20',
      pageSize: '20',
      sortField: '6',
      sortOrder: 'desc',
    });
    expect(json.mock.calls[0]?.[0]).toBe(
      'https://api.curseforge.com/v1/categories?gameId=432&classesOnly=true',
    );
    expect(JSON.stringify(result)).not.toContain('fixture-key-private');
    expect(JSON.stringify(provider)).not.toContain('fixture-key-private');
    expect(worldCatalogProjectsSchema.parse(result)).toEqual(result);
  });

  it('coalesces class discovery and caches it without hardcoding the class ID', async () => {
    const { provider, json } = fixture({
      categories: [{ ...category, id: 123 }],
      project: { classId: 123 },
    });
    await Promise.all([provider.searchWorlds('one'), provider.searchWorlds('two', 0, '1.7.10')]);
    await provider.worldFiles('101');
    const calls = json.mock.calls.map(([url]) => new URL(url));
    expect(calls.filter((url) => url.pathname === '/v1/categories')).toHaveLength(1);
    const searches = calls.filter((url) => url.pathname === '/v1/mods/search');
    expect(searches.every((url) => url.searchParams.get('classId') === '123')).toBe(true);
    expect(searches[1]?.searchParams.get('gameVersion')).toBe('1.7.10');
    expect(searches.every((url) => !url.searchParams.has('modLoaderType'))).toBe(true);
  });

  it('does not cache failed discovery and can retry after provider recovery', async () => {
    const { provider, json } = fixture();
    json.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(provider.searchWorlds('')).rejects.toThrow('provider unavailable');
    await expect(provider.searchWorlds('')).resolves.toMatchObject({ total: 150 });
    expect(json.mock.calls.filter(([url]) => url.includes('/categories?'))).toHaveLength(2);
  });

  it.each([
    [],
    [{ ...category, gameId: 1 }],
    [{ ...category, isClass: false }],
    [{ ...category, slug: 'mods' }],
    [category, { ...category, id: 18 }],
  ])('rejects missing or ambiguous Worlds classes: %j', async (...categories) => {
    const { provider } = fixture({ categories });
    await expect(provider.searchWorlds('')).rejects.toThrow();
  });

  it.each([-1, 9981, 10000, 0.5, Number.NaN])(
    'rejects out-of-bounds page %s before a request',
    async (offset) => {
      const { provider, json } = fixture();
      await expect(provider.searchWorlds('', offset)).rejects.toThrow();
      await expect(provider.worldFiles('101', offset)).rejects.toThrow();
      expect(json).not.toHaveBeenCalled();
    },
  );

  it('permits the final API page without truncating the provider total', async () => {
    const { provider } = fixture({ pagination: { totalCount: 123456 } });
    expect(await provider.searchWorlds('', 9980)).toMatchObject({
      offset: 9980,
      limit: 20,
      total: 123456,
    });
  });

  it.each([{ gameId: 1 }, { classId: 6 }])(
    'rejects foreign search projects: %j',
    async (project) => {
      await expect(fixture({ project }).provider.searchWorlds('')).rejects.toThrow();
    },
  );

  it.each([{ index: 1 }, { resultCount: 2 }, { pageSize: 50 }, { totalCount: 0 }])(
    'rejects inconsistent provider pagination: %j',
    async (pagination) => {
      await expect(fixture({ pagination }).provider.searchWorlds('')).rejects.toThrow();
      await expect(fixture({ pagination }).provider.worldFiles('101')).rejects.toThrow();
    },
  );

  it('ignores untrusted image/link URLs and constructs the approved project URL from its slug', async () => {
    const { provider } = fixture({
      project: { logo: { thumbnailUrl: 'https://unsafe.invalid/tracker' } },
    });
    const result = await provider.searchWorlds('');
    expect(result.items[0]?.imageUrl).toBeUndefined();
    expect(result.items[0]?.websiteUrl).toBe(
      'https://www.curseforge.com/minecraft/worlds/fixture-world',
    );
  });

  it('lists all file versions, retaining unavailable files as unavailable rather than filtering to the server version', async () => {
    const { provider, json } = fixture({ file: { downloadUrl: null } });
    const result = await provider.worldFiles('101', 40);
    expect(result).toEqual({
      items: [
        {
          id: '202',
          projectId: '101',
          name: file.displayName,
          filename: file.fileName,
          gameVersions: ['1.7.10'],
          publishedAt: file.fileDate,
          bytes: 4096,
          available: false,
        },
      ],
      offset: 40,
      limit: 20,
      total: 150,
    });
    expect(
      json.mock.calls.some(([url]) => url.endsWith('/mods/101/files?index=40&pageSize=20')),
    ).toBe(true);
    expect(worldCatalogFilesSchema.parse(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('downloadUrl');
  });

  it('resolves one exact archive with provider bytes/hash/provenance using the normal acquisition contract', async () => {
    const { provider } = fixture();
    expect(await provider.worldArchive('101', '202')).toEqual({
      path: 'config/input.zip',
      urls: [file.downloadUrl],
      size: file.fileLength,
      hashes: { sha1: 'a'.repeat(40) },
      projectId: '101',
      versionId: '202',
      kind: 'override',
      serverSide: 'required',
    });
  });

  it.each([{ id: 102 }, { gameId: 1 }, { classId: 6 }])(
    'rejects mismatched project identity for files and downloads: %j',
    async (project) => {
      await expect(fixture({ project }).provider.worldFiles('101')).rejects.toThrow();
      await expect(fixture({ project }).provider.worldArchive('101', '202')).rejects.toThrow();
    },
  );

  it.each([{ id: 203 }, { modId: 102 }, { gameId: 1 }])(
    'rejects mismatched file identity: %j',
    async (file) => {
      await expect(fixture({ file }).provider.worldArchive('101', '202')).rejects.toThrow();
    },
  );

  it.each([{ allowModDistribution: false }, { isAvailable: false }])(
    'does not offer or download restricted projects: %j',
    async (project) => {
      const { provider } = fixture({ project });
      expect((await provider.worldFiles('101')).items[0]?.available).toBe(false);
      await expect(provider.worldArchive('101', '202')).rejects.toThrow();
    },
  );

  it.each([
    { isAvailable: false },
    { downloadUrl: null },
    { downloadUrl: 'http://edge.forgecdn.net/world.zip' },
    { downloadUrl: 'https://user:secret@edge.forgecdn.net/world.zip' },
    { hashes: [] },
    { hashes: [{ algo: 2, value: 'a'.repeat(32) }] },
    { hashes: [{ algo: 1, value: 'not-a-sha1' }] },
    { fileName: 'mod.jar' },
    { fileName: '../world.zip' },
    { fileName: 'folder/world.zip' },
    { fileName: 'folder\\world.zip' },
    { fileName: 'world\u0000.zip' },
    { fileName: 'con.zip' },
  ])(
    'does not offer or download unsafe, unavailable or unverifiable archives: %j',
    async (file) => {
      const { provider } = fixture({ file });
      expect((await provider.worldFiles('101')).items[0]?.available).toBe(false);
      await expect(provider.worldArchive('101', '202')).rejects.toThrow();
    },
  );

  it.each(['0', '01', '-1', '1/files', '1?x=2', '9007199254740992'])(
    'rejects noncanonical IDs %s before a request',
    async (id) => {
      const { provider, json } = fixture();
      await expect(provider.worldFiles(id)).rejects.toThrow();
      await expect(provider.worldArchive('101', id)).rejects.toThrow();
      expect(json).not.toHaveBeenCalled();
    },
  );

  it('propagates cancellation through catalog metadata requests', async () => {
    const { provider, json } = fixture();
    const signal = new AbortController().signal;
    await provider.searchWorlds('', 0, undefined, signal);
    await provider.worldFiles('101', 0, signal);
    await provider.worldArchive('101', '202', signal);
    expect(json.mock.calls.every(([, options]) => options?.signal === signal)).toBe(true);
    expect(
      json.mock.calls.every(
        ([, options]) => options?.headers?.['x-api-key'] === 'fixture-key-private',
      ),
    ).toBe(true);
  });
});
