import { DomainError } from '@nickhosting/core';
import { describe, expect, it, vi } from 'vitest';
import type { ContentHttp } from './contracts.js';
import { CurseForgeProvider } from './curseforge.js';
import { ModrinthProvider } from './modrinth.js';

type Dep = {
  project_id?: string;
  version_id?: string;
  dependency_type: 'required' | 'optional' | 'embedded' | 'incompatible';
};
function fixture(
  releases: Record<
    string,
    { project?: string; deps?: Dep[]; loader?: string; game?: string; published?: string }
  >,
  options: { maxDependencies?: number } = {},
) {
  const json = vi.fn<ContentHttp['json']>(async (url) => {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    const key = parts[3];
    const toVersion = (id: string, data: (typeof releases)[string]) => ({
      id,
      project_id: data.project ?? id,
      name: id,
      version_number: id,
      game_versions: [data.game ?? '1.21.9'],
      loaders: [data.loader ?? 'datapack'],
      date_published: data.published ?? '2026-01-01T00:00:00Z',
      dependencies: data.deps ?? [],
      files: [
        {
          filename: `${id}.zip`,
          url: `https://cdn.modrinth.com/${id}.zip`,
          size: 123,
          hashes: { sha512: 'a'.repeat(128) },
          primary: true,
        },
      ],
    });
    if (parts[2] === 'version' && key && releases[key]) return toVersion(key, releases[key]);
    if (parts[2] === 'project' && key) {
      if (parts[4] === 'version')
        return Object.entries(releases)
          .filter(([id, data]) => (data.project ?? id) === key)
          .map(([id, data]) => toVersion(id, data));
      return {
        id: key,
        title: `Name ${key}`,
        project_type: 'mod',
        loaders: Object.entries(releases)
          .filter(([id, data]) => (data.project ?? id) === key)
          .map(([, data]) => data.loader ?? 'datapack'),
      };
    }
    throw new Error('fixture route');
  });
  return { json, provider: new ModrinthProvider({ json, download: vi.fn() }, { limits: options }) };
}
const required = (project_id: string, version_id?: string): Dep => ({
  project_id,
  ...(version_id ? { version_id } : {}),
  dependency_type: 'required',
});

