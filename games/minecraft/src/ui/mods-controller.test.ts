import type { GameUiClient } from '@nickhosting/game-sdk/ui';
import { describe, expect, it, vi } from 'vitest';
import { createMinecraftModsController, minecraftModsSnapshotSchema } from './mods-controller.js';

const serverId = '10000000-0000-4000-8000-000000000001';
describe('Minecraft Mods browser contracts', () => {
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
});
