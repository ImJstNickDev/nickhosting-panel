import { legacyServerPermissionKeys, ownerServerPermissionKeys } from '@nickhosting/core';
import { availableGameUiSections } from '@nickhosting/game-sdk/ui';
import { expect, it } from 'vitest';
import { openworldManifest } from './manifest.js';
import { openworldUiModule } from './ui/index.js';

it('separates the roster and performance grants from inspection, moderation and native administration', () => {
  const definitions = openworldManifest.serverPermissions;
  const sections = (keys: string[]) =>
    availableGameUiSections(openworldUiModule, {
      runtimeId: 'dedicated',
      permissions: ['server:read', ...keys],
      capabilities: openworldManifest.capabilities,
    }).map(({ id }) => id);
  expect(sections(['game.openworld.players.read'])).toEqual(['players']);
  expect(sections(['game.openworld.performance.read'])).toEqual(['overview', 'performance']);
  expect(sections(['game.openworld.dashboard.admin'])).toEqual(['dashboard']);
  for (const role of ['viewer', 'operator', 'manager', 'owner'] as const) {
    expect(legacyServerPermissionKeys(role, definitions).sort()).toEqual([
      'game.openworld.performance.read',
      'game.openworld.players.read',
    ]);
  }
  expect(ownerServerPermissionKeys(definitions, true)).toEqual(
    expect.arrayContaining([
      'game.openworld.players.inspect',
      'game.openworld.players.moderate',
      'game.openworld.dashboard.admin',
    ]),
  );
});