describe('Modrinth datapack graph', () => {
  it('resolves shared recursive requirements once, preserving optional/embedded/conflict metadata', async () => {
    const { provider, json } = fixture({
      root: {
        deps: [
          required('a'),
          required('b'),
          { project_id: 'opt', dependency_type: 'optional' },
          { project_id: 'emb', dependency_type: 'embedded' },
          { project_id: 'foreign', dependency_type: 'incompatible' },
        ],
      },
      a: { deps: [required('shared')] },
      b: { deps: [required('shared')] },
      shared: { deps: [required('root')] },
      opt: {},
      emb: {},
    });
    const { plan, artifacts } = await provider.resolveDatapackPlan('root', 'root', '1.21.9');
    expect(plan.items.map((i) => i.projectId)).toEqual(['root', 'a', 'b', 'shared']);
    expect(plan.optional).toEqual([{ projectId: 'opt', name: 'Name opt', requiredBy: 'root' }]);
    expect(plan.embedded).toEqual([{ projectId: 'emb', name: 'Name emb', requiredBy: 'root' }]);
    expect(plan.items[0]?.conflicts).toEqual([{ projectId: 'foreign' }]);
    expect(plan.blocked).toEqual([]);
    expect(artifacts).toHaveLength(4);
    expect(new Set(json.mock.calls.map(([url]) => url)).size).toBe(json.mock.calls.length);
    expect(JSON.stringify(plan)).not.toContain('https://');
  });
  it('includes only explicitly selected optional dependencies', async () => {
    const { provider } = fixture({
      root: {
        deps: [
          { project_id: 'optional', dependency_type: 'optional' },
          { project_id: 'embedded', dependency_type: 'embedded' },
        ],
      },
      optional: { deps: [required('nested')] },
      nested: {},
      embedded: {},
    });
    const { plan } = await provider.resolveDatapackPlan('root', 'root', '1.21.9', undefined, [
      'optional',
      'embedded',
    ]);
    expect(plan.items.map((i) => i.projectId)).toEqual(['root', 'optional', 'nested']);
    expect(plan.items.find((item) => item.projectId === 'root')?.required).toEqual([]);
    expect(plan.items.find((item) => item.projectId === 'optional')?.required).toEqual([
      { projectId: 'nested' },
    ]);
  });
  it('reports mods without downloading them and does not fabricate a pinned requirement', async () => {
    const { provider } = fixture({ root: { deps: [required('mod')] }, mod: { loader: 'fabric' } });
    const { plan, artifacts } = await provider.resolveDatapackPlan('root', 'root', '1.21.9');
    expect(plan.blocked).toEqual([
      { projectId: 'mod', name: 'Name mod', requiredBy: 'root', reason: 'mod' },
    ]);
    expect(plan.items[0]?.required).toEqual([{ projectId: 'mod' }]);
    expect(artifacts).toHaveLength(1);
  });
  it('resolves version-only and late pins without a false latest-version conflict', async () => {
    const { provider } = fixture({
      root: { deps: [required('shared'), required('later')] },
      new: { project: 'shared', published: '2026-02-01T00:00:00Z' },
      old: { project: 'shared' },
      later: { deps: [{ version_id: 'old', dependency_type: 'required' }] },
    });
    const { plan } = await provider.resolveDatapackPlan('root', 'root', '1.21.9');
    expect(plan.items.find((i) => i.projectId === 'shared')?.versionId).toBe('old');
    expect(plan.blocked).toEqual([]);
  });
  it('reports conflicting explicit pins and internal incompatibilities', async () => {
    const { provider } = fixture({
      root: {
        deps: [
          required('shared', 'v1'),
          required('later'),
          { project_id: 'later', dependency_type: 'incompatible' },
        ],
      },
      v1: { project: 'shared' },
      v2: { project: 'shared' },
      later: { deps: [required('shared', 'v2')] },
    });
    const { plan } = await provider.resolveDatapackPlan('root', 'root', '1.21.9');
    expect(plan.blocked.map((i) => i.reason)).toEqual(['version-conflict', 'conflict']);
  });
  it('reports missing compatible releases and unknown file-only required dependencies', async () => {
    const { provider } = fixture({
      root: { deps: [required('old'), { dependency_type: 'required' }] },
      old: { game: '1.20.1' },
    });
    const { plan } = await provider.resolveDatapackPlan('root', 'root', '1.21.9');
    expect(plan.blocked.map((i) => i.reason)).toEqual(['incompatible-version', 'unresolved']);
  });
  it('checks referenced identity and bounds dependency fanout', async () => {
    await expect(
      fixture({
        root: { deps: [required('a', 'foreign')] },
        foreign: { project: 'other' },
      }).provider.resolveDatapackPlan('root', 'root', '1.21.9'),
    ).rejects.toThrow();
    await expect(
      fixture(
        { root: { deps: [required('a'), required('b')] }, a: {}, b: {} },
        { maxDependencies: 2 },
      ).provider.resolveDatapackPlan('root', 'root', '1.21.9'),
    ).rejects.toThrow();
  });
  it('reuses a compatible installed version and selects another only when incompatible', async () => {
    const { provider } = fixture({
      root: { deps: [required('shared')] },
      new: { project: 'shared', published: '2026-02-01T00:00:00Z' },
      old: { project: 'shared' },
      obsolete: { project: 'shared', game: '1.20.1' },
    });
    const kept = await provider.resolveDatapackPlan(
      'root',
      'root',
      '1.21.9',
      undefined,
      [],
      new Map([['shared', 'old']]),
    );
    expect(kept.plan.items.find((item) => item.projectId === 'shared')?.versionId).toBe('old');
    const replaced = await provider.resolveDatapackPlan(
      'root',
      'root',
      '1.21.9',
      undefined,
      [],
      new Map([['shared', 'obsolete']]),
    );
    expect(replaced.plan.items.find((item) => item.projectId === 'shared')?.versionId).toBe('new');
  });
  it('does not accept an installed mod declared for another Minecraft version', async () => {
    const { provider } = fixture({
      root: { deps: [required('mod')] },
      old: { project: 'mod', game: '1.20.1', loader: 'fabric' },
      new: { project: 'mod', loader: 'fabric' },
    });
    const { plan } = await provider.resolveDatapackPlan(
      'root',
      'root',
      '1.21.9',
      undefined,
      [],
      new Map([['mod', 'old']]),
    );
    expect(plan.blocked[0]?.reason).toBe('incompatible-version');
  });
  it('identifies a deleted dependency while propagating provider outages', async () => {
    const { provider, json } = fixture({ root: { deps: [required('gone')] } });
    const read = json.getMockImplementation();
    if (!read) throw new Error('fixture');
    json.mockImplementation(async (url, options) => {
      if (url.includes('/project/gone'))
        throw new DomainError('integration_unavailable', 503, {
          reason: 'content_http_refused',
          providerStatus: 404,
        });
      return read(url, options);
    });
    expect(
      (await provider.resolveDatapackPlan('root', 'root', '1.21.9')).plan.blocked[0],
    ).toMatchObject({ projectId: 'gone', reason: 'unresolved' });
    json.mockImplementation(async () => {
      throw new DomainError('integration_unavailable', 503);
    });
    await expect(provider.resolveDatapackPlan('root', 'root', '1.21.9')).rejects.toThrow();
  });
  it('propagates abort without issuing requests', async () => {
    const { provider, json } = fixture({ root: {} });
    const signal = AbortSignal.abort();
    await expect(provider.resolveDatapackPlan('root', 'root', '1.21.9', signal)).rejects.toThrow();
    expect(json).not.toHaveBeenCalled();
  });
});

