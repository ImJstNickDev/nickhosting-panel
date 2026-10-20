import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import {
  type ContentHttp,
  type ContentPlan,
  CurseForgeProvider,
  inspectJarMetadata,
  ModrinthProvider,
  modrinthEnvironment,
  normalizeModTags,
  stageContent,
} from './index.js';
import type { ModSelection } from './mod-catalog.js';
import { curseforgeEnvironment } from './mod-metadata.js';

const target = { minecraftVersion: '1.21.1', loader: 'fabric' as const };
const root = (projectId: string, extra: Partial<ModSelection> = {}): ModSelection => ({
  projectId,
  forceIncompatible: false,
  optionalProjectIds: [],
  ...extra,
});
const project = (id: string, extra = {}) => ({
  id,
  slug: id,
  title: id,
  description: 'Summary',
  body: '# About',
  project_type: 'mod',
  downloads: 10,
  loaders: ['fabric'],
  categories: ['technology'],
  environment: ['client_and_server'],
  ...extra,
});
const version = (id: string, pid: string, extra = {}) => ({
  id,
  project_id: pid,
  name: id,
  version_number: id,
  game_versions: ['1.21.1'],
  loaders: ['fabric'],
  date_published: '2026-10-10T00:00:00Z',
  version_type: 'release',
  environment: 'client_and_server',
  files: [
    {
      url: `https://cdn.modrinth.com/${id}.jar`,
      filename: `${pid}.jar`,
      size: 10,
      hashes: { sha1: 'a'.repeat(40) },
      primary: true,
    },
  ],
  dependencies: [],
  ...extra,
});
function mr(projects: ReturnType<typeof project>[], versions: ReturnType<typeof version>[]) {
  const json = vi.fn(async (input: string) => {
    const url = new URL(input);
    const path = url.pathname.replace('/v2', '');
    if (path === '/search')
      return {
        offset: Number(url.searchParams.get('offset')),
        total_hits: projects.length,
        hits: projects.map((item) => ({
          project_id: item.id,
          slug: item.slug,
          title: item.title,
          description: item.description,
          author: 'Author',
          downloads: item.downloads,
          categories: item.categories,
          environment: item.environment,
        })),
      };
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'version') return versions.find((item) => item.id === parts[1]);
    if (parts[2] === 'version')
      return versions.filter(
        (item) =>
          item.project_id === parts[1] &&
          (!url.searchParams.has('game_versions') ||
            item.game_versions.includes(target.minecraftVersion)) &&
          (!url.searchParams.has('loaders') || item.loaders.includes(target.loader)),
      );
    return projects.find((item) => item.id === parts[1]);
  });
  return { provider: new ModrinthProvider({ json, download: vi.fn() }), json };
}
const cfProject = (id: number, extra = {}) => ({
  id,
  gameId: 432,
  classId: 6,
  slug: `mod-${id}`,
  name: `Mod ${id}`,
  summary: 'Summary',
  downloadCount: 100,
  authors: [{ name: 'Author' }],
  categories: [{ slug: 'world-generation', name: 'World Generation' }],
  isAvailable: true,
  allowModDistribution: true,
  ...extra,
});
const cfFile = (id: number, modId: number, extra = {}) => ({
  id,
  modId,
  gameId: 432,
  displayName: `Version ${id}`,
  fileName: `${modId}.jar`,
  fileLength: 10,
  fileDate: '2026-10-10T00:00:00Z',
  releaseType: 1,
  gameVersions: ['1.21.1', 'Fabric'],
  isAvailable: true,
  downloadUrl: `https://media.forgecdn.net/${id}.jar`,
  hashes: [{ algo: 1, value: 'a'.repeat(40) }],
  dependencies: [],
  ...extra,
});
function cf(projects: ReturnType<typeof cfProject>[], files: ReturnType<typeof cfFile>[]) {
  const json = vi.fn(async (input: string) => {
    const url = new URL(input);
    const parts = url.pathname.replace('/v1', '').split('/').filter(Boolean);
    if (parts[1] === 'search')
      return {
        data: projects,
        pagination: {
          index: 0,
          pageSize: 20,
          resultCount: projects.length,
          totalCount: projects.length,
        },
      };
    const pid = Number(parts[1]);
    if (parts[2] === 'description') return { data: '<p>Description</p>' };
    if (parts[2] === 'files' && parts[3])
      return { data: files.find((item) => item.modId === pid && item.id === Number(parts[3])) };
    if (parts[2] === 'files') {
      const all = files.filter(
        (item) =>
          item.modId === pid &&
          (!url.searchParams.has('gameVersion') ||
            item.gameVersions.includes(target.minecraftVersion)) &&
          (!url.searchParams.has('modLoaderType') || item.gameVersions.includes('Fabric')),
      );
      const offset = Number(url.searchParams.get('index'));
      const limit = Number(url.searchParams.get('pageSize'));
      return {
        data: all.slice(offset, offset + limit),
        pagination: {
          index: offset,
          pageSize: limit,
          resultCount: all.slice(offset, offset + limit).length,
          totalCount: all.length,
        },
      };
    }
    return { data: projects.find((item) => item.id === pid) };
  });
  return {
    provider: new CurseForgeProvider({ json, download: vi.fn() }, { apiKey: 'fixture' }),
    json,
  };
}

