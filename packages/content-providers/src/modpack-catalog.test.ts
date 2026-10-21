import { describe, expect, it, vi } from 'vitest';
import type { ContentHttp } from './contracts.js';
import { CurseForgeProvider } from './curseforge.js';
import { ModpackMetadataCache } from './modpack-catalog-common.js';
import { resolvePinnedCurseForgeFiles } from './modpack-catalog-curseforge.js';
import { createModpackCatalog } from './modpack-catalog-providers.js';

const hash = 'a'.repeat(40);
function transport(routes: Record<string, unknown>) {
  const json = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    const key = `${parsed.hostname}${parsed.pathname}`;
    if (!(key in routes)) throw new Error(`Unexpected metadata request: ${key}`);
    return routes[key];
  });
  const text = vi.fn(async (url: string) => String(await json(url)));
  const http: ContentHttp = { json, text, download: vi.fn() };
  return { http, json, text };
}
const mrProject = {
  id: 'pack',
  slug: 'pack',
  title: 'Fixture Pack',
  description: 'Summary',
  body: '# About',
  project_type: 'modpack',
  downloads: 12,
};
const mrVersion = {
  id: 'v1',
  project_id: 'pack',
  name: 'Pack 1',
  version_number: '1.0',
  game_versions: ['1.21.1'],
  loaders: ['fabric'],
  date_published: '2026-10-21T00:00:00Z',
  version_type: 'release',
  files: [
    {
      filename: 'pack.mrpack',
      url: 'https://cdn.modrinth.com/pack.mrpack',
      size: 123,
      hashes: { sha1: hash },
      primary: true,
    },
  ],
};
function modrinth(extra = {}) {
  const mock = transport({
    'api.modrinth.com/v2/project/pack': { ...mrProject, ...extra },
    'api.modrinth.com/v2/project/pack/version': [mrVersion],
    'api.modrinth.com/v2/version/v1': mrVersion,
    'api.modrinth.com/v2/search': {
      hits: [
        {
          project_id: 'pack',
          slug: 'pack',
          title: 'Fixture Pack',
          description: 'Summary',
          author: 'Author',
          downloads: 12,
        },
      ],
      total_hits: 1,
    },
  });
  return { ...mock, catalog: createModpackCatalog('modrinth', { http: mock.http }) };
}
describe('Modrinth modpack catalog', () => {
  it('returns browser-safe search/details/version metadata, never artifact URLs', async () => {
    const { catalog } = modrinth();
    const results = [
      await catalog.search({ query: 'Fixture' }),
      await catalog.details('pack'),
      await catalog.versions('pack'),
    ];
    expect(JSON.stringify(results)).not.toContain('cdn.modrinth.com/pack.mrpack');
    expect(results[0]).toMatchObject({ items: [{ id: 'pack', provider: 'modrinth' }] });
  });
  it('filters discovery to server environments and the selected category before pagination', async () => {
    const { catalog, json } = modrinth();
    await catalog.search({ category: 'adventure' });
    const url = new URL(json.mock.calls[0]?.[0] ?? '');
    const facets = JSON.parse(url.searchParams.get('facets') ?? 'null');
    expect(facets).toContainEqual(['categories:adventure']);
    expect(facets[1]).toContain('environment:client_and_server');
    expect(facets[1]).not.toContain('environment:client_only');
    expect(facets[1]).not.toContain('environment:singleplayer_only');
  });
  it('discovers only modpack categories without exposing upstream SVG', async () => {
    const mock = transport({
      'api.modrinth.com/v2/tag/category': [
        { name: 'adventure', project_type: 'modpack', icon: '<svg />' },
        { name: 'utility', project_type: 'mod' },
      ],
    });
    const catalog = createModpackCatalog('modrinth', { http: mock.http });
    expect(await catalog.categories?.()).toEqual({
      items: [{ id: 'adventure', name: 'adventure' }],
    });
  });
  it('retains exact selected archive and leaves loader version to the manifest', async () => {
    const { catalog, http, json } = modrinth();
    const recipe = await catalog.resolve('pack', 'v1');
    expect(recipe).toMatchObject({
      kind: 'archive',
      format: 'modrinth-index',
      version: { id: 'v1' },
      download: { hashes: { sha1: hash } },
    });
    expect(recipe).not.toHaveProperty('target');
    expect(http.download).not.toHaveBeenCalled();
    expect(json.mock.calls.filter(([url]) => url.endsWith('/project/pack'))).toHaveLength(1);
  });
  it('does not turn client-only packs into server packs', async () => {
    const { catalog } = modrinth({ server_side: 'unsupported' });
    expect(await catalog.resolve('pack', 'v1')).toMatchObject({
      kind: 'unavailable',
      reason: 'client-only',
    });
  });
});