function cfFixture() {
  const projects: Record<string, { name: string; classId: number }> = {
    '1': { name: 'Root', classId: 777 },
    '2': { name: 'Child', classId: 777 },
    '3': { name: 'Mod', classId: 6 },
    '4': { name: 'Optional', classId: 777 },
    '5': { name: 'Embedded', classId: 777 },
  };
  const dependencies: Record<string, { modId: number; relationType: number }[]> = {
    '1': [
      { modId: 2, relationType: 3 },
      { modId: 4, relationType: 2 },
      { modId: 5, relationType: 1 },
      { modId: 99, relationType: 5 },
    ],
    '2': [{ modId: 3, relationType: 3 }],
  };
  const file = (pid: string) => ({
    id: Number(pid) * 10,
    modId: Number(pid),
    gameId: 432,
    fileName: `${pid}.zip`,
    displayName: pid,
    fileDate: '2026-01-01T00:00:00Z',
    fileLength: 123,
    downloadUrl: `https://edge.forgecdn.net/${pid}.zip`,
    isAvailable: true,
    gameVersions: ['1.21.9'],
    hashes: [{ algo: 1, value: 'a'.repeat(40) }],
    dependencies: dependencies[pid] ?? [],
  });
  const json = vi.fn<ContentHttp['json']>(async (url) => {
    const u = new URL(url);
    const p = u.pathname.split('/');
    const pid = p[3];
    if (p[2] === 'categories')
      return { data: [{ id: 777, gameId: 432, slug: 'data-packs', isClass: true }] };
    if (pid && p[4] === 'files') return { data: p[5] ? file(pid) : [file(pid)] };
    if (pid && projects[pid])
      return {
        data: {
          id: Number(pid),
          gameId: 432,
          slug: `p${pid}`,
          summary: '',
          downloadCount: 0,
          authors: [],
          isAvailable: true,
          allowModDistribution: true,
          ...projects[pid],
        },
      };
    throw new Error('fixture route');
  });
  return {
    json,
    provider: new CurseForgeProvider({ json, download: vi.fn() }, { apiKey: 'fixture' }),
  };
}
describe('CurseForge datapack graph', () => {
  it('resolves class-aware dependencies, optional/embedded references and mod requirements', async () => {
    const { provider, json } = cfFixture();
    const { plan, artifacts } = await provider.resolveDatapackPlan('1', '10', '1.21.9');
    expect(plan.items.map((i) => i.projectId)).toEqual(['1', '2']);
    expect(artifacts).toHaveLength(2);
    expect(plan.blocked).toEqual([{ projectId: '3', name: 'Mod', requiredBy: '2', reason: 'mod' }]);
    expect(plan.optional).toEqual([{ projectId: '4', name: 'Optional', requiredBy: '1' }]);
    expect(plan.embedded).toEqual([{ projectId: '5', name: 'Embedded', requiredBy: '1' }]);
    expect(plan.items[0]?.conflicts).toEqual([{ projectId: '99' }]);
    expect(new Set(json.mock.calls.map(([url]) => url)).size).toBe(json.mock.calls.length);
    expect(
      json.mock.calls
        .filter(([url]) => url.includes('/files?'))
        .every(([url]) => new URL(url).searchParams.get('gameVersion') === '1.21.9'),
    ).toBe(true);
  });
  it('installs selected optional datapacks without treating embedded relations as required', async () => {
    const { plan } = await cfFixture().provider.resolveDatapackPlan(
      '1',
      '10',
      '1.21.9',
      undefined,
      ['4'],
    );
    expect(plan.items.map((i) => i.projectId)).toEqual(['1', '2', '4']);
    expect(plan.items.find((item) => item.projectId === '1')?.required).toEqual([
      { projectId: '2' },
    ]);
  });
});
