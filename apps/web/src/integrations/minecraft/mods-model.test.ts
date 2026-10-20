import { describe, expect, it } from 'vitest';
import type {
  MinecraftModsSnapshot,
  MinecraftModUpdates,
  ModCatalogVersion,
} from '../../../../../games/minecraft/src/ui/mods-controller.js';
import {
  currentModUpdates,
  eligibleModUpdates,
  installedModsFingerprint,
  matchesMod,
  modBlockerChain,
  modRootState,
  versionForMod,
} from './mods-model.js';

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

describe('Mods update projection', () => {
  const installed: MinecraftModsSnapshot = {
    ...snapshot,
    changes: [],
    packs: [{ ...change, state: 'disabled' }],
  };
  const version: ModCatalogVersion = {
    provider: 'modrinth',
    id: 'mr-two',
    projectId: 'fabric-api',
    name: '2.0',
    version: '2.0',
    filename: 'api.jar',
    gameVersions: ['26.1'],
    loaders: ['fabric'],
    publishedAt: '2026-10-20T12:00:00Z',
    bytes: 12,
    channel: 'release',
    available: true,
    compatibility: [],
    environment: { kind: 'both', source: 'modrinth', original: [] },
  };
  const updates: MinecraftModUpdates = {
    checkedAt: '2026-10-20T12:00:00Z',
    items: [
      {
        path: change.path,
        provider: 'modrinth',
        projectId: 'fabric-api',
        currentVersionId: 'mr-one',
        status: 'update',
        version,
      },
    ],
  };
  it('allows disabled installed mods but never stale versions or unrelated files', () => {
    expect(eligibleModUpdates(installed, updates, [])).toHaveLength(1);
    const stale = {
      ...installed,
      packs: [
        {
          ...change,
          state: 'disabled' as const,
          metadata: { ...metadata, versionId: 'already-replaced' },
        },
      ],
    };
    expect(currentModUpdates(stale, updates)).toEqual([]);
    expect(installedModsFingerprint(stale)).not.toBe(installedModsFingerprint(installed));
  });
  it('preserves alias selections and queued disable/delete/replace actions', () => {
    expect(
      eligibleModUpdates(installed, updates, [
        { ...alias, forceIncompatible: false, optionalProjectIds: [] },
      ]),
    ).toEqual([]);
    for (const action of ['enable', 'disable', 'delete', 'install'] as const) {
      expect(
        eligibleModUpdates({ ...installed, changes: [{ ...change, action }] }, updates, []),
      ).toEqual([]);
    }
  });
  it('rejects inaccessible, incompatible and mismatched update candidates', () => {
    for (const candidate of [
      { ...version, available: false },
      { ...version, compatibility: ['loader' as const] },
      { ...version, projectId: 'foreign' },
      { ...version, id: metadata.versionId },
    ]) {
      expect(
        eligibleModUpdates(
          installed,
          {
            ...updates,
            items: [
              {
                path: change.path,
                provider: 'modrinth',
                projectId: 'fabric-api',
                currentVersionId: 'mr-one',
                status: 'update',
                version: candidate,
              },
            ],
          },
          [],
        ),
      ).toEqual([]);
    }
  });
});

it('groups independent roots rather than inventing a linear dependency chain', () => {
  const blocker = {
    projectId: 'shared',
    name: 'Shared',
    reason: 'incompatible-version',
    roots: [
      { projectId: 'a', name: 'Alpha' },
      { projectId: 'b', name: 'Beta' },
    ],
    requiredBy: 'a',
    requiredByName: 'Alpha',
  };
  expect(modBlockerChain(blocker)).toBe('Alpha, Beta');
  expect(modBlockerChain({ ...blocker, requiredBy: 'middle', requiredByName: 'Middle' })).toBe(
    'Alpha, Beta → Middle',
  );
  expect(modBlockerChain({ ...blocker, roots: undefined })).toBe('Alpha');
});
