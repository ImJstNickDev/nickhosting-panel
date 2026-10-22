import { describe, expect, it } from 'vitest';
import type { ServerInfo } from '../features/service-contracts.js';
import { serverNavigation } from './server-navigation.js';

const server = (permissionKeys: string[], runtimeId = 'vanilla') =>
  ({
    id: 'server-fixture',
    gameId: 'minecraft',
    runtimeId,
    permissions: { read: true, operate: false, manage: false },
    permissionKeys,
    capabilities: { console: true, files: true, backups: true, players: true, worlds: true },
  }) as unknown as ServerInfo;
const translate = (key: string) => key;

describe('contextual server navigation', () => {
  it('keeps a game section active on nested detail routes without matching sibling prefixes', () => {
    const value = server(['game.minecraft.players.read']);
    const detail = serverNavigation(
      value,
      '/servers/server-fixture/game/players/player-id',
      translate,
    );
    expect(detail.filter((item) => item.active).map((item) => item.to)).toEqual([
      '/servers/server-fixture/game/players',
    ]);
    expect(
      serverNavigation(value, '/servers/server-fixture/game/players-other', translate).some(
        (item) => item.active,
      ),
    ).toBe(false);
  });
  it('does not expose native destinations without their read permission', () => {
    const navigation = serverNavigation(
      server(['console.read', 'files.read']),
      '/servers/server-fixture/files',
      translate,
    );
    expect(navigation.filter((item) => !item.to.includes('/game/')).map((item) => item.to)).toEqual(
      ['/servers/server-fixture/console', '/servers/server-fixture/files'],
    );
    expect(navigation.find((item) => item.active)?.to).toBe('/servers/server-fixture/files');
  });
  it('keeps Status accessible without console permission, with one current destination', () => {
    const navigation = serverNavigation(
      server(['files.read']),
      '/servers/server-fixture/status',
      translate,
    );
    expect(navigation[0]).toMatchObject({ to: '/servers/server-fixture/status', active: true });
    expect(navigation.filter((item) => item.active)).toHaveLength(1);
  });
  it('keeps Files, Network and Subusers in their declared groups and uses nested Settings current state', () => {
    const navigation = serverNavigation(
      server(['files.read', 'network.read', 'settings.read', 'subusers.read']),
      '/servers/server-fixture/settings/messages',
      translate,
    );
    expect(navigation.find((item) => item.to.endsWith('/files'))?.group).toBe('serverNav.server');
    expect(navigation.find((item) => item.to.endsWith('/network'))?.group).toBe('serverNav.config');
    expect(navigation.find((item) => item.to.endsWith('/subusers'))?.group).toBe(
      'serverNav.config',
    );
    expect(navigation.find((item) => item.to.endsWith('/settings'))?.active).toBe(true);
    expect(navigation.some((item) => item.to.endsWith('/sftp'))).toBe(false);
  });
  it('honors runtime and granular game section permissions', () => {
    const keys = ['console.read', 'game.minecraft.mods.read', 'game.minecraft.plugins.read'];
    const vanilla = serverNavigation(server(keys), '', translate);
    const fabric = serverNavigation(server(keys, 'fabric'), '', translate);
    const paper = serverNavigation(server(keys, 'paper'), '', translate);
    expect(vanilla.some((item) => item.to.endsWith('/mods') || item.to.endsWith('/plugins'))).toBe(
      false,
    );
    expect(fabric.some((item) => item.to.endsWith('/mods'))).toBe(true);
    expect(fabric.some((item) => item.to.endsWith('/plugins'))).toBe(false);
    expect(paper.some((item) => item.to.endsWith('/plugins'))).toBe(true);
    expect(
      serverNavigation(server(['console.read'], 'fabric'), '', translate).some((item) =>
        item.to.endsWith('/mods'),
      ),
    ).toBe(false);
  });
});
