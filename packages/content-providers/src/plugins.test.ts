import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import {
  artifactSchema,
  type ContentHttp,
  CurseForgeProvider,
  HangarProvider,
  ModrinthProvider,
  SpigetProvider,
  stageContent,
  validateContentPlan,
} from './index.js';
import { type ModSelection, modProviderSchema, pluginProviderSchema } from './mod-catalog.js';

const target = { minecraftVersion: '1.21.1', loader: 'paper' as const };
const selection = (projectId: string, extra: Partial<ModSelection> = {}): ModSelection => ({
  projectId,
  forceIncompatible: false,
  optionalProjectIds: [],
  ...extra,
});
const project = (id = 1, extra = {}) => ({
  id,
  name: `Plugin ${id}`,
  description: 'Summary',
  namespace: { owner: 'Author', slug: `Plugin-${id}` },
  stats: { downloads: 10 },
  category: 'tools',
  mainPageContent: '# Description',
  supportedPlatforms: { PAPER: ['1.21.1'] },
  settings: { tags: [], keywords: [] },
  ...extra,
});
const version = (id = 10, pid = 1, extra = {}) => ({
  id,
  projectId: pid,
  name: `1.0.${id}`,
  createdAt: '2026-10-10T00:00:00Z',
  channel: { name: 'Release' },
  downloads: {
    PAPER: {
      downloadUrl: `https://hangarcdn.papermc.io/${pid}/${id}.jar`,
      fileInfo: { name: `plugin-${pid}.jar`, sizeBytes: 10, sha256Hash: 'a'.repeat(64) },
    },
  },
  platformDependencies: { PAPER: ['1.21.1'] },
  pluginDependencies: {},
  ...extra,
});
function hangar(projects = [project()], versions = [version()]) {
  const json = vi.fn(async (raw: string) => {
    const url = new URL(raw);
    const parts = url.pathname.replace('/api/v1', '').split('/').filter(Boolean);
    if (parts.length === 1)
      return { pagination: { count: projects.length, offset: 0 }, result: projects };
    if (parts.length === 2) return projects.find((p) => p.id === Number(parts[1]));
    if (parts.length === 4) return versions.find((v) => v.id === Number(parts[3]));
    const all = versions.filter((v) => v.projectId === Number(parts[1]));
    const offset = Number(url.searchParams.get('offset'));
    return { pagination: { count: all.length, offset }, result: all.slice(offset, offset + 20) };
  });
  return { provider: new HangarProvider({ json, download: vi.fn() }), json };
}
const spiProject = (extra = {}) => ({
  id: 1,
  name: 'Plugin',
  tag: 'Summary',
  downloads: 10,
  testedVersions: ['1.21'],
  external: false,
  premium: false,
  file: { type: '.jar', size: 1.2, sizeUnit: 'MB' },
  description: Buffer.from('<p>About<br>Plugin</p>').toString('base64'),
  category: { id: 21 },
  version: { id: 10 },
  versions: [{ id: 10 }, { id: 9 }],
  ...extra,
});
const spiVersion = (id = 10) => ({ id, resource: 1, name: `1.0.${id}`, releaseDate: 1760000000 });
function spiget(extra = {}) {
  const json = vi.fn(async (raw: string) => {
    const parts = new URL(raw).pathname.replace('/v2', '').split('/').filter(Boolean);
    if (parts[2] !== 'versions') return spiProject(extra);
    if (parts[3]) return spiVersion(Number(parts[3]));
    return [spiVersion(), spiVersion(9)];
  });
  return { provider: new SpigetProvider({ json, download: vi.fn() }), json };
}

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('plugin provider contracts', () => {
  it('keeps Mods provider choices restricted while sharing catalog identities', () => {
    expect(modProviderSchema.safeParse('hangar').success).toBe(false);
    expect(pluginProviderSchema.parse('hangar')).toBe('hangar');
  });
  it('discovers Paper plugins in Hangar and resolves required platform dependencies once', async () => {
    const { provider, json } = hangar(
      [project(), project(2)],
      [
        version(10, 1, {
          pluginDependencies: { PAPER: [{ name: 'Library', required: true, projectId: 2 }] },
        }),
        version(20, 2),
      ],
    );
    expect((await provider.searchPlugins({ target, query: 'plugin' })).items).toHaveLength(2);
    const search = new URL(json.mock.calls[0]?.[0] ?? '');
    expect(search.searchParams.get('platform')).toBe('PAPER');
    const result = await provider.resolvePlugins([selection('1')], target);
    expect(result.catalog.blocked).toEqual([]);
    expect(result.plan.artifacts.map((a) => a.path)).toEqual([
      'plugins/plugin-1.jar',
      'plugins/plugin-2.jar',
    ]);
    expect(result.plan.projects[0]?.dependencies).toEqual(['2']);
    expect(result.plan.artifacts.every((a) => a.kind === 'plugin' && a.hashes.sha256)).toBe(true);
    expect(
      json.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/projects/2')),
    ).toHaveLength(1);
  });
  it('requires explicit Folia support instead of treating every Paper artifact as compatible', async () => {
    const first = hangar();
    expect(
      (await first.provider.pluginVersion('1', '10', { ...target, loader: 'folia' })).compatibility,
    ).toContain('loader');
    const second = hangar([project(1, { settings: { tags: ['SUPPORTS_FOLIA'], keywords: [] } })]);
    expect(
      (await second.provider.pluginVersion('1', '10', { ...target, loader: 'folia' }))
        .compatibility,
    ).toEqual([]);
  });
  it('retains stable preference but can select beta, and rejects unavailable external downloads', async () => {
    const { provider } = hangar(
      [project()],
      [version(11, 1, { channel: { name: 'Beta' }, createdAt: '2026-10-11T00:00:00Z' }), version()],
    );
    expect(
      (await provider.resolvePlugins([selection('1')], target)).catalog.items[0]?.version.id,
    ).toBe('10');
    expect(
      (await provider.resolvePlugins([selection('1')], target, { preferBeta: true })).catalog
        .items[0]?.version.id,
    ).toBe('11');
    const external = hangar(
      [project()],
      [version(10, 1, { downloads: { PAPER: { externalUrl: 'https://example.com/download' } } })],
    );
    const result = await external.provider.resolvePlugins(
      [selection('1', { versionId: '10', forceIncompatible: true })],
      target,
    );
    expect(result.plan.artifacts).toEqual([]);
    expect(result.catalog.blocked[0]?.reason).toBe('unavailable');
  });
  it('does not silently ignore a required dependency hosted outside Hangar', async () => {
    const { provider } = hangar(
      [project()],
      [
        version(10, 1, {
          pluginDependencies: {
            PAPER: [
              { name: 'External', required: true, externalUrl: 'https://example.com/library' },
            ],
          },
        }),
      ],
    );
    expect((await provider.resolvePlugins([selection('1')], target)).catalog.blocked).toEqual([
      expect.objectContaining({ reason: 'unresolved', requiredBy: '1', name: 'External' }),
    ]);
  });
  it('bounds automatic Hangar candidate checks even across nightly pages', async () => {
    const versions = Array.from({ length: 40 }, (_, i) =>
      version(i + 10, 1, { channel: { name: i === 30 ? 'Release' : 'Snapshot' } }),
    );
    const { provider, json } = hangar([project()], versions);
    const result = await provider.resolvePlugins([selection('1')], target, {
      maxVersionChecks: 25,
    });
    expect(result.catalog.items).toEqual([]);
    expect(
      json.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/versions')),
    ).toHaveLength(2);
  });
  it('rejects Hangar cross-project identity and unsafe JAR paths', async () => {
    const wrong = hangar([project()], [version(10, 2)]);
    await expect(wrong.provider.pluginVersion('1', '10', target)).rejects.toThrow();
    const unsafe = hangar(
      [project()],
      [
        version(10, 1, {
          downloads: {
            PAPER: {
              downloadUrl: 'https://hangarcdn.papermc.io/a.jar',
              fileInfo: { name: '../bad.jar', sizeBytes: 10, sha256Hash: 'a'.repeat(64) },
            },
          },
        }),
      ],
    );
    expect((await unsafe.provider.pluginVersion('1', '10', target)).available).toBe(false);
  });
  it('uses exact Spiget version downloads without fabricated hashes or exact sizes', async () => {
    const { provider } = spiget();
    const result = await provider.resolvePlugins([selection('1')], target);
    expect(result.catalog.blocked).toEqual([]);
    expect(result.plan.artifacts[0]).toMatchObject({
      integrity: 'spiget-tls',
      hashes: {},
      kind: 'plugin',
      urls: ['https://api.spiget.org/v2/resources/1/versions/10/download/proxy'],
    });
    expect(result.plan.artifacts[0]?.size).toBeGreaterThan(
      result.catalog.items[0]?.version.bytes ?? 0,
    );
    const historic = await provider.pluginVersion('1', '9', target);
    expect(historic.compatibility).toContain('minecraft-version');
    const forced = await provider.resolvePlugins(
      [selection('1', { versionId: '9', forceIncompatible: true })],
      target,
    );
    expect(forced.plan.artifacts[0]?.urls[0]).toContain('/versions/9/');
  });
  it.each([{ premium: true }, { external: true }, { file: { type: '.zip' } }])(
    'keeps restricted Spiget resources unavailable: %j',
    async (extra) => {
      const { provider } = spiget(extra);
      expect((await provider.pluginVersion('1', '10', target)).available).toBe(false);
    },
  );
  it.each([3, 10, 11, 12, 13, 19, 25, 27, 29, 999])(
    'never labels proxy/standalone/unknown category %i as Paper compatible',
    async (id) => {
      const { provider } = spiget({ category: { id } });
      expect((await provider.pluginVersion('1', '10', target)).compatibility).toContain('loader');
    },
  );
  it('rejects absent hashes except the bounded exact SpiGet plugin provenance', () => {
    const artifact = {
      path: 'plugins/example.jar',
      urls: ['https://api.spiget.org/v2/resources/1/versions/10/download/proxy'],
      size: 100,
      hashes: {},
      kind: 'plugin',
      serverSide: 'required',
      projectId: '1',
      versionId: '10',
      integrity: 'spiget-tls',
    };
    expect(artifactSchema.safeParse(artifact).success).toBe(true);
    for (const changed of [
      { integrity: undefined },
      { kind: 'mod' },
      { urls: ['https://example.com/a.jar'] },
      { versionId: '11' },
      { hashes: { sha1: 'a'.repeat(40) } },
    ]) {
      expect(artifactSchema.safeParse({ ...artifact, ...changed }).success).toBe(false);
    }
  });
});

