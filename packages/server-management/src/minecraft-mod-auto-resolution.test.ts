import { ModrinthProvider } from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModSelection } from '../../content-providers/src/mod-catalog.js';
import { resolveModsAutomatically } from './minecraft-mod-auto-resolution.js';

const target = { minecraftVersion: '26.1', loader: 'fabric' as const };
const root = (projectId: string, extra: Partial<ModSelection> = {}): ModSelection => ({
  projectId,
  forceIncompatible: false,
  optionalProjectIds: [],
  ...extra,
});
function version(
  id: string,
  project: string,
  day: number,
  dependencies: { project_id: string; dependency_type?: string; version_id?: string }[] = [],
) {
  return {
    id,
    project_id: project,
    name: id,
    version_number: id,
    game_versions: ['26.1'],
    loaders: ['fabric'],
    version_type: 'release',
    date_published: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`,
    environment: 'client_and_server',
    files: [
      {
        filename: `${project}-${id}.jar`,
        url: `https://cdn.modrinth.com/${id}.jar`,
        primary: true,
        size: 10,
        hashes: { sha1: 'a'.repeat(40) },
      },
    ],
    dependencies: dependencies.map((dependency) => ({
      dependency_type: 'required',
      ...dependency,
    })),
  };
}
function fixture(versions: ReturnType<typeof version>[], roots = [root('a')]) {
  const json = vi.fn(async (input: string): Promise<unknown> => {
    const url = new URL(input);
    const parts = url.pathname.replace('/v2', '').split('/').filter(Boolean);
    if (parts[0] === 'version') return versions.find((item) => item.id === parts[1]);
    if (parts[2] === 'version') return versions.filter((item) => item.project_id === parts[1]);
    return {
      id: parts[1],
      slug: parts[1],
      title: parts[1],
      description: '',
      project_type: 'mod',
      downloads: 0,
      environment: ['client_and_server'],
    };
  });
  const download = vi.fn();
  const provider = new ModrinthProvider({ json, download });
  const resolve = vi.spyOn(provider, 'resolveMods');
  const list = vi.spyOn(provider, 'modVersions');
  const input = {
    provider,
    roots,
    target,
    preferBeta: false,
    maxVersions: 25,
    replacePinned: false,
  };
  return { input, provider, resolve, list, json, download };
}
afterEach(() => vi.restoreAllMocks());

