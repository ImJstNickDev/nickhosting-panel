import { describe, expect, it, vi } from 'vitest';
import { satisfactoryModSelectionSchema } from './mods.js';
import {
  latestSatisfactoryModVersion,
  satisfactoryModCompatibility,
  satisfactoryModDetails,
  satisfactoryModVersions,
  searchSatisfactoryMods,
} from './mods-catalog.js';
import { readSatisfactoryModInventory } from './mods-inventory.js';
import { diffSatisfactoryMods } from './mods-plan.js';
import { exportSatisfactoryProfile, importSatisfactoryProfile } from './mods-profile.js';

const mod = (version = '1.0.0', dependencies: Record<string, string> = {}) => ({
  version,
  dependencies,
  targets: { LinuxServer: { hash: 'abc', link: 'https://api.ficsit.app/mod.zip' } },
});
const lock = { version: 1 as const, mods: { Example: mod(), SML: mod('3.11.0') } };

describe('SMM native profile interoperability', () => {
  it('round trips version constraints and disabled roots without trusting imported downloads', () => {
    const exported = exportSatisfactoryProfile({
      name: 'Factory with friends',
      gameVersion: 440000,
      selection: [
        { reference: 'Example', version: '>=1.0.0 <2.0.0' },
        { reference: 'Paused', version: '2.1.0', enabled: false },
      ],
      requiredTargets: ['LinuxServer', 'Windows'],
      lock,
    });
    expect(exported.profile.mods.Paused).toEqual({ version: '2.1.0', enabled: false });
    const target = exported.lockfile.mods.Example?.targets.LinuxServer;
    if (!target) throw new Error('fixture_target_missing');
    target.link = 'http://127.0.0.1/private';
    const imported = importSatisfactoryProfile(JSON.stringify(exported));
    expect(imported.selection).toEqual([
      { reference: 'Example', version: '>=1.0.0 <2.0.0', enabled: true },
      { reference: 'Paused', version: '2.1.0', enabled: false },
    ]);
    expect(imported.requiredTargets).toEqual(['LinuxServer', 'Windows']);
    expect(imported.gameVersion).toBe(440000);
    expect(imported).not.toHaveProperty('lock');
    expect(imported).not.toHaveProperty('lockfile');
    expect(JSON.stringify(imported)).not.toContain('127.0.0.1');
  });
  it('supports normal SMM ranges and rejects oversized or malformed profiles', () => {
    for (const version of [
      '>=0.0.0',
      '^1.2.3',
      '~2.1.0',
      '1.2.x',
      '*',
      '>=1.0.0, <2.0.0',
      '1.0.0 || 2.0.0',
    ])
      expect(
        satisfactoryModSelectionSchema.safeParse([{ reference: 'Example', version }]).success,
      ).toBe(true);
    expect(() => importSatisfactoryProfile(' '.repeat(2_097_153))).toThrow('too_large');
    expect(() => importSatisfactoryProfile({ profile: { name: '../evil', mods: {} } })).toThrow();
    expect(() =>
      exportSatisfactoryProfile({ name: 'Test', gameVersion: 0, selection: [], lock }),
    ).toThrow();
  });
});

describe('resolved change review', () => {
  it('explains additions and dependency removal including disabled roots', () => {
    const changes = diffSatisfactoryMods({
      previousSelection: [{ reference: 'Example', version: '1.0.0' }],
      selection: [
        { reference: 'Example', version: '1.0.0', enabled: false },
        { reference: 'NewMod', version: '2.0.0' },
      ],
      previousLock: lock,
      nextLock: {
        version: 1,
        mods: { NewMod: mod('2.0.0', { Dependency: '>=1.0.0' }), Dependency: mod() },
      },
    });
    expect(changes).toContainEqual(
      expect.objectContaining({ reference: 'Example', action: 'disable' }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({ reference: 'SML', action: 'remove', dependency: true }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        reference: 'Dependency',
        action: 'install',
        dependency: true,
        requiredBy: ['NewMod'],
      }),
    );
  });
  it('keeps a disabled root visibly installed when another root still depends on it', () => {
    const changes = diffSatisfactoryMods({
      previousSelection: [{ reference: 'Example', version: '1.0.0' }],
      selection: [
        { reference: 'Example', version: '1.0.0', enabled: false },
        { reference: 'Parent', version: '1.0.0' },
      ],
      previousLock: lock,
      nextLock: { version: 1, mods: { ...lock.mods, Parent: mod('1.0.0', { Example: '1.0.0' }) } },
    });
    expect(changes.find((change) => change.reference === 'Example')).toMatchObject({
      action: 'disable',
      toVersion: '1.0.0',
      dependency: true,
      requiredBy: ['Parent'],
    });
  });
  it('shows all installed removals for vanilla without forgetting the selected profile', () => {
    expect(
      diffSatisfactoryMods({
        previousSelection: [{ reference: 'Example', version: '1.0.0' }],
        selection: [{ reference: 'Example', version: '1.0.0' }],
        previousLock: lock,
        nextLock: lock,
        vanilla: true,
      }).map((change) => change.action),
    ).toEqual(['remove', 'remove']);
  });
});