it('uses Modrinth plugin facets, Bukkit compatibility on Paper, plugins paths and the existing dependency graph', async () => {
  const json = vi.fn(async (raw: string) => {
    const url = new URL(raw);
    if (url.pathname === '/v2/search') return { offset: 0, total_hits: 0, hits: [] };
    if (url.pathname === '/v2/project/abc')
      return {
        id: 'abc',
        slug: 'plugin',
        title: 'Plugin',
        description: '',
        body: '',
        project_type: 'mod',
        loaders: ['bukkit'],
        downloads: 10,
        environment: ['server_only'],
      };
    return [
      {
        id: 'v1',
        project_id: 'abc',
        name: '1.0',
        version_number: '1.0',
        game_versions: ['1.21.1'],
        loaders: ['bukkit'],
        date_published: '2026-10-10T00:00:00Z',
        version_type: 'release',
        files: [
          {
            filename: 'example.jar',
            url: 'https://cdn.modrinth.com/example.jar',
            size: 10,
            hashes: { sha1: 'a'.repeat(40) },
          },
        ],
        dependencies: [],
      },
    ];
  });
  const provider = new ModrinthProvider({ json, download: vi.fn() });
  await provider.searchPlugins({ target, query: '' });
  const params = new URL(json.mock.calls[0]?.[0] ?? '').searchParams;
  expect(JSON.parse(params.get('facets') ?? '[]')).toContainEqual(['all_project_types:plugin']);
  expect(JSON.parse(params.get('facets') ?? '[]')).toContainEqual([
    'categories:paper',
    'categories:spigot',
    'categories:bukkit',
  ]);
  const result = await provider.resolvePlugins([selection('abc')], target);
  expect(result.catalog.blocked).toEqual([]);
  expect(result.plan.artifacts[0]).toMatchObject({ path: 'plugins/example.jar', kind: 'plugin' });
  expect(result.catalog.items[0]?.project.websiteUrl).toBe('https://modrinth.com/plugin/plugin');
});

