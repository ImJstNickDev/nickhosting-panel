import type { GameUiClient } from '@nickhosting/game-sdk/ui';
import { describe, expect, it, vi } from 'vitest';
import { createMinecraftUiController } from './controller.js';

const serverId = '20000000-0000-4000-8000-000000000001';
const sourceId = '40000000-0000-4000-8000-000000000001';
const input = { serverId, projectId: '42', versionId: '72', idempotencyKey: 'world-request' };
const page = { items: [], offset: 20, limit: 20, total: 21 };

describe('Minecraft Worlds catalog browser contract', () => {
  it('keeps catalog requests server scoped, encoded and abortable without a version filter by default', async () => {
    const request = vi.fn<GameUiClient['request']>().mockResolvedValue(page);
    const controller = createMinecraftUiController({ request });
    const abort = new AbortController();
    expect(
      await controller.searchWorlds({ serverId, query: 'map & parkour', offset: 20 }, abort.signal),
    ).toEqual(page);
    const [path, options] = request.mock.calls[0] ?? ['', undefined];
    const url = new URL(path, 'https://panel.example.test');
    expect(url.pathname).toBe(`/v1/servers/${serverId}/minecraft/world-catalog/search`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      provider: 'curseforge',
      query: 'map & parkour',
      offset: '20',
    });
    expect(options?.signal).toBe(abort.signal);
    await controller.worldCatalogFiles(serverId, '42', 20, abort.signal);
    expect(request.mock.calls[1]?.[0]).toBe(
      `/v1/servers/${serverId}/minecraft/world-catalog/curseforge/42/files?offset=20`,
    );
  });

  it('submits provider identities, never a browser-supplied download URL, and requires a ready source', async () => {
    const request = vi
      .fn<GameUiClient['request']>()
      .mockResolvedValue({ id: sourceId, state: 'ready' });
    const controller = createMinecraftUiController({ request });
    expect(await controller.acquireWorld(input)).toEqual({ id: sourceId, state: 'ready' });
    expect(request.mock.calls[0]?.[0]).toBe('/v1/minecraft/sources/world-catalog');
    expect(request.mock.calls[0]?.[1]?.body).toEqual({ ...input, provider: 'curseforge' });
    request.mockResolvedValue({ id: sourceId, state: 'downloading' });
    await expect(controller.acquireWorld(input)).rejects.toThrow();
    await expect(
      controller.acquireWorld({
        ...input,
        url: 'https://outside.example/file.zip',
      } as typeof input),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid identities and pagination before issuing requests', async () => {
    const request = vi.fn<GameUiClient['request']>();
    const controller = createMinecraftUiController({ request });
    await expect(controller.worldCatalogFiles(serverId, '../owner/settings')).rejects.toThrow();
    await expect(controller.worldCatalogFiles(serverId, '42', 10000)).rejects.toThrow();
    await expect(controller.searchWorlds({ serverId: '../owner', query: '' })).rejects.toThrow();
    await expect(controller.acquireWorld({ ...input, versionId: 'file.zip' })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
