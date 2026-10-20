import { describe, expect, it } from 'vitest';
import type { MinecraftModsSnapshot } from '../../../../../games/minecraft/src/ui/mods-controller.js';
import { matchesMod, modRootState, versionForMod } from './mods-model.js';

const metadata = {
  provider: 'modrinth' as const,
  projectId: 'fabric-api',
  versionId: 'mr-one',
  name: 'Fabric API',
  version: '1.0',
  channel: 'release' as const,
  side: 'both' as const,
  tags: [],
  minecraftVersions: ['26.1'],
  loaders: ['fabric'],
};
const alias = { provider: 'curseforge' as const, projectId: '123', versionId: '456' };
const change = {
  id: 'one',
  name: 'Fabric API',
  path: 'mods/fabric-api.jar',
  size: 12,
  action: 'install' as const,
  metadata,
  aliases: [alias],
  dependency: false,
  requiredBy: [],
  forceIncompatible: false,
  incompatibilities: [],
  state: 'ready' as const,
};
const snapshot: MinecraftModsSnapshot = {
  supported: true,
  installed: true,
  running: true,
  version: '26.1',
  loader: 'fabric',
  revision: 1,
  preferBeta: false,
  roots: [],
  preparing: false,
  packs: [],
  changes: [change],
  blockers: [],
  optional: [],
  restart: { required: false },
};
describe('Mods queue projection', () => {
  it('projects one verified cross-provider artifact onto both roots without inventing a pending second upload', () => {
    expect(matchesMod(change, alias)).toBe(true);
    expect(modRootState(snapshot, alias)).toBe('ready');
    expect(versionForMod(change, alias)).toEqual({ id: '456', name: '1.0' });
    expect(versionForMod(change, metadata)).toEqual({ id: 'mr-one', name: '1.0' });
    expect(matchesMod(change, { provider: 'curseforge', projectId: 'different' })).toBe(false);
  });
  it('distinguishes a no-op installed root from a newer requested version and active preparation', () => {
    const installed = {
      ...snapshot,
      changes: [],
      packs: [{ ...change, state: 'enabled' as const }],
    };
    expect(modRootState(installed, alias)).toBe('alreadyInstalled');
    expect(modRootState(installed, { ...alias, versionId: 'newer' })).toBe('queued');
    expect(modRootState({ ...installed, preparing: true }, alias)).toBe('preparing');
    expect(
      modRootState(
        { ...installed, blockers: [{ projectId: 'other', name: 'Other', reason: 'conflict' }] },
        alias,
      ),
    ).toBe('blocked');
  });
});
