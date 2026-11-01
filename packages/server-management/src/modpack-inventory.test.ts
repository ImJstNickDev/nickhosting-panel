import type {
  FilemanDirectoryResult,
  FilemanEntry,
  FilemanReadService,
} from '@nickhosting/game-sdk';
import { describe, expect, it, vi } from 'vitest';
import type {
  MinecraftModpackReceipt,
  PreparedMinecraftModpack,
} from './minecraft-modpacks-plan.js';
import { inspectModpackFiles } from './modpack-inventory.js';

const directory = (name: string): FilemanEntry => ({ name, kind: 'directory', size: 0 });
const file = (name: string): FilemanEntry => ({
  name,
  kind: 'file',
  size: 10,
  modifiedAt: '2026-10-21T00:00:00Z',
});
const prepared = (paths: string[]): PreparedMinecraftModpack =>
  ({
    files: paths.map((path) => ({ path, size: 10, sha256: 'a'.repeat(64) })),
  }) as PreparedMinecraftModpack;
const binding = {
  combinationId: 'combination',
  mappingId: 'mapping',
  protectedPaths: ['server.jar'],
};
function fixture(tree: Record<string, FilemanEntry[]>, properties?: string) {
  const list = vi.fn(async (path: string) => tree[path] ?? []);
  const listMany = vi.fn(
    async (paths: readonly string[]): Promise<FilemanDirectoryResult[]> =>
      paths.map((directory) =>
        directory in tree
          ? { directory, files: tree[directory] ?? [] }
          : { directory, error: 'not_found' },
      ),
  );
  const service: FilemanReadService = {
    list,
    listMany,
    read: vi.fn(async () => (properties === undefined ? undefined : Buffer.from(properties))),
    readMany: vi.fn(),
    prepare: vi.fn(),
  };
  return { service, list, listMany };
}
describe('modpack scoped Fileman inventory', () => {
  it('discovers worlds without reading region data and recursively inventories content in batches', async () => {
    const f = fixture({
      '': [
        directory('world'),
        directory('mods'),
        directory('config'),
        directory('unrelated'),
        directory('.private'),
      ],
      world: [file('level.dat'), directory('region')],
      mods: [file('a.jar')],
      config: [directory('nested'), file('a.json')],
      'config/nested': [file('b.json')],
      unrelated: [directory('large')],
    });
    const result = await inspectModpackFiles(
      f.service,
      prepared(['config/nested/b.json', 'world/region/a.mca']),
      null,
      binding,
    );
    expect(result.worldRoots).toEqual(['world']);
    expect(result.replacePaths).toEqual(['mods', 'config']);
    expect(f.listMany.mock.calls.flatMap(([paths]) => paths)).toEqual([
      'world',
      'mods',
      'config',
      'unrelated',
      'config/nested',
    ]);
    expect(result.entries.find((x) => x.path === 'config/nested/b.json')).toMatchObject({
      size: 10,
      modifiedAt: '2026-10-21T00:00:00Z',
    });
    expect(f.service.read).not.toHaveBeenCalled();
    expect(f.service.prepare).not.toHaveBeenCalled();
  });
  it('never follows a symlink, known file or missing candidate parent', async () => {
    const f = fixture({
      '': [{ name: 'linked', kind: 'symlink', size: 0 }, file('blocked'), directory('custom')],
      custom: [{ name: 'link', kind: 'symlink', size: 0 }, file('blocked')],
    });
    await inspectModpackFiles(
      f.service,
      prepared([
        'linked/private/a.txt',
        'blocked/a.txt',
        'missing/sub/a.txt',
        'custom/link/a.txt',
        'custom/blocked/a.txt',
      ]),
      null,
      binding,
    );
    expect(f.listMany).toHaveBeenCalledExactlyOnceWith(['custom']);
  });
  it('scans requested nested custom parents and receipt paths once, without unrelated siblings', async () => {
    const f = fixture({
      '': [directory('custom')],
      custom: [directory('requested'), directory('old'), directory('unused')],
      'custom/requested': [file('a.txt')],
      'custom/old': [file('b.txt')],
    });
    const receipt = { files: [{ path: 'custom/old/b.txt' }] } as MinecraftModpackReceipt;
    await inspectModpackFiles(
      f.service,
      prepared(['custom/requested/a.txt', 'custom/requested/new.txt']),
      receipt,
      binding,
    );
    expect(f.listMany.mock.calls.flatMap(([paths]) => paths)).toEqual([
      'custom',
      'custom/requested',
      'custom/old',
    ]);
  });
  it('detects nested world roots encountered along candidates without traversing their contents', async () => {
    const f = fixture({
      '': [directory('worlds')],
      worlds: [directory('map')],
      'worlds/map': [file('level.dat'), directory('region')],
    });
    const result = await inspectModpackFiles(
      f.service,
      prepared(['worlds/map/region/r.0.mca']),
      null,
      binding,
    );
    expect(result.worldRoots).toEqual(['worlds/map']);
    expect(f.listMany.mock.calls.flatMap(([paths]) => paths)).toEqual(['worlds', 'worlds/map']);
  });
  it('protects the configured existing world before level.dat exists, without reading regions', async () => {
    const f = fixture(
      {
        '': [file('server.properties'), directory('maps')],
        maps: [directory('my map'), directory('other')],
        'maps/my map': [directory('region')],
      },
      'level-name=maps/my map',
    );
    const result = await inspectModpackFiles(
      f.service,
      prepared(['maps/my map/region/new.mca']),
      null,
      binding,
    );
    expect(result.worldRoots).toEqual(['maps/my map']);
    expect(f.service.read).toHaveBeenCalledExactlyOnceWith({
      path: 'server.properties',
      maxBytes: 1024 * 1024,
    });
    expect(f.listMany.mock.calls.flatMap(([paths]) => paths)).toEqual(['maps', 'maps/my map']);
  });
  it('does not reserve an absent configured world or follow its symlink on a fresh server', async () => {
    for (const extra of [[], [{ name: 'world', kind: 'symlink' as const, size: 0 }]]) {
      const f = fixture({ '': [file('server.properties'), ...extra] }, 'level-name=world');
      const result = await inspectModpackFiles(
        f.service,
        prepared(['world/level.dat']),
        null,
        binding,
      );
      expect(result.worldRoots).toEqual([]);
      expect(f.listMany).not.toHaveBeenCalled();
    }
  });
  it('uses the vanilla world default only when that directory exists', async () => {
    const f = fixture(
      { '': [file('server.properties'), directory('world')], world: [directory('region')] },
      'motd=Server',
    );
    const result = await inspectModpackFiles(
      f.service,
      prepared(['world/region/new.mca']),
      null,
      binding,
    );
    expect(result.worldRoots).toEqual(['world']);
    expect(f.listMany).toHaveBeenCalledExactlyOnceWith(['world']);
  });
  it('respects Fileman 100-directory batch limit and avoids duplicate requests', async () => {
    const tree: Record<string, FilemanEntry[]> = {
      '': Array.from({ length: 205 }, (_, i) => directory(`folder${i}`)),
    };
    for (let i = 0; i < 205; i++) tree[`folder${i}`] = [];
    const f = fixture(tree);
    await inspectModpackFiles(f.service, prepared([]), null, binding);
    expect(f.listMany.mock.calls.map(([paths]) => paths.length)).toEqual([100, 100, 5]);
  });
  it('does not treat partial, duplicate or foreign directory responses as empty directories', async () => {
    for (const output of [
      [],
      [{ directory: 'foreign', files: [] }],
      [
        { directory: 'config', files: [] },
        { directory: 'config', files: [] },
      ],
    ]) {
      const f = fixture({ '': [directory('config')] });
      f.listMany.mockResolvedValueOnce(output);
      await expect(inspectModpackFiles(f.service, prepared([]), null, binding)).rejects.toThrow();
    }
  });
  it('preserves upstream unavailable errors and handles directories removed during inventory', async () => {
    const f = fixture({ '': [directory('config')] });
    f.listMany.mockResolvedValueOnce([{ directory: 'config', error: 'forbidden' }]);
    await expect(inspectModpackFiles(f.service, prepared([]), null, binding)).rejects.toThrow();
    const g = fixture({ '': [directory('config')] });
    expect(
      (await inspectModpackFiles(g.service, prepared([]), null, binding)).entries,
    ).toHaveLength(1);
  });
  it('rejects untrusted entry names and excessive top-level discovery', async () => {
    const f = fixture({ '': [directory('../outside')] });
    await expect(inspectModpackFiles(f.service, prepared([]), null, binding)).rejects.toThrow();
    const g = fixture({ '': Array.from({ length: 1001 }, (_, i) => directory(`d${i}`)) });
    await expect(inspectModpackFiles(g.service, prepared([]), null, binding)).rejects.toThrow();
    expect(g.listMany).not.toHaveBeenCalled();
  });
});
