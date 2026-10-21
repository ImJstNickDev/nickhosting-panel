import type { GameUiClient } from '@nickhosting/game-sdk/ui';
import { describe, expect, it, vi } from 'vitest';
import { createMinecraftModsController, minecraftModsSnapshotSchema } from './mods-controller.js';

const serverId = '10000000-0000-4000-8000-000000000001';
describe('Minecraft Mods browser contracts', () => {
  it('toggles an installed mod immediately through the scoped endpoint and validates confirmation', async () => {
    const request = vi.fn<GameUiClient['request']>().mockResolvedValue({
      state: 'published',
      path: 'mods/example.jar.disabled',
      restartRequired: true,
    });
    const controller = createMinecraftModsController({ request });
    const body = {
      path: 'mods/example.jar',
      action: 'disable' as const,
      idempotencyKey: 'toggle-one',
    };
    expect(await controller.toggle(serverId, body)).toEqual({
      state: 'published',
      path: 'mods/example.jar.disabled',
      restartRequired: true,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `/v1/servers/${serverId}/minecraft/mods/toggle`,
      {
        method: 'POST',
        body,
      },
    );
    request.mockClear();
    for (const path of ['../example.jar', 'mods/example.jar.disabled', 'mods/sub/example.jar'])
      await expect(controller.toggle(serverId, { ...body, path })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue({
      state: 'uncertain',
      path: 'mods/example.jar',
      restartRequired: false,
    });
    expect(
      (
        await controller.toggle(serverId, {
          path: 'mods/example.jar.disabled',
          action: 'enable',
          idempotencyKey: 'toggle-two',
        })
      ).state,
    ).toBe('uncertain');
    request.mockResolvedValue({ state: 'ready', path: 'mods/example.jar', restartRequired: false });
    await expect(controller.toggle(serverId, body)).rejects.toThrow();
  });
  it('validates durable selections and uses only the protected same-origin transport', async () => {
    const request = vi.fn<GameUiClient['request']>().mockResolvedValue({ revision: 4 });
    const controller = createMinecraftModsController({ request });
    const body = {
      roots: [
        {
          provider: 'modrinth' as const,
          projectId: 'example',
          versionId: 'stable',
          optionalProjectIds: [],
          forceIncompatible: false,
        },
      ],
      preferBeta: false,
      idempotencyKey: 'same-intent',
    };
    expect(await controller.select(serverId, body)).toEqual({ revision: 4 });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `/v1/servers/${serverId}/minecraft/mods/selection`,
      { method: 'PUT', body },
    );
    request.mockClear();
    const root = body.roots[0];
    if (!root) throw new Error('Missing fixture root');
    await expect(
      controller.select(serverId, {
        ...body,
        roots: [{ ...root, projectId: '../foreign' }],
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('does not expose downloaded artifact URLs or accept unsafe catalog navigation', async () => {
    const request = vi.fn<GameUiClient['request']>();
    const controller = createMinecraftModsController({ request });
    await expect(controller.details(serverId, 'modrinth', '../outside')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue({
      items: [],
      offset: 0,
      limit: 20,
      total: 0,
      downloadUrl: 'https://private.test/token',
    });
    await expect(
      controller.versions(serverId, 'curseforge', '123', {
        offset: 0,
        includeIncompatible: true,
        preferBeta: true,
      }),
    ).rejects.toThrow();
  });
  it('recognizes durable preparation, unknown environments and restart state without claiming loaded mods', () => {
    const snapshot = minecraftModsSnapshotSchema.parse({
      supported: true,
      installed: true,
      running: true,
      version: '26.1',
      loader: 'fabric',
      revision: 3,
      preferBeta: false,
      roots: [],
      preparing: true,
      packs: [
        {
          id: 'local',
          name: 'local.jar',
          path: 'mods/local.jar',
          size: 12,
          state: 'enabled',
          metadata: null,
        },
      ],
      changes: [],
      blockers: [],
      optional: [],
      restart: { required: true },
    });
    expect(snapshot.packs[0]?.metadata).toBeNull();
    expect(snapshot.restart.required).toBe(true);
    expect(snapshot.preparing).toBe(true);
    expect(() => minecraftModsSnapshotSchema.parse({ ...snapshot, revision: -1 })).toThrow();
  });
  it('uses read-only versioned alternatives and update endpoints with bounded metadata', async () => {
    const request = vi.fn<GameUiClient['request']>();
    const controller = createMinecraftModsController({ request });
    request.mockResolvedValue({ checkedAt: '2026-10-20T12:00:00Z', items: [] });
    await controller.updates(serverId, true);
    expect(request).toHaveBeenLastCalledWith(
      `/v1/servers/${serverId}/minecraft/mods/updates?preferBeta=true`,
      { signal: undefined },
    );
    request.mockResolvedValue({
      revision: 4,
      provider: 'curseforge',
      projectId: '123',
      items: [],
      checked: 5,
      limited: true,
    });
    expect((await controller.alternatives(serverId, 'curseforge', '123', 4)).limited).toBe(true);
    expect(request).toHaveBeenLastCalledWith(
      `/v1/servers/${serverId}/minecraft/mods/alternatives/curseforge/123?revision=4`,
      { signal: undefined },
    );
    request.mockClear();
    await expect(
      controller.alternatives(serverId, 'curseforge', '../foreign', 4),
    ).rejects.toThrow();
    await expect(controller.alternatives(serverId, 'curseforge', '123', -1)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('isolates plugin transport and validates providers and directories before writes', async () => {
    const request = vi.fn<GameUiClient['request']>().mockResolvedValue({ revision: 1 });
    const plugins = createMinecraftModsController({ request }, 'plugins');
    const body = {
      roots: [
        {
          provider: 'hangar' as const,
          projectId: 'world-tools',
          versionId: '1.0+paper',
          optionalProjectIds: [],
          forceIncompatible: false,
        },
      ],
      preferBeta: false,
      idempotencyKey: 'plugin-selection',
    };
    await plugins.select(serverId, body);
    expect(request).toHaveBeenLastCalledWith(
      `/v1/servers/${serverId}/minecraft/plugins/selection`,
      { method: 'PUT', body },
    );
    request.mockClear();
    await expect(
      createMinecraftModsController({ request }).select(serverId, body),
    ).rejects.toThrow();
    await expect(
      plugins.toggle(serverId, {
        path: 'mods/file.jar',
        action: 'disable',
        idempotencyKey: 'wrong-directory',
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue({
      state: 'published',
      path: 'plugins/file.jar.disabled',
      restartRequired: true,
    });
    await plugins.toggle(serverId, {
      path: 'plugins/file.jar',
      action: 'disable',
      idempotencyKey: 'plugin-toggle',
    });
    expect(request).toHaveBeenLastCalledWith(`/v1/servers/${serverId}/minecraft/plugins/toggle`, {
      method: 'POST',
      body: { path: 'plugins/file.jar', action: 'disable', idempotencyKey: 'plugin-toggle' },
    });
  });
  it('accepts explicit future catalogs as unavailable without exposing them as selection providers', async () => {
    const request = vi.fn<GameUiClient['request']>().mockResolvedValue({
      providers: [
        { id: 'voxel', available: false, comingSoon: true },
        { id: 'builtbybit', available: false, comingSoon: true },
        { id: 'spiget', available: true },
      ],
    });
    const plugins = createMinecraftModsController({ request }, 'plugins');
    expect((await plugins.catalog(serverId)).providers).toHaveLength(3);
    request.mockClear();
    await expect(
      plugins.select(serverId, {
        roots: [
          {
            provider: 'voxel' as 'modrinth',
            projectId: 'test',
            forceIncompatible: false,
            optionalProjectIds: [],
          },
        ],
        preferBeta: false,
        idempotencyKey: 'invalid-future-provider',
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('accepts opaque plugin catalog version names in update receipts', async () => {
    const request = vi.fn<GameUiClient['request']>().mockResolvedValue({
      checkedAt: '2026-10-21T12:00:00Z',
      items: [
        {
          path: 'plugins/world-tools.jar',
          provider: 'hangar',
          projectId: 'world-tools',
          currentVersionId: '2.0+paper',
          status: 'current',
        },
      ],
    });
    const plugins = createMinecraftModsController({ request }, 'plugins');
    expect((await plugins.updates(serverId, false)).items[0]?.currentVersionId).toBe('2.0+paper');
  });
});
