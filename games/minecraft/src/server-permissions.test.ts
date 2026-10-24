import {
  assertServerPermissionKeys,
  legacyServerPermissionKeys,
  serverPermissionDefinitions,
} from '@nickhosting/core';
import { gameManifestSchema } from '@nickhosting/game-sdk';
import { describe, expect, it } from 'vitest';
import { minecraftManifest } from './manifest.js';
import {
  minecraftContentPermissionKeys,
  minecraftPlayerPermission,
  minecraftServerPermissions,
} from './server-permissions.js';

describe('compiled Minecraft permission boundaries', () => {
  it('requires both import and delete to replace a world, and separately authorizes the backup effect', () => {
    const keys = minecraftContentPermissionKeys({
      kind: 'world-import',
      replace: { backupBefore: true },
    });
    expect(keys).toEqual([
      'game.minecraft.worlds.import',
      'game.minecraft.worlds.delete',
      'backups.create',
    ]);
    expect(minecraftContentPermissionKeys({ kind: 'world-import' })).toEqual([
      'game.minecraft.worlds.import',
    ]);
  });
  it('keeps restore verification metadata writes out of read-only Properties access', () => {
    const readers = legacyServerPermissionKeys('viewer', minecraftServerPermissions);
    expect(readers).toContain('game.minecraft.properties.read');
    for (const key of minecraftContentPermissionKeys({ kind: 'verify' }))
      expect(readers).not.toContain(key);
  });
  it('keeps operator, whitelist and moderation actions independent', () => {
    expect(minecraftPlayerPermission('deop')).toBe('game.minecraft.players.op');
    expect(minecraftPlayerPermission('whitelist-remove')).toBe('game.minecraft.players.whitelist');
    expect(minecraftPlayerPermission('pardon')).toBe('game.minecraft.players.ban');
    expect(minecraftPlayerPermission('kick')).toBe('game.minecraft.players.kick');
    expect(() => minecraftPlayerPermission('delete')).toThrow('validation_failed');
    expect(() => minecraftPlayerPermission('whitelist-unknown')).toThrow('validation_failed');
  });
  it('keeps runtime-dependent legacy install/remove commands behind their original manager boundary', () => {
    expect(minecraftContentPermissionKeys({ kind: 'install' })).toEqual(['server:manage']);
    expect(minecraftContentPermissionKeys({ kind: 'remove' })).toEqual(['server:manage']);
  });
  it.each(['modpack', 'modpack-upload'])(
    'keeps legacy %s replacement wipes behind manager authority and independently checks backups',
    (kind) => {
      expect(minecraftContentPermissionKeys({ kind })).toEqual(['game.minecraft.modpacks.write']);
      expect(
        minecraftContentPermissionKeys({
          kind,
          replace: { expectedDeletePaths: ['config', 'plugins', 'world'], backupBefore: true },
        }),
      ).toEqual(['game.minecraft.modpacks.write', 'server:manage', 'backups.create']);
      expect(
        minecraftContentPermissionKeys({ kind, replace: { expectedDeletePaths: [] } }),
      ).toEqual(['game.minecraft.modpacks.write', 'server:manage']);
    },
  );
  it('permits a domain read/delete grant without arbitrary Files or domain Write authority', () => {
    const grant = ['game.minecraft.mods.read', 'game.minecraft.mods.delete'];
    expect(() =>
      assertServerPermissionKeys(grant, [
        ...serverPermissionDefinitions,
        ...minecraftServerPermissions,
      ]),
    ).not.toThrow();
    expect(() =>
      assertServerPermissionKeys(['game.minecraft.mods.delete'], minecraftServerPermissions),
    ).toThrow('validation_failed');
  });
  it('declares each rich player action independently and requires its read grant', () => {
    const viewers = legacyServerPermissionKeys('viewer', minecraftServerPermissions);
    for (const action of ['heal', 'feed', 'starve', 'kill', 'gamemode', 'teleport', 'reset']) {
      const key = `game.minecraft.players.${action}`;
      expect(minecraftServerPermissions.find((entry) => entry.key === key)).toMatchObject({
        kind: 'additional',
        legacy: 'manage',
      });
      expect(viewers).not.toContain(key);
      expect(() => assertServerPermissionKeys([key], minecraftServerPermissions)).toThrow(
        'validation_failed',
      );
      expect(() =>
        assertServerPermissionKeys(
          ['game.minecraft.players.read', key],
          minecraftServerPermissions,
        ),
      ).not.toThrow();
    }
  });
  it('rejects foreign permission and translation namespaces, missing reads and duplicate declarations', () => {
    const read = minecraftServerPermissions.find(
      (definition) => definition.key === 'game.minecraft.mods.read',
    );
    if (!read) throw new Error('missing declared read');
    for (const definitions of [
      [{ ...read, key: 'game.other.mods.read', resource: 'game.other.mods' }],
      [{ ...read, labelKey: 'games.other.permissions.read' }],
      [{ ...read, resourceLabelKey: 'games.other.permissions.mods' }],
      [{ ...read, key: 'game.minecraft.mods.delete', kind: 'additional' }],
      [read, read],
    ])
      expect(
        gameManifestSchema.safeParse({ ...minecraftManifest, serverPermissions: definitions })
          .success,
      ).toBe(false);
  });
});