it('discovers CurseForge Bukkit class and never applies mod loader filters to Bukkit files', async () => {
  const project = {
    id: 1,
    gameId: 432,
    classId: 5,
    slug: 'plugin',
    name: 'Plugin',
    summary: '',
    downloadCount: 0,
    authors: [],
    isAvailable: true,
    allowModDistribution: true,
  };
  const file = {
    id: 10,
    modId: 1,
    gameId: 432,
    displayName: '1.0',
    fileName: 'plugin.jar',
    fileLength: 10,
    fileDate: '2026-10-10T00:00:00Z',
    releaseType: 1,
    gameVersions: ['1.21.1'],
    isAvailable: true,
    downloadUrl: 'https://edge.forgecdn.net/a.jar',
    hashes: [{ algo: 1, value: 'a'.repeat(40) }],
    dependencies: [],
  };
  const json = vi.fn(async (raw: string) => {
    const url = new URL(raw);
    if (url.pathname === '/v1/categories')
      return { data: [{ id: 5, gameId: 432, slug: 'bukkit-plugins', isClass: true }] };
    if (url.pathname === '/v1/mods/1') return { data: project };
    const pageSize = Number(url.searchParams.get('pageSize'));
    return {
      data: url.pathname.endsWith('/search') ? [project] : [file],
      pagination: { index: 0, pageSize, resultCount: 1, totalCount: 1 },
    };
  });
  const provider = new CurseForgeProvider(
    { json, download: vi.fn() },
    { apiKey: 'fixture-private-key' },
  );
  expect((await provider.searchPlugins({ target, query: '' })).items[0]?.websiteUrl).toContain(
    '/bukkit-plugins/',
  );
  const result = await provider.resolvePlugins([selection('1')], target);
  expect(result.catalog.blocked).toEqual([]);
  expect(result.plan.artifacts[0]).toMatchObject({
    path: 'plugins/plugin.jar',
    kind: 'plugin',
    serverSide: 'required',
  });
  for (const [raw] of json.mock.calls)
    expect(new URL(raw).searchParams.has('modLoaderType')).toBe(false);
  expect(
    json.mock.calls.filter(([raw]) => new URL(raw).pathname === '/v1/categories'),
  ).toHaveLength(1);
});