const cfProject = {
  id: 10,
  gameId: 432,
  classId: 4471,
  name: 'Fixture',
  slug: 'fixture',
  summary: 'Summary',
  authors: [{ name: 'Author' }],
  downloadCount: 10,
  allowModDistribution: true,
};
const cfFile = {
  id: 20,
  modId: 10,
  displayName: 'Pinned 1.0',
  fileName: 'pack.zip',
  fileLength: 123,
  downloadUrl: 'https://edge.forgecdn.net/pack.zip',
  isAvailable: true,
  gameVersions: ['1.21.1', 'Fabric'],
  fileDate: '2026-10-21T00:00:00Z',
  releaseType: 1,
  hashes: [{ algo: 1, value: hash }],
};
function curseforge(file = cfFile, project = cfProject) {
  const mock = transport({
    'api.curseforge.com/v1/categories': { data: [{ id: 4471, slug: 'modpacks' }] },
    'api.curseforge.com/v1/mods/10': { data: project },
    'api.curseforge.com/v1/mods/10/description': { data: '<p>About</p>' },
    'api.curseforge.com/v1/mods/10/files/20': { data: file },
    'api.curseforge.com/v1/mods/10/files/21': {
      data: {
        ...cfFile,
        id: 21,
        isServerPack: true,
        parentProjectFileId: 20,
        fileName: 'server.zip',
      },
    },
    'api.curseforge.com/v1/mods/10/files': { data: [file], pagination: { totalCount: 1 } },
    'api.curseforge.com/v1/mods/search': { data: [cfProject], pagination: { totalCount: 1 } },
  });
  const api = new CurseForgeProvider(mock.http, { apiKey: 'fixture-key' });
  return {
    ...mock,
    api,
    catalog: createModpackCatalog('curseforge', { http: mock.http, curseforge: api }),
  };
}
describe('CurseForge modpack catalog', () => {
  it.each(['project', 'version'])(
    'refuses unavailable %s even when a server-pack link exists',
    async (blocked) => {
      const { catalog, json } = curseforge(
        { ...cfFile, serverPackFileId: 21, isAvailable: blocked !== 'version' } as typeof cfFile,
        { ...cfProject, isAvailable: blocked !== 'project' } as typeof cfProject,
      );
      expect(await catalog.resolve('10', '20')).toMatchObject({
        kind: 'unavailable',
        reason: 'distribution',
      });
      expect(json.mock.calls.some(([url]) => url.endsWith('/files/21'))).toBe(false);
    },
  );
  it('discovers the modpacks class and keeps the client manifest when no server pack exists', async () => {
    const { catalog } = curseforge();
    expect(await catalog.search()).toMatchObject({ items: [{ id: '10' }] });
    expect(await catalog.resolve('10', '20')).toMatchObject({
      kind: 'archive',
      format: 'curseforge-manifest',
    });
  });
  it('uses only the server pack explicitly associated with the selected version', async () => {
    const { catalog } = curseforge({ ...cfFile, serverPackFileId: 21 } as typeof cfFile);
    expect(await catalog.resolve('10', '20')).toMatchObject({
      kind: 'archive',
      format: 'server-archive',
      version: { id: '20' },
      download: { filename: 'server.zip' },
      targetManifest: { format: 'curseforge-manifest', download: { filename: 'pack.zip' } },
    });
  });
  it('fetches pinned mod files in two bulk calls without dependency or latest selection', async () => {
    const { api, http, json } = curseforge();
    http.jsonPost = vi.fn(async (url: string) => ({
      data: url.endsWith('/files')
        ? [{ ...cfFile, fileName: 'pinned.jar' }]
        : [{ id: 10, allowModDistribution: true }],
    }));
    expect(await resolvePinnedCurseForgeFiles(api, [{ projectId: 10, fileId: 20 }])).toMatchObject([
      { path: 'mods/pinned.jar', download: { hashes: { sha1: hash } } },
    ]);
    expect(http.jsonPost).toHaveBeenCalledTimes(2);
    expect(json).not.toHaveBeenCalled();
    expect(vi.mocked(http.jsonPost).mock.calls[0]?.[1]).toEqual({ fileIds: [20] });
  });
  it('never substitutes another file for a missing pinned version', async () => {
    const { api, http } = curseforge();
    http.jsonPost = vi.fn(async (url: string) => ({
      data: url.endsWith('/files') ? [] : [{ id: 10 }],
    }));
    await expect(
      resolvePinnedCurseForgeFiles(api, [{ projectId: 10, fileId: 20 }]),
    ).rejects.toThrow();
  });
});

