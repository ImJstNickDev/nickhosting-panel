import { describe, expect, it, vi } from 'vitest';
import type { ContentHttp } from './contracts.js';
import { CurseForgeProvider } from './curseforge.js';
import { ModrinthProvider } from './modrinth.js';

const mrProject = { id: 'pack', slug: 'fixture', title: 'Fixture', project_type: 'mod' };
const mrFile = {
  filename: 'fixture.zip',
  url: 'https://cdn.modrinth.com/fixture.zip',
  size: 123,
  hashes: { sha512: 'a'.repeat(128) },
  primary: true,
};
const mrVersion = {
  id: 'release',
  project_id: 'pack',
  name: 'Fixture 1',
  version_number: '1',
  game_versions: ['1.21.9'],
  loaders: ['datapack'],
  date_published: '2026-01-01T00:00:00Z',
  files: [mrFile],
  dependencies: [],
};
function modrinth(version: Record<string, unknown> = {}) {
  const json = vi.fn<ContentHttp['json']>(async (url) => {
    const target = new URL(url);
    if (target.pathname === '/v2/search')
      return {
        hits: [
          {
            project_id: 'pack',
            slug: 'fixture',
            title: 'Fixture',
            description: 'A fixture',
            author: 'Author',
            downloads: 123,
            icon_url: 'https://cdn.modrinth.com/icon.png',
          },
        ],
        offset: Number(target.searchParams.get('offset')),
        limit: 20,
        total_hits: 1,
      };
    if (target.pathname === '/v2/project/pack') return mrProject;
    if (target.pathname === '/v2/project/pack/version') return [{ ...mrVersion, ...version }];
    if (target.pathname === '/v2/version/release') return { ...mrVersion, ...version };
    throw new Error(`Unexpected ${target.pathname}`);
  });
  return { json, provider: new ModrinthProvider({ json, download: vi.fn() }) };
}
const cfProject = {
  id: 101,
  gameId: 432,
  classId: 777,
  slug: 'fixture',
  name: 'Fixture',
  summary: 'Fixture',
  downloadCount: 10,
  authors: [{ name: 'Author' }],
  isAvailable: true,
  allowModDistribution: true,
};
const cfFile = {
  id: 202,
  modId: 101,
  gameId: 432,
  fileName: 'fixture.zip',
  displayName: 'Fixture 1',
  fileDate: '2026-01-01T00:00:00Z',
  fileLength: 123,
  downloadUrl: 'https://edge.forgecdn.net/fixture.zip',
  isAvailable: true,
  gameVersions: ['1.21.9'],
  hashes: [{ algo: 1, value: 'a'.repeat(40) }],
  dependencies: [],
};
function curseforge(file: Record<string, unknown> = {}, project: Record<string, unknown> = {}) {
  const json = vi.fn<ContentHttp['json']>(async (url) => {
    const target = new URL(url);
    const pagination = {
      index: Number(target.searchParams.get('index') ?? 0),
      pageSize: 20,
      resultCount: 1,
      totalCount: 1,
    };
    if (target.pathname === '/v1/categories')
      return { data: [{ id: 777, gameId: 432, slug: 'data-packs', isClass: true }] };
    if (target.pathname === '/v1/mods/search')
      return { data: [{ ...cfProject, ...project }], pagination };
    if (target.pathname === '/v1/mods/101') return { data: { ...cfProject, ...project } };
    if (target.pathname === '/v1/mods/101/files')
      return { data: [{ ...cfFile, ...file }], pagination };
    if (target.pathname === '/v1/mods/101/files/202') return { data: { ...cfFile, ...file } };
    throw new Error(`Unexpected ${target.pathname}`);
  });
  return {
    json,
    provider: new CurseForgeProvider(
      { json, download: vi.fn() },
      { apiKey: 'private-fixture-key' },
    ),
  };
}