describe('normalized Mods catalogs', () => {
  it('normalizes genuine topic synonyms and preserves raw provider labels', () => {
    const mrTags = normalizeModTags('modrinth', [{ slug: 'worldgen' }, { slug: 'technology' }]);
    const cfTags = normalizeModTags('curseforge', [
      { slug: 'world-generation', name: 'World Generation' },
      { slug: 'tech' },
      { slug: 'magic' },
    ]);
    expect(mrTags.map((tag) => tag.id)).toEqual(cfTags.slice(0, 2).map((tag) => tag.id));
    expect(cfTags[0]).toMatchObject({ source: 'curseforge', original: 'world-generation' });
    expect(
      normalizeModTags('modrinth', [{ slug: 'worldgen' }, { slug: 'world-generation' }]),
    ).toHaveLength(1);
  });
  it.each([
    ['dedicated_server_only', 'server', 'dedicated-server'],
    ['server_only', 'server', undefined],
    ['client_only', 'client', undefined],
    ['singleplayer_only', 'client', 'singleplayer'],
    ['client_and_server', 'both', undefined],
    ['server_only_client_optional', 'both', 'client-optional'],
    ['client_only_server_optional', 'both', 'server-optional'],
    ['client_or_server_prefers_both', 'both', 'prefers-both'],
    ['client_or_server', 'both', 'either'],
    ['future', 'unknown', undefined],
  ])('normalizes environment %s without losing nuance', (environment, kind, detail) => {
    expect(modrinthEnvironment({ environment })).toEqual({
      kind,
      ...(detail ? { detail } : {}),
      source: 'modrinth',
      original: [environment],
    });
  });
  it('uses legacy side metadata only when precise enough and retains mixed unknown project environments', () => {
    expect(modrinthEnvironment({ client_side: 'unsupported', server_side: 'required' }).kind).toBe(
      'server',
    );
    expect(modrinthEnvironment({ client_side: 'required', server_side: 'optional' }).kind).toBe(
      'both',
    );
    expect(modrinthEnvironment({ server_side: 'required' }).kind).toBe('unknown');
    expect(modrinthEnvironment({ environment: ['client_only', 'server_only'] }).kind).toBe(
      'unknown',
    );
  });
  it('returns browser-safe MR search/details and paginated versions with stable recommendation', async () => {
    const { provider, json } = mr(
      [project('a')],
      [
        version('beta', 'a', { version_type: 'beta', date_published: '2026-10-12T00:00:00Z' }),
        version('stable', 'a'),
        version('old', 'a', { game_versions: ['1.20.1'], date_published: '2026-10-08T00:00:00Z' }),
      ],
    );
    expect((await provider.searchMods({ query: 'a', target })).items[0]).toMatchObject({
      id: 'a',
      environment: { kind: 'both' },
    });
    expect((await provider.modDetails('a')).descriptionFormat).toBe('markdown');
    const listed = await provider.modVersions('a', { target });
    expect(listed.recommendedId).toBe('stable');
    expect(listed.items).toHaveLength(2);
    expect((await provider.modVersions('a', { target, preferBeta: true })).recommendedId).toBe(
      'beta',
    );
    expect(
      (await provider.modVersions('a', { target, includeIncompatible: true })).items.find(
        (item) => item.id === 'old',
      )?.compatibility,
    ).toEqual(['minecraft-version']);
    expect(JSON.stringify(listed)).not.toContain('cdn.modrinth.com');
    expect(json.mock.calls.some(([url]) => url.includes('include_changelog=false'))).toBe(true);
  });
  it('does not infer a CurseForge execution side from topic categories', async () => {
    const { provider } = cf(
      [cfProject(1, { categories: [{ slug: 'server-utility', name: 'Server Utility' }] })],
      [cfFile(2, 1)],
    );
    expect((await provider.searchMods({ query: '', target })).items[0]?.environment.kind).toBe(
      'unknown',
    );
    expect((await provider.modDetails('1')).descriptionFormat).toBe('html');
    expect((await provider.modVersions('1', { target })).items[0]?.channel).toBe('release');
  });
  it.each([
    [['Client'], 'client'],
    [['Server'], 'server'],
    [['Client', 'Server'], 'both'],
    [[], 'unknown'],
  ] as const)(
    'normalizes CurseForge Environment tags %j without extra reads',
    async (tags, kind) => {
      const gameVersions = ['1.21.1', 'Fabric', ...tags];
      const { provider, json } = cf(
        [cfProject(1, { latestFiles: [{ gameVersions }] })],
        [cfFile(2, 1, { gameVersions })],
      );
      const expected = { kind, source: 'curseforge', original: [...tags] };
      expect((await provider.searchMods({ query: '', target })).items[0]?.environment).toEqual(
        expected,
      );
      expect(json).toHaveBeenCalledTimes(1);
      expect((await provider.modDetails('1')).environment).toEqual(expected);
      expect(json).toHaveBeenCalledTimes(3);
      const listed = await provider.modVersions('1', { target });
      expect(json).toHaveBeenCalledTimes(5);
      expect(listed.items[0]).toMatchObject({
        environment: expected,
        gameVersions: ['1.21.1'],
        loaders: ['fabric'],
        compatibility: kind === 'client' ? ['client-only'] : [],
      });
      expect(listed.recommendedId).toBe(kind === 'client' ? undefined : '2');
    },
  );
  it('summarizes declared project sides without guessing untagged or different file environments', async () => {
    const { provider } = cf(
      [
        cfProject(1, {
          latestFiles: [
            { gameVersions: ['1.21.1', 'Fabric', 'Client', 'Server'] },
            { gameVersions: ['1.20.1', 'Forge'] },
          ],
        }),
        cfProject(2, {
          latestFiles: [
            { gameVersions: ['1.21.1', 'Fabric', 'Client'] },
            { gameVersions: ['1.21.1', 'Forge', 'Server'] },
          ],
        }),
      ],
      [cfFile(3, 1)],
    );
    const search = await provider.searchMods({ query: '', target });
    expect(search.items.map((item) => item.environment.kind)).toEqual(['both', 'unknown']);
    // A project summary must not fill missing evidence for one particular download.
    expect((await provider.modVersions('1', { target })).items[0]?.environment).toEqual({
      kind: 'unknown',
      source: 'curseforge',
      original: [],
    });
  });
  it('deduplicates environment tags without interpreting category or unrelated version labels', () => {
    expect(curseforgeEnvironment(['Server', 'Client', 'Client', 'Fabric'])).toEqual({
      kind: 'both',
      source: 'curseforge',
      original: ['Client', 'Server'],
    });
    expect(curseforgeEnvironment(['Server Utility', 'Java 21', '1.21.1']).kind).toBe('unknown');
  });
  it('requires explicit force for a CurseForge client-only file and preserves its declaration', async () => {
    const { provider } = cf(
      [cfProject(1, { latestFiles: [{ gameVersions: ['Client', 'Server'] }] })],
      [cfFile(2, 1, { gameVersions: ['1.21.1', 'Fabric', 'Client'] })],
    );
    const blocked = await provider.resolveMods([root('1', { versionId: '2' })], target);
    expect(blocked.catalog.blocked[0]?.reason).toBe('incompatible-version');
    expect(blocked.plan.artifacts).toHaveLength(0);
    const forced = await provider.resolveMods(
      [root('1', { versionId: '2', forceIncompatible: true })],
      target,
    );
    expect(forced.catalog.blocked).toEqual([]);
    expect(forced.catalog.items[0]).toMatchObject({
      forced: true,
      version: {
        environment: { kind: 'client', source: 'curseforge', original: ['Client'] },
        compatibility: ['client-only'],
      },
    });
    expect(forced.plan.artifacts).toHaveLength(1);
  });
});