const targets = [
  { name: 'minecraft', type: 'game', version: '1.21.1' },
  { name: 'neoforge', type: 'modloader', version: '21.1.72' },
  { name: 'java', type: 'runtime', version: '21' },
];
const ftbVersion = {
  id: 2,
  name: '1.0',
  type: 'release',
  targets,
  specs: { minimum: 4096, recommended: 6144 },
};
const ftbProject = { id: 1, name: 'FTB Fixture', synopsis: 'Summary', versions: [ftbVersion] };
function ftb(
  files = [
    {
      name: 'server.jar',
      path: './mods/',
      url: 'https://files.feed-the-beast.com/server.jar',
      size: 12,
      sha1: hash,
      clientonly: false,
    },
    {
      name: 'client.jar',
      path: './mods/',
      url: 'https://files.feed-the-beast.com/client.jar',
      size: 12,
      sha1: hash,
      clientonly: true,
    },
  ],
) {
  const mock = transport({
    'api.feed-the-beast.com/v1/modpacks/modpack/1': ftbProject,
    'api.feed-the-beast.com/v1/modpacks/modpack/all': { packs: [1] },
    'api.feed-the-beast.com/v1/modpacks/modpack/1/2': { ...ftbVersion, files },
    'api.feed-the-beast.com/v1/modpacks/modpack/search/1000/detailed/': { packs: [ftbProject] },
  });
  return { ...mock, catalog: createModpackCatalog('ftb', { http: mock.http }) };
}
describe('FTB modpack catalog', () => {
  it('browses public IDs with only visible metadata, four concurrent reads and cache reuse', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => index + 1);
    let active = 0;
    let maximum = 0;
    const json = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path.endsWith('/all')) return { packs: ids };
      expect(path).not.toContain('/search/');
      const id = Number(path.split('/').at(-1));
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return { ...ftbProject, id, name: `Pack ${id}` };
    });
    const http: ContentHttp = { json, download: vi.fn() };
    const catalog = createModpackCatalog('ftb', { http });
    expect(await catalog.search({ query: '  ', offset: 3, limit: 5 })).toMatchObject({
      items: [4, 5, 6, 7, 8].map((id) => ({ id: String(id) })),
      offset: 3,
      limit: 5,
      total: 25,
    });
    expect(maximum).toBe(4);
    expect(json).toHaveBeenCalledTimes(6);
    await catalog.details('4');
    await catalog.search({ offset: 3, limit: 5 });
    expect(json).toHaveBeenCalledTimes(6);
    expect(http.download).not.toHaveBeenCalled();
  });
  it('uses one detailed search and exact manifest requirements without executing the installer', async () => {
    const { catalog, http } = ftb();
    expect(await catalog.search({ query: 'FTB' })).toMatchObject({
      items: [{ name: 'FTB Fixture' }],
    });
    expect(await catalog.resolve('1', '2')).toMatchObject({
      kind: 'files',
      target: { minecraftVersion: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.72' },
      javaVersion: '21',
      memoryMiB: 6144,
      files: [{ path: 'mods/server.jar', serverSide: 'required' }],
    });
    expect(http.download).not.toHaveBeenCalled();
  });
  it('rejects traversal and case collisions in provider file paths', async () => {
    const { catalog } = ftb([
      {
        name: 'a.jar',
        path: './../mods/',
        url: 'https://files.feed-the-beast.com/a.jar',
        size: 12,
        sha1: hash,
        clientonly: false,
      },
    ]);
    await expect(catalog.resolve('1', '2')).rejects.toThrow();
  });
  it('never replaces an unavailable old version with the current version', async () => {
    await expect(ftb().catalog.resolve('1', '999')).rejects.toThrow();
  });
});