describe('Modrinth datapacks', () => {
  it('discovers dual-type projects, filters by datapack loader, and preserves archive integrity', async () => {
    const { provider, json } = modrinth();
    const projects = await provider.searchDatapacks('test', 0, '1.21.9');
    expect(projects.items[0]).toMatchObject({
      id: 'pack',
      websiteUrl: 'https://modrinth.com/datapack/fixture',
    });
    const query = new URL(json.mock.calls[0]?.[0] ?? '').searchParams;
    expect(JSON.parse(query.get('facets') ?? '')).toEqual([
      ['all_project_types:datapack'],
      ['versions:1.21.9'],
    ]);
    const files = await provider.datapackFiles('pack');
    expect(files.items[0]).toMatchObject({ available: true, filename: 'fixture.zip' });
    const versionsCall = json.mock.calls.find(([url]) => url.includes('/version?'));
    expect(new URL(versionsCall?.[0] ?? '').searchParams.get('loaders')).toBe('["datapack"]');
    expect(JSON.stringify(files)).not.toContain('https://cdn.modrinth.com');
    expect(await provider.datapackArchive('pack', 'release')).toEqual({
      path: 'config/input.zip',
      urls: [mrFile.url],
      size: 123,
      hashes: mrFile.hashes,
      kind: 'override',
      serverSide: 'required',
      projectId: 'pack',
      versionId: 'release',
    });
  });
  it.each(['required', 'incompatible'])(
    'does not silently drop %s dependency contracts',
    async (dependency_type) => {
      const { provider } = modrinth({
        dependencies: [{ project_id: 'dependency', dependency_type }],
      });
      expect((await provider.datapackFiles('pack')).items[0]).toMatchObject({
        available: false,
        unavailableReason: 'dependencies',
      });
      await expect(provider.datapackArchive('pack', 'release')).rejects.toThrow();
    },
  );
  it('permits embedded and optional dependencies without a second download', async () => {
    const { provider } = modrinth({
      dependencies: [{ project_id: 'dependency', dependency_type: 'embedded' }],
    });
    await expect(provider.datapackArchive('pack', 'release')).resolves.toMatchObject({
      path: 'config/input.zip',
    });
  });
  it.each([{ project_id: 'foreign' }, { loaders: ['fabric'] }])(
    'rejects wrong identity/loader %j',
    async (version) => {
      const { provider } = modrinth(version);
      await expect(provider.datapackFiles('pack')).rejects.toThrow();
      await expect(provider.datapackArchive('pack', 'release')).rejects.toThrow();
    },
  );
  it.each([
    { filename: '../fixture.zip' },
    { filename: 'fixture.jar' },
    { url: 'http://cdn.modrinth.com/fixture.zip' },
    { filename: 'dir\\fixture.zip' },
  ])('does not acquire unsafe archives %j', async (file) => {
    const { provider } = modrinth({ files: [{ ...mrFile, ...file }] });
    expect((await provider.datapackFiles('pack')).items[0]?.available).toBe(false);
    await expect(provider.datapackArchive('pack', 'release')).rejects.toThrow();
  });
  it('propagates abort signals across all requests', async () => {
    const { provider, json } = modrinth();
    const signal = new AbortController().signal;
    await provider.searchDatapacks('', 0, undefined, signal);
    await provider.datapackFiles('pack', 0, signal);
    await provider.datapackArchive('pack', 'release', signal);
    expect(json.mock.calls.every(([, options]) => options?.signal === signal)).toBe(true);
  });
});

describe('CurseForge datapacks', () => {
  it('discovers and caches the actual Data Packs class with no guessed IDs or loader filter', async () => {
    const { provider, json } = curseforge();
    const results = await provider.searchDatapacks('', 0, '1.21.9');
    await provider.datapackFiles('101');
    expect(results.items[0]?.websiteUrl).toBe(
      'https://www.curseforge.com/minecraft/data-packs/fixture',
    );
    const searches = json.mock.calls.map(([url]) => new URL(url));
    expect(searches.filter((url) => url.pathname === '/v1/categories')).toHaveLength(1);
    const search = searches.find((url) => url.pathname === '/v1/mods/search');
    expect(search?.searchParams.get('classId')).toBe('777');
    expect(search?.searchParams.has('modLoaderType')).toBe(false);
    expect(await provider.datapackArchive('101', '202')).toMatchObject({
      path: 'config/input.zip',
      hashes: { sha1: 'a'.repeat(40) },
    });
    expect(JSON.stringify(results)).not.toContain('private-fixture-key');
  });
  it.each([3, 5])(
    'keeps dependency relation %s unavailable rather than silently installing',
    async (relationType) => {
      const { provider } = curseforge({ dependencies: [{ modId: 99, relationType }] });
      expect((await provider.datapackFiles('101')).items[0]).toMatchObject({
        available: false,
        unavailableReason: 'dependencies',
      });
      await expect(provider.datapackArchive('101', '202')).rejects.toThrow();
    },
  );
  it.each([
    { downloadUrl: null },
    { isAvailable: false },
    { fileName: 'fixture.jar' },
    { hashes: [] },
    { downloadUrl: 'http://edge.forgecdn.net/fixture.zip' },
  ])('respects distribution/integrity failures %j', async (file) => {
    const { provider } = curseforge(file);
    expect((await provider.datapackFiles('101')).items[0]?.available).toBe(false);
    await expect(provider.datapackArchive('101', '202')).rejects.toThrow();
  });
  it('rejects foreign classes and forbidden distribution', async () => {
    await expect(
      curseforge({}, { classId: 6 }).provider.datapackArchive('101', '202'),
    ).rejects.toThrow();
    await expect(
      curseforge({}, { allowModDistribution: false }).provider.datapackArchive('101', '202'),
    ).rejects.toThrow();
  });
});

describe('catalog input boundaries', () => {
  it.each([-1, 9981, 0.5, Number.NaN])(
    'rejects invalid offset %s before issuing requests',
    async (offset) => {
      for (const fixture of [modrinth(), curseforge()]) {
        await expect(fixture.provider.searchDatapacks('', offset)).rejects.toThrow();
        await expect(fixture.provider.datapackFiles('101', offset)).rejects.toThrow();
        expect(fixture.json).not.toHaveBeenCalled();
      }
    },
  );
});