it('seals a SpiGet download once and rejects edited cached bytes on recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nh-plugins-'));
  paths.push(root);
  const archive = new ZipFile();
  archive.addBuffer(Buffer.from('name: Fixture\nversion: 1\nmain: test.Main'), 'plugin.yml');
  archive.end();
  const chunks: Buffer[] = [];
  for await (const chunk of archive.outputStream) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const plan = (await spiget().provider.resolvePlugins([selection('1')], target)).plan;
  const download = vi.fn(async (_artifact, destination: string) => {
    await writeFile(destination, bytes, { flag: 'wx' });
    return { size: bytes.length, sha256 };
  });
  const options = {
    mountdataRoot: join(root, 'mountdata'),
    jobId: 'plugin-test',
    http: { json: vi.fn(), download } as ContentHttp,
  };
  const staged = await stageContent(validateContentPlan(plan), options);
  expect(staged.manifest[0]).toMatchObject({ size: bytes.length, sha256 });
  await stageContent(plan, options);
  expect(download).toHaveBeenCalledTimes(1);
  const file = join(staged.directory, plan.artifacts[0]?.path ?? '');
  const original = await readFile(file);
  original[original.length - 1] = (original[original.length - 1] ?? 0) ^ 1;
  await writeFile(file, original);
  await expect(stageContent(plan, options)).rejects.toThrow();
  expect(download).toHaveBeenCalledTimes(1);
});