function technic() {
  const mock = transport({
    'api.technicpack.net/launcher/version/stable4': { build: 1170 },
    'api.technicpack.net/search': {
      modpacks: [
        {
          id: '1',
          name: 'Tekkit',
          slug: 'tekkit',
          url: 'https://www.technicpack.net/modpack/tekkit.1',
        },
      ],
    },
    'api.technicpack.net/modpack/tekkit': {
      id: 1,
      name: 'tekkit',
      displayName: 'Tekkit',
      user: 'Author',
      platformUrl: 'https://www.technicpack.net/modpack/tekkit.1',
      minecraft: '1.4.7',
      version: '1.0',
      solder: 'https://solder.technicpack.net/api/',
      serverPackUrl: 'https://servers.technicpack.net/Tekkit_Server_3.1.2.zip',
    },
    'solder.technicpack.net/api/modpack/tekkit': {
      name: 'tekkit',
      recommended: '3.1.2',
      latest: '3.1.3',
      builds: ['3.1.3', '3.1.2'],
    },
    'solder.technicpack.net/api/modpack/tekkit/3.1.2': {
      minecraft: '1.2.5',
      forge: '164',
      mods: [],
    },
  });
  return { ...mock, catalog: createModpackCatalog('technic', { http: mock.http }) };
}
describe('Technic modpack catalog', () => {
  it('uses the public Solder catalogue for a blank search, sharing metadata with details', async () => {
    const { catalog, http, json } = technic();
    json.mockImplementationOnce(async (url) => {
      expect(url).toBe('https://solder.technicpack.net/api/modpack?include=full');
      return { modpacks: { tekkit: { name: 'tekkit' } } };
    });
    expect(await catalog.search({ query: '  ' })).toMatchObject({
      items: [{ id: 'tekkit', name: 'Tekkit' }],
      total: 1,
    });
    const calls = json.mock.calls.length;
    await catalog.details('tekkit');
    expect(json.mock.calls).toHaveLength(calls);
    expect(json.mock.calls.some(([url]) => new URL(url).pathname === '/search')).toBe(false);
    expect(http.download).not.toHaveBeenCalled();
  });
  it('keeps explicit Technic terms on the normal search endpoint', async () => {
    const { catalog, json } = technic();
    expect(await catalog.search({ query: 'Tekkit' })).toMatchObject({ items: [{ id: 'tekkit' }] });
    expect(json.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/launcher/version/stable4',
      '/search',
    ]);
    expect(new URL(json.mock.calls[1]?.[0] ?? '').searchParams.get('q')).toBe('Tekkit');
  });
  it('binds non-Solder server-pack selection to the advertised version and archive URL', async () => {
    const routes = (version: string) => ({
      'api.technicpack.net/launcher/version/stable4': { build: 1170 },
      'api.technicpack.net/modpack/fixture': {
        id: 1,
        name: 'fixture',
        displayName: 'Fixture',
        user: 'Author',
        platformUrl: 'https://www.technicpack.net/modpack/fixture.1',
        minecraft: '1.21.1',
        version,
        serverPackUrl: `https://servers.technicpack.net/fixture-${version}.zip`,
      },
    });
    const old = createModpackCatalog('technic', { http: transport(routes('1.0')).http });
    const chosen = (await old.versions('fixture')).items[0];
    expect(chosen?.id).toMatch(/^1\.0--/);
    const current = createModpackCatalog('technic', { http: transport(routes('2.0')).http });
    await expect(current.resolve('fixture', chosen?.id as string)).rejects.toThrow();
  });
  it('matches a server archive to its explicit version, not every Solder build', async () => {
    const { catalog } = technic();
    expect(await catalog.versions('tekkit')).toMatchObject({
      items: [
        { id: '3.1.2', available: true },
        { id: '3.1.3', available: false },
      ],
    });
    expect(await catalog.resolve('tekkit', '3.1.3')).toMatchObject({
      kind: 'unavailable',
      reason: 'server-pack',
    });
  });
  it('takes Minecraft and loader from the exact selected build rather than stale platform metadata', async () => {
    expect(await technic().catalog.resolve('tekkit', '3.1.2')).toMatchObject({
      kind: 'archive',
      format: 'server-archive',
      target: { minecraftVersion: '1.2.5', loader: 'forge', loaderVersion: '164' },
    });
  });
});