describe('observed mod inventory', () => {
  const directory = (name: string) => ({ name, is_file: false, is_symlink: false, size: 0 });
  const file = (name: string) => ({ name, is_file: true, is_symlink: false, size: 20 });
  it('detects normal and GameFeatures mods, native locks, missing descriptors and actual build', async () => {
    const directories: Record<string, ReturnType<typeof file>[]> = {
      '': [directory('FactoryGame'), directory('Engine')],
      Engine: [directory('Binaries')],
      'Engine/Binaries': [directory('Linux')],
      'Engine/Binaries/Linux': [file('UnrealServer-Linux-Shipping.version')],
      FactoryGame: [directory('Mods')],
      'FactoryGame/Mods': [
        directory('Example'),
        directory('GameFeatures'),
        directory('Unknown'),
        directory('Removed'),
        file('remote-lock.json'),
      ],
      'FactoryGame/Mods/Example': [file('Example.uplugin'), file('.smm')],
      'FactoryGame/Mods/Unknown': [file('unknown.bin')],
      'FactoryGame/Mods/Removed': [directory('Binaries')],
      'FactoryGame/Mods/Removed/Binaries': [directory('Linux')],
      'FactoryGame/Mods/Removed/Binaries/Linux': [],
      'FactoryGame/Mods/GameFeatures': [directory('Feature')],
      'FactoryGame/Mods/GameFeatures/Feature': [file('Feature.uplugin'), file('.smm')],
    };
    const result = await readSatisfactoryModInventory({
      listFiles: async (path) => directories[path] ?? [],
      readFile: async (path) =>
        path.endsWith('.version')
          ? JSON.stringify({ Changelist: 440000 })
          : path.endsWith('-lock.json')
            ? JSON.stringify(lock)
            : JSON.stringify({
                FriendlyName: 'Observed mod',
                VersionName: '1.2.0',
                Plugins: [{ Name: 'SML', Enabled: true }],
              }),
      selection: [{ reference: 'Example', version: '1.0.0' }],
      lock,
    });
    expect(result.gameBuild).toBe(440000);
    expect(result.items.find((item) => item.reference === 'Example')).toMatchObject({
      version: '1.2.0',
      direct: true,
      managed: true,
    });
    expect(result.items.find((item) => item.reference === 'Feature')).toMatchObject({
      gameFeature: true,
      direct: false,
      managed: true,
    });
    expect(result.items.find((item) => item.reference === 'Unknown')?.issues).toEqual([
      'missing_descriptor',
    ]);
    expect(result.items.some((item) => item.reference === 'Removed')).toBe(false);
    expect(result.lockfiles[0]?.path).toBe('FactoryGame/Mods/remote-lock.json');
  });
  it('never traverses linked ancestors or trusts traversal in directory entries', async () => {
    const readFile = vi.fn();
    const result = await readSatisfactoryModInventory({
      listFiles: async (path) =>
        path === '' ? [{ ...directory('FactoryGame'), is_symlink: true }] : [],
      readFile,
    });
    expect(result.issues).toContainEqual({ path: 'FactoryGame', reason: 'unsafe_path' });
    expect(readFile).not.toHaveBeenCalled();
    await expect(
      readSatisfactoryModInventory({ listFiles: async () => [directory('../escape')], readFile }),
    ).rejects.toThrow('invalid');
  });
});

describe('SMR compatibility and details', () => {
  it('compares changelists without claiming unknown builds compatible', () => {
    expect(satisfactoryModCompatibility('>=400000 <500000', 440000)).toBe('compatible');
    expect(satisfactoryModCompatibility('>=500000', 440000)).toBe('incompatible');
    expect(satisfactoryModCompatibility('>=400000')).toBe('unknown');
    expect(satisfactoryModCompatibility('garbage', 440000)).toBe('unknown');
  });
  it('normalizes rich catalog metadata and omits non-HTTPS artwork', async () => {
    const project = {
      id: 'x',
      name: 'Example',
      mod_reference: 'Example',
      short_description: 'Description',
      full_description: 'Full description',
      logo: 'javascript:alert(1)',
      authors: [{ user: { username: 'Author' } }],
      tags: [{ name: 'Factory' }],
      downloads: 10,
    };
    const request = (async (_url: unknown, init: RequestInit) =>
      new Response(
        JSON.stringify({
          data: JSON.parse(String(init.body)).query.includes('ModDetails')
            ? { mod: project }
            : { mods: { count: 1, mods: [project] } },
        }),
      )) as typeof fetch;
    expect((await searchSatisfactoryMods({ query: '', fetch: request })).items[0]).toMatchObject({
      logo: null,
      description: 'Description',
      authors: ['Author'],
      tags: ['Factory'],
    });
    expect(await satisfactoryModDetails('Example', { fetch: request })).toMatchObject({
      fullDescription: 'Full description',
    });
  });
  it('sorts versions, filters client-only packages and excludes prerelease upgrades by default', async () => {
    const version = (value: string, target = 'LinuxServer') => ({
      version: value,
      game_version: '>=400000',
      required_on_remote: true,
      changelog: '',
      dependencies: [],
      targets: [{ targetName: target }],
    });
    const versions = await satisfactoryModVersions('Example', undefined, {
      gameBuild: 440000,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            data: {
              mod: {
                versions: [
                  version('1.0.0'),
                  version('3.0.0', 'Windows'),
                  version('2.0.0-beta.1'),
                  version('1.5.0'),
                ],
              },
            },
          }),
        )) as typeof fetch,
    });
    expect(versions.map((item) => item.version)).toEqual(['2.0.0-beta.1', '1.5.0', '1.0.0']);
    expect(latestSatisfactoryModVersion(versions)?.version).toBe('1.5.0');
    expect(latestSatisfactoryModVersion(versions, { includePrerelease: true })?.version).toBe(
      '2.0.0-beta.1',
    );
  });
});