describe('automatic bounded Mods resolution', () => {
  it('does not search or acquire artifacts for a healthy initial selection', async () => {
    const { input, resolve, list, json, download } = fixture([version('new', 'a', 3)]);
    expect((await resolveModsAutomatically(input)).catalog.blocked).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledTimes(2);
    expect(download).not.toHaveBeenCalled();
  });

  it('skips the known failing version, chooses the first resolvable alternative and reuses that plan', async () => {
    const { input, resolve, list, json } = fixture([
      version('new', 'a', 3, [{ project_id: 'missing' }]),
      version('middle', 'a', 2, [{ project_id: 'missing' }]),
      version('old', 'a', 1),
    ]);
    const original = JSON.stringify(input.roots);
    const result = await resolveModsAutomatically(input);
    expect(result.catalog.items[0]?.version.id).toBe('old');
    expect(result.catalog.blocked).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(input.roots)).toBe(original);
    const memo = resolve.mock.calls[0]?.[2]?.metadataMemo;
    expect(memo).toBeDefined();
    expect(resolve.mock.calls.every(([, , options]) => options?.metadataMemo === memo)).toBe(true);
    expect(list.mock.calls[0]?.[1].metadataMemo).toBe(memo);
    expect(
      json.mock.calls.filter(([url]) => new URL(url).pathname === '/v2/project/a'),
    ).toHaveLength(1);
    expect(json.mock.calls.some(([url]) => new URL(url).pathname.startsWith('/v2/version/'))).toBe(
      false,
    );
  });

  it.each([false, true])(
    'fixes independent roots without requiring the whole graph to be green (shared dependency: %s)',
    async (shared) => {
      const { input, resolve, list } = fixture(
        [
          version('a-new', 'a', 3, [{ project_id: 'x' }]),
          version('a-old', 'a', 1),
          version('b-new', 'b', 3, [{ project_id: shared ? 'x' : 'y' }]),
          version('b-old', 'b', 1),
        ],
        [root('a'), root('b')],
      );
      const result = await resolveModsAutomatically(input);
      expect(result.catalog.blocked).toEqual([]);
      expect(result.catalog.items.map((item) => item.version.id)).toEqual(['a-old', 'b-old']);
      expect(resolve).toHaveBeenCalledTimes(3);
      expect(list.mock.calls.map(([projectId]) => projectId)).toEqual(['a', 'b']);
      expect(resolve.mock.calls[2]?.[0][0]?.versionId).toBe('a-old');
    },
  );

  it('rejects a candidate that conflicts with a previously healthy selected root', async () => {
    const { input, resolve } = fixture(
      [
        version('a-new', 'a', 3, [{ project_id: 'missing' }]),
        version('a-middle', 'a', 2, [{ project_id: 'b', dependency_type: 'incompatible' }]),
        version('a-old', 'a', 1),
        version('b-ok', 'b', 1),
      ],
      [root('a'), root('b')],
    );
    const result = await resolveModsAutomatically(input);
    expect(result.catalog.blocked).toEqual([]);
    expect(result.catalog.items.map((item) => item.version.id)).toEqual(['a-old', 'b-ok']);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('shares one attempt budget across roots and retains successful partial progress', async () => {
    const { input, resolve, list } = fixture(
      [
        version('a-new', 'a', 3, [{ project_id: 'x' }]),
        version('a-old', 'a', 1),
        version('b-new', 'b', 3, [{ project_id: 'y' }]),
        version('b-old', 'b', 1),
      ],
      [root('a'), root('b')],
    );
    const result = await resolveModsAutomatically({ ...input, maxVersions: 1 });
    expect(result.catalog.items.find((item) => item.project.id === 'a')?.version.id).toBe('a-old');
    expect(result.catalog.blocked).toMatchObject([{ projectId: 'y' }]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('preserves manual pins unless explicitly allowed, and always preserves forced selections', async () => {
    const versions = [version('new', 'a', 3, [{ project_id: 'missing' }]), version('old', 'a', 1)];
    const pinned = fixture(versions, [root('a', { versionId: 'new' })]);
    expect((await resolveModsAutomatically(pinned.input)).catalog.blocked).not.toHaveLength(0);
    expect(pinned.list).not.toHaveBeenCalled();
    const replaced = fixture(versions, [root('a', { versionId: 'new' })]);
    expect(
      (await resolveModsAutomatically({ ...replaced.input, replacePinned: true })).catalog.items[0]
        ?.version.id,
    ).toBe('old');
    expect(replaced.input.roots[0]?.versionId).toBe('new');
    const forced = fixture(versions, [root('a', { versionId: 'new', forceIncompatible: true })]);
    expect(
      (await resolveModsAutomatically({ ...forced.input, replacePinned: true })).catalog.blocked,
    ).not.toHaveLength(0);
    expect(forced.list).not.toHaveBeenCalled();
  });

  it('keeps installed dependency versions in every attempt instead of silently updating them', async () => {
    const { input, resolve } = fixture([
      version('a-new', 'a', 3, [{ project_id: 'dep' }]),
      version('a-old', 'a', 1),
      version('dep-new', 'dep', 3),
      version('dep-installed', 'dep', 1, [{ project_id: 'missing' }]),
    ]);
    const installedVersions = new Map([['dep', 'dep-installed']]);
    const result = await resolveModsAutomatically({ ...input, installedVersions });
    expect(result.catalog.items[0]?.version.id).toBe('a-old');
    expect(
      resolve.mock.calls.every(([, , options]) => options?.installedVersions === installedVersions),
    ).toBe(true);
  });

  it('never promotes alpha or incompatible versions while looking for alternatives', async () => {
    const { input, list, resolve } = fixture([
      version('new', 'a', 3, [{ project_id: 'missing' }]),
      { ...version('alpha', 'a', 2), version_type: 'alpha' },
      { ...version('wrong-game', 'a', 1), game_versions: ['1.20.1'] },
    ]);
    expect((await resolveModsAutomatically(input)).catalog.blocked).toMatchObject([
      { projectId: 'missing' },
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('keeps successful progress on the shared search deadline but propagates external cancellation', async () => {
    const versions = [
      version('a-new', 'a', 3, [{ project_id: 'x' }]),
      version('a-old', 'a', 1),
      version('b-new', 'b', 3, [{ project_id: 'y' }]),
      version('b-old', 'b', 1),
    ];
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const first = fixture(versions, [root('a'), root('b')]);
    const read = ModrinthProvider.prototype.modVersions.bind(first.provider);
    first.list.mockImplementation(async (projectId, input) => {
      if (projectId === 'b') {
        deadline.abort();
        input.signal?.throwIfAborted();
      }
      return read(projectId, input);
    });
    const result = await resolveModsAutomatically(first.input);
    expect(result.catalog.items.find((item) => item.project.id === 'a')?.version.id).toBe('a-old');
    expect(result.catalog.blocked).toMatchObject([{ projectId: 'y' }]);
    expect(timeout).toHaveBeenCalledWith(30_000);
    timeout.mockRestore();

    const external = new AbortController();
    const second = fixture(versions);
    second.list.mockImplementation(async (_projectId, input) => {
      external.abort();
      input.signal?.throwIfAborted();
      return { items: [], total: 0, limit: 20, offset: 0 };
    });
    await expect(
      resolveModsAutomatically({ ...second.input, signal: external.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it.each(['integration_unavailable', 'not_found'] as const)(
    'retains known blockers and stops the sweep after an optional %s lookup',
    async (code) => {
      const { input, resolve, list } = fixture(
        [
          version('a-new', 'a', 3, [{ project_id: 'x' }]),
          version('a-old', 'a', 1),
          version('b-new', 'b', 3, [{ project_id: 'y' }]),
          version('b-old', 'b', 1),
          version('c-new', 'c', 3, [{ project_id: 'z' }]),
          version('c-old', 'c', 1),
        ],
        [root('a'), root('b'), root('c')],
      );
      const read = ModrinthProvider.prototype.modVersions.bind(input.provider);
      list.mockImplementation(async (projectId, options) => {
        if (projectId === 'b') throw new DomainError(code, undefined, { providerStatus: 429 });
        return read(projectId, options);
      });
      const result = await resolveModsAutomatically(input);
      expect(result.catalog.items.find((item) => item.project.id === 'a')?.version.id).toBe(
        'a-old',
      );
      expect(result.catalog.blocked.map((item) => item.projectId)).toEqual(['y', 'z']);
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(list.mock.calls.map(([projectId]) => projectId)).toEqual(['a', 'b']);
    },
  );
  it('does not conceal programmer failures or failures before the initial diagnosis', async () => {
    const first = fixture([version('new', 'a', 3, [{ project_id: 'missing' }])]);
    first.list.mockRejectedValue(new Error('programmer failure'));
    await expect(resolveModsAutomatically(first.input)).rejects.toThrow('programmer failure');
    const second = fixture([]);
    second.resolve.mockRejectedValue(new DomainError('integration_unavailable'));
    await expect(resolveModsAutomatically(second.input)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
    expect(second.list).not.toHaveBeenCalled();
  });
});