const voidCatalog =
  '<a href="https://voidswrath.com/modpacks/fixture/"><div class="mod-pack-thumb" style="background-image:url(\'https://voidswrath.com/icon.png\')"><div class="mod-pack-title-list">Fixture &amp; Pack</div></div></a>';
const voidDetail =
  '<h2 class="post-modpacks-title">Fixture &amp; Pack</h2><div class="post-server-details"><ul><li><strong>Version: </strong>4.2</li><li>Minecraft: 1.7.10</li></ul></div><p>About pack.</p><a href="https://vl4.voidswrath.com/releases/Fixture.zip">Download the Server Pack</a><script>bad()</script>';
describe('VoidsWrath official catalog', () => {
  it('parses official HTML metadata without requesting archives or running page scripts', async () => {
    const { http } = transport({
      'voidswrath.com/mod-packs/': voidCatalog,
      'voidswrath.com/modpacks/fixture/': voidDetail,
    });
    const catalog = createModpackCatalog('voidswrath', { http });
    expect(await catalog.search()).toMatchObject({ items: [{ name: 'Fixture & Pack' }] });
    expect(await catalog.resolve('fixture', '4.2')).toMatchObject({
      kind: 'archive',
      format: 'server-archive',
      download: { filename: 'Fixture.zip' },
    });
    expect(http.download).not.toHaveBeenCalled();
  });
  it('reports upstream layout changes instead of pretending there are no packs', async () => {
    const { http } = transport({ 'voidswrath.com/mod-packs/': '<h1>Oops</h1>' });
    await expect(createModpackCatalog('voidswrath', { http }).search()).rejects.toThrow();
  });
  it('refuses an old selected version after the official current version changed', async () => {
    const { http } = transport({ 'voidswrath.com/modpacks/fixture/': voidDetail });
    await expect(
      createModpackCatalog('voidswrath', { http }).resolve('fixture', '4.1'),
    ).rejects.toThrow();
  });
});