describe('Mods graph selection', () => {
  it('selects stable by default, newest beta when enabled, beta fallback, never implicit alpha', async () => {
    const { provider } = mr(
      [project('a'), project('b'), project('c')],
      [
        version('beta', 'a', { version_type: 'beta', date_published: '2026-10-12T00:00:00Z' }),
        version('stable', 'a'),
        version('onlybeta', 'b', { version_type: 'beta' }),
        version('alpha', 'c', { version_type: 'alpha' }),
      ],
    );
    expect((await provider.resolveMods([root('a')], target)).catalog.items[0]?.version.id).toBe(
      'stable',
    );
    expect(
      (await provider.resolveMods([root('a')], target, { preferBeta: true })).catalog.items[0]
        ?.version.id,
    ).toBe('beta');
    expect(
      (await provider.resolveMods([root('b')], target)).catalog.items[0]?.version.channel,
    ).toBe('beta');
    expect((await provider.resolveMods([root('c')], target)).catalog.blocked[0]?.reason).toBe(
      'unavailable',
    );
    expect(
      (await provider.resolveMods([root('c', { versionId: 'alpha' })], target)).catalog.items[0]
        ?.version.channel,
    ).toBe('alpha');
  });
  it('deduplicates shared required dependencies and retains optional/embedded metadata without downloads', async () => {
    const dependencies = [
      { project_id: 'shared', dependency_type: 'required' },
      { project_id: 'optional', dependency_type: 'optional' },
      { project_id: 'embedded', dependency_type: 'embedded' },
    ];
    const { provider, json } = mr(
      ['a', 'b', 'shared', 'optional', 'embedded'].map((pid) => project(pid)),
      [
        version('va', 'a', { dependencies }),
        version('vb', 'b', { dependencies: dependencies.slice(0, 1) }),
        version('vs', 'shared'),
        version('vo', 'optional'),
      ],
    );
    const result = await provider.resolveMods([root('a'), root('b')], target);
    expect(result.catalog.blocked).toEqual([]);
    expect(result.plan.artifacts).toHaveLength(3);
    expect(result.catalog.items.find((item) => item.project.id === 'shared')?.requiredBy).toEqual([
      'a',
      'b',
    ]);
    expect(result.catalog.optional[0]?.projectId).toBe('optional');
    expect(result.catalog.embedded[0]?.projectId).toBe('embedded');
    expect(
      json.mock.calls.filter(([url]) => new URL(url).pathname === '/v2/project/shared'),
    ).toHaveLength(1);
    expect(
      json.mock.calls.filter(([url]) => url.includes('/project/shared/version?')),
    ).toHaveLength(1);
    expect(
      (await provider.resolveMods([root('a', { optionalProjectIds: ['optional'] })], target)).plan
        .artifacts,
    ).toHaveLength(3);
  });
  it('preserves installed compatible dependency versions instead of choosing a new release', async () => {
    const { provider } = mr(
      [project('a'), project('dep')],
      [
        version('va', 'a', { dependencies: [{ project_id: 'dep', dependency_type: 'required' }] }),
        version('old', 'dep', { date_published: '2026-10-01T00:00:00Z' }),
        version('new', 'dep'),
      ],
    );
    const result = await provider.resolveMods([root('a')], target, {
      installedVersions: new Map([['dep', 'old']]),
    });
    expect(result.catalog.items.find((item) => item.project.id === 'dep')?.version.id).toBe('old');
  });
  it('selects the latest requested root even when an older version is installed', async () => {
    const { provider } = mr(
      [project('a')],
      [version('old', 'a', { date_published: '2026-10-01T00:00:00Z' }), version('new', 'a')],
    );
    const output = await provider.resolveMods([root('a')], target, {
      installedVersions: new Map([['a', 'old']]),
    });
    expect(output.catalog.items[0]?.version.id).toBe('new');
    const curseforge = cf(
      [cfProject(1)],
      [cfFile(3, 1), cfFile(2, 1, { fileDate: '2026-10-01T00:00:00Z' })],
    );
    expect(
      (
        await curseforge.provider.resolveMods([root('1')], target, {
          installedVersions: new Map([['1', '2']]),
        })
      ).catalog.items[0]?.version.id,
    ).toBe('3');
  });
  it('resolves explicit pins across shared roots and reports incompatible pins/conflicts', async () => {
    const { provider } = mr(
      [project('a'), project('b'), project('dep')],
      [
        version('va', 'a', {
          dependencies: [{ project_id: 'dep', version_id: 'v1', dependency_type: 'required' }],
        }),
        version('vb', 'b', {
          dependencies: [{ project_id: 'dep', version_id: 'v2', dependency_type: 'required' }],
        }),
        version('v1', 'dep'),
        version('v2', 'dep', { date_published: '2026-10-12T00:00:00Z' }),
      ],
    );
    const result = await provider.resolveMods([root('a'), root('b')], target);
    expect(result.catalog.blocked.some((item) => item.reason === 'version-conflict')).toBe(true);
    const conflict = mr(
      [project('a'), project('b')],
      [
        version('va', 'a', {
          dependencies: [{ project_id: 'b', dependency_type: 'incompatible' }],
        }),
        version('vb', 'b'),
      ],
    );
    expect(
      (await conflict.provider.resolveMods([root('a'), root('b')], target)).catalog.blocked[0]
        ?.reason,
    ).toBe('conflict');
  });
  it('allows explicit incompatible exact versions with auditable reasons, never auto-force dependencies', async () => {
    const { provider } = mr(
      [project('a'), project('dep')],
      [
        version('va', 'a', {
          game_versions: ['1.20.1'],
          loaders: ['forge'],
          environment: 'client_only',
          dependencies: [{ project_id: 'dep', version_id: 'vd', dependency_type: 'required' }],
        }),
        version('vd', 'dep', { game_versions: ['1.20.1'] }),
      ],
    );
    expect(
      (await provider.resolveMods([root('a', { versionId: 'va' })], target)).catalog.blocked[0]
        ?.reason,
    ).toBe('incompatible-version');
    const forced = await provider.resolveMods(
      [root('a', { versionId: 'va', forceIncompatible: true })],
      target,
    );
    expect(forced.catalog.items[0]?.forced).toBe(true);
    expect(forced.plan.artifacts[0]?.compatibilityOverride).toEqual([
      'minecraft-version',
      'loader',
      'client-only',
    ]);
    expect(forced.plan.artifacts[0]?.allowClientOnly).toBe(true);
    expect(forced.catalog.blocked[0]).toMatchObject({
      projectId: 'dep',
      reason: 'incompatible-version',
    });
    await expect(
      provider.resolveMods([root('a', { forceIncompatible: true })], target),
    ).rejects.toMatchObject({ details: { contentReason: 'content_override_requires_version' } });
  });
  it('forbids unavailable distributions and corrupt artifact metadata even under force', async () => {
    const denied = cf([cfProject(1, { allowModDistribution: false })], [cfFile(2, 1)]);
    expect(
      (
        await denied.provider.resolveMods(
          [root('1', { versionId: '2', forceIncompatible: true })],
          target,
        )
      ).catalog.blocked[0]?.reason,
    ).toBe('unavailable');
    const corrupt = cf([cfProject(1)], [cfFile(2, 1, { hashes: [] })]);
    expect(
      (
        await corrupt.provider.resolveMods(
          [root('1', { versionId: '2', forceIncompatible: true })],
          target,
        )
      ).plan.artifacts,
    ).toHaveLength(0);
  });
  it.each(['curseforge', 'modrinth'] as const)(
    'distinguishes a missing compatible dependency from a blocked download on %s',
    async (name) => {
      const available =
        name === 'curseforge'
          ? cf(
              [cfProject(1), cfProject(2)],
              [
                cfFile(10, 1, { dependencies: [{ modId: 2, relationType: 3 }] }),
                cfFile(20, 2, { gameVersions: ['1.21.2', 'Fabric'] }),
              ],
            )
          : mr(
              [project('1'), project('2')],
              [
                version('10', '1', {
                  dependencies: [{ project_id: '2', dependency_type: 'required' }],
                }),
                version('20', '2', { game_versions: ['1.21.2'] }),
              ],
            );
      const { provider, json } = available;
      const result = await provider.resolveMods([root('1')], target);
      expect(result.catalog.blocked).toEqual([
        expect.objectContaining({
          projectId: '2',
          requiredBy: '1',
          reason: 'incompatible-version',
        }),
      ]);
      expect(result.catalog.items.map((item) => item.project.id)).toEqual(['1']);
      expect(result.plan.artifacts.some((artifact) => artifact.projectId === '2')).toBe(false);
      // Classification reuses the existing filtered lookup, without probing other targets.
      const calls = json.mock.calls.map(([url]) => url);
      expect(calls).toHaveLength(4);
      expect(calls.some((url) => url.includes('1.21.2'))).toBe(false);

      const blocked =
        name === 'curseforge'
          ? cf([cfProject(1, { allowModDistribution: false })], [cfFile(10, 1)])
          : mr(
              [project('1')],
              [
                version('10', '1', {
                  files: [{ ...version('10', '1').files[0], filename: 'bad.zip' }],
                }),
              ],
            );
      expect(
        (await blocked.provider.resolveMods([root('1')], target)).catalog.blocked[0]?.reason,
      ).toBe('unavailable');
    },
  );
  it('reports unpinned client-only candidates as incompatible instead of download-unavailable', async () => {
    const { provider } = cf(
      [cfProject(1)],
      [cfFile(10, 1, { gameVersions: ['1.21.1', 'Fabric', 'Client'] })],
    );
    expect((await provider.resolveMods([root('1')], target)).catalog.blocked[0]?.reason).toBe(
      'incompatible-version',
    );
  });
  it('walks CF stable selection beyond the first page and uses beta only if no stable exists', async () => {
    const files = [
      ...Array.from({ length: 50 }, (_, i) => cfFile(100 + i, 1, { releaseType: 2 })),
      cfFile(2, 1, { fileDate: '2026-09-01T00:00:00Z' }),
    ];
    const { provider, json } = cf([cfProject(1)], files);
    expect((await provider.resolveMods([root('1')], target)).catalog.items[0]?.version.id).toBe(
      '2',
    );
    expect(json.mock.calls.some(([url]) => url.includes('index=50'))).toBe(true);
    expect(
      (await provider.resolveMods([root('1')], target, { preferBeta: true })).catalog.items[0]
        ?.version.channel,
    ).toBe('beta');
    expect(
      (await cf([cfProject(1)], files.slice(0, 2)).provider.resolveMods([root('1')], target))
        .catalog.items[0]?.version.channel,
    ).toBe('beta');
  });
  it('rejects provider project/version identity mismatch and path traversal', async () => {
    const { provider } = mr([project('a'), project('b')], [version('v', 'b')]);
    await expect(
      provider.resolveMods([root('a', { versionId: 'v' })], target),
    ).rejects.toMatchObject({ details: { contentReason: 'dependency_identity' } });
    const bad = mr(
      [project('a')],
      [
        version('v', 'a', {
          files: [
            {
              url: 'https://cdn.modrinth.com/a.jar',
              filename: '../a.jar',
              size: 10,
              hashes: { sha1: 'a'.repeat(40) },
              primary: true,
            },
          ],
        }),
      ],
    );
    expect(
      (
        await bad.provider.resolveMods(
          [root('a', { versionId: 'v', forceIncompatible: true })],
          target,
        )
      ).catalog.blocked[0]?.reason,
    ).toBe('unavailable');
  });
});

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function jar(environment: string, metadata: Record<string, unknown> = {}): Promise<Buffer> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  zip.addBuffer(Buffer.from(JSON.stringify({ environment, ...metadata })), 'fabric.mod.json');
  zip.end();
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
describe('Mods preparation side receipt', () => {
  it('extracts Fabric identity alongside environment for cross-provider duplicate detection', async () => {
    const base = await mkdtemp(join(tmpdir(), 'nh-mods-id-'));
    temporary.push(base);
    const path = join(base, 'fixture.jar');
    await writeFile(path, await jar('*', { id: 'fabric-api', version: '1.0.0' }));
    expect(await inspectJarMetadata(path)).toEqual({
      environment: 'both',
      fabric: { id: 'fabric-api', version: '1.0.0' },
    });
    await writeFile(path, await jar('*', { id: '../not-an-id' }));
    await expect(inspectJarMetadata(path)).rejects.toMatchObject({
      details: { contentReason: 'jar_mod_id' },
    });
  });

  it('retains archive side evidence, rejects client-only by default and permits only explicit force without weakening hashes', async () => {
    const base = await mkdtemp(join(tmpdir(), 'nh-mods-'));
    temporary.push(base);
    const mountdataRoot = join(base, 'mountdata');
    await mkdir(mountdataRoot);
    const bytes = await jar('client');
    const input: ContentPlan = {
      format: 'individual',
      target,
      overrides: [],
      projects: [],
      warnings: [],
      artifacts: [
        {
          path: 'mods/client.jar',
          urls: ['https://cdn.modrinth.com/client.jar'],
          size: bytes.length,
          hashes: { sha1: createHash('sha1').update(bytes).digest('hex') },
          kind: 'mod',
          serverSide: 'unknown',
        },
      ],
    };
    const http: ContentHttp = {
      json: vi.fn(),
      download: async (_artifact, path) => {
        await writeFile(path, bytes);
        return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      },
    };
    await expect(
      stageContent(input, {
        mountdataRoot,
        jobId: 'strict',
        http,
        diskPolicy: { minimumFreePercent: 0, minimumFreeBytes: 0 },
      }),
    ).rejects.toMatchObject({ details: { contentReason: 'client_or_unknown_content' } });
    const artifact = input.artifacts[0];
    if (!artifact) throw new Error('fixture artifact missing');
    artifact.allowClientOnly = true;
    expect(
      (
        await stageContent(input, {
          mountdataRoot,
          jobId: 'forced',
          http,
          diskPolicy: { minimumFreePercent: 0, minimumFreeBytes: 0 },
        })
      ).manifest[0]?.environment,
    ).toBe('client');
    artifact.hashes.sha1 = '0'.repeat(40);
    await expect(
      stageContent(input, {
        mountdataRoot,
        jobId: 'bad-hash',
        http,
        diskPolicy: { minimumFreePercent: 0, minimumFreeBytes: 0 },
      }),
    ).rejects.toMatchObject({ details: { contentReason: 'download_hash' } });
  });
});