describe('ATLauncher public server packages', () => {
  it('resolves an explicitly published server ZIP without downloading game artifacts', async () => {
    const p = {
      id: 1,
      name: 'Fixture',
      safeName: 'Fixture',
      type: 'public',
      versions: [{ version: '1.0', minecraft: '1.21.1' }],
    };
    const { http, json } = transport({
      'api.atlauncher.com/v1/packs/full/public': { error: false, data: [p] },
      'api.atlauncher.com/v1/pack/Fixture/1.0': {
        error: false,
        data: {
          version: '1.0',
          minecraftVersion: '1.21.1',
          serverZipURL: 'https://download.nodecdn.net/containers/atl/server.zip',
        },
      },
    });
    const catalog = createModpackCatalog('atlauncher', { http });
    expect(await catalog.search()).toMatchObject({ items: [{ id: 'Fixture' }] });
    expect(await catalog.resolve('Fixture', '1.0')).toMatchObject({
      kind: 'archive',
      format: 'server-archive',
      version: { minecraftVersions: ['1.21.1'], available: true },
    });
    expect(json.mock.calls.every(([url]) => url.startsWith('https://api.atlauncher.com/'))).toBe(
      true,
    );
  });
});

describe('bounded catalog metadata cache', () => {
  it('retains adapter metadata across requests but isolates changed HTTP and credential bindings', async () => {
    const { http, json } = modrinth();
    await createModpackCatalog('modrinth', { http }).details('pack');
    await createModpackCatalog('modrinth', { http }).details('pack');
    expect(json).toHaveBeenCalledTimes(1);
    expect(createModpackCatalog('modrinth', { http: { ...http } })).not.toBe(
      createModpackCatalog('modrinth', { http }),
    );
    const cf = curseforge();
    expect(createModpackCatalog('curseforge', { http: cf.http, curseforge: cf.api })).toBe(
      createModpackCatalog('curseforge', { http: cf.http, curseforge: cf.api }),
    );
    expect(
      createModpackCatalog('curseforge', {
        http: cf.http,
        curseforge: new CurseForgeProvider(cf.http, { apiKey: 'rotated' }),
      }),
    ).not.toBe(createModpackCatalog('curseforge', { http: cf.http, curseforge: cf.api }));
    expect(() => createModpackCatalog('curseforge', { http: cf.http })).toThrow();
  });
  it('coalesces same-request metadata, isolates caller mutation and evicts to budget', async () => {
    const cache = new ModpackMetadataCache(60000, 40);
    const read = vi.fn(async () => ({ name: 'fixture' }));
    const [a, b] = await Promise.all([cache.get('a', read), cache.get('a', read)]);
    a.name = 'changed';
    expect(b.name).toBe('fixture');
    expect(read).toHaveBeenCalledTimes(1);
    expect(await cache.get('a', read)).toEqual({ name: 'fixture' });
    await cache.get('big', async () => 'x'.repeat(35));
    await cache.get('a', read);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('does not cache errors or bypass aborted reads', async () => {
    const cache = new ModpackMetadataCache();
    await expect(
      cache.get('a', async () => {
        throw new Error('failure');
      }),
    ).rejects.toThrow();
    expect(await cache.get('a', async () => 1)).toBe(1);
    await expect(cache.get('a', async () => 2, AbortSignal.abort())).rejects.toThrow();
  });
});

describe('CurseForge modpack category filtering', () => {
  it('uses the provider category taxonomy and search categoryId, without a fictitious server-pack filter', async () => {
    const json = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/categories'))
        return {
          data: url.searchParams.has('classesOnly')
            ? [{ id: 4471, slug: 'modpacks' }]
            : [
                { id: 4472, classId: 4471, name: 'Tech' },
                { id: 99, classId: 6, name: 'Other' },
              ],
        };
      return { data: [], pagination: { totalCount: 0 } };
    });
    const http: ContentHttp = { json, text: vi.fn(), download: vi.fn() };
    const catalog = createModpackCatalog('curseforge', {
      http,
      curseforge: new CurseForgeProvider(http, { apiKey: 'fixture' }),
    });
    expect(await catalog.categories?.()).toEqual({ items: [{ id: '4472', name: 'Tech' }] });
    await catalog.search({ category: '4472' });
    const url = new URL(json.mock.calls.at(-1)?.[0] ?? '');
    expect(url.searchParams.get('categoryId')).toBe('4472');
    expect(url.searchParams.has('isServerPack')).toBe(false);
  });
});
