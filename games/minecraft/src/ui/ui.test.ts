import type { GameUiClient } from '@nickhosting/game-sdk/ui';
import { describe, expect, it, vi } from 'vitest';
import {
  createMinecraftUiController,
  minecraftPropertyValues,
  minecraftUiCatalogs,
  minecraftUiModule,
} from './index.js';

const choiceId = '10000000-0000-4000-8000-000000000001';
const serverId = '20000000-0000-4000-8000-000000000001';
const jobId = '30000000-0000-4000-8000-000000000001';
const sourceId = '40000000-0000-4000-8000-000000000001';
const profile = {
  choiceId,
  version: '26.1',
  runtime: 'vanilla',
  installed: true,
  configuration: {
    eula: true,
    properties: { pvp: 'false', 'view-distance': '10' },
    operators: ['Notch'],
    whitelist: [],
  },
  content: [],
  effectiveProperties: { pvp: 'true', 'view-distance': '12' },
  supportedProperties: ['pvp', 'view-distance'],
};
function clientFixture() {
  const request = vi.fn<GameUiClient['request']>(async (path) => {
    if (path === '/v1/minecraft/choices')
      return [{ id: choiceId, version: '26.1', runtime: 'vanilla', protocol: 775 }];
    if (path === `/v1/servers/${serverId}/minecraft`) return profile;
    return { serverId, jobId };
  });
  return { request };
}
describe('Minecraft browser module and exact API contracts', () => {
  it('contains complete EN/IT catalogs and browser-safe module metadata', () => {
    expect(minecraftUiModule.descriptor.gameId).toBe('minecraft-java');
    expect(Object.keys(minecraftUiCatalogs.en).sort()).toEqual(
      Object.keys(minecraftUiCatalogs.it).sort(),
    );
    expect(minecraftUiModule.descriptor.creation.fields.some((f) => f.id === 'protocol')).toBe(
      false,
    );
  });
  it('uses only eligible opaque public choices and strips technical metadata', async () => {
    const client = clientFixture(),
      controller = createMinecraftUiController(client);
    expect(await controller.choices()).toEqual([
      { id: choiceId, version: '26.1', runtime: 'vanilla' },
    ]);
    expect(await controller.choiceOptions()).toEqual([
      { value: choiceId, label: '26.1 · vanilla', disabled: false, releaseType: 'release' },
    ]);
  });
  it('preserves exact creation API, explicit EULA, no Owner mapping ID and accepted job semantics', async () => {
    const client = clientFixture(),
      controller = createMinecraftUiController(client);
    const input = {
      idempotencyKey: 'create-one',
      name: 'My server',
      autoStart: false,
      limits: { memory: 1024, cpu: 100, disk: 2048 },
      minecraft: { choiceId, configuration: { eula: true, operators: ['Notch'] } },
    };
    expect(await controller.create(input)).toEqual({ serverId, jobId });
    expect(client.request).toHaveBeenLastCalledWith(
      '/v1/minecraft/servers',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          autoStart: false,
          minecraft: expect.objectContaining({
            configuration: expect.objectContaining({ eula: true }),
          }),
        }),
      }),
    );
    await expect(controller.create({ ...input, mappingId: choiceId })).rejects.toThrow();
    await expect(
      controller.create({ ...input, minecraft: { choiceId, configuration: { eula: false } } }),
    ).rejects.toThrow();
    client.request.mockResolvedValueOnce([]);
    await expect(controller.create(input)).rejects.toThrow('integration_unavailable');
  });
  it('never offers or submits a Vanilla mod/plugin install', async () => {
    const client = clientFixture(),
      controller = createMinecraftUiController(client);
    await expect(
      controller.operate(serverId, 'install-one', {
        kind: 'install',
        provider: 'modrinth',
        projectId: 'mod',
        versionId: 'version',
      }),
    ).rejects.toThrow('integration_unavailable');
    expect(client.request.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
    await expect(
      controller.searchContent({ choiceId, provider: 'modrinth', query: 'mod', type: 'mod' }),
    ).rejects.toThrow('integration_unavailable');
    await expect(
      controller.searchContent({ choiceId, provider: 'modrinth', query: 'plugin', type: 'plugin' }),
    ).rejects.toThrow('integration_unavailable');
  });
  it('uses real property support and correctly renders false/numeric property strings', async () => {
    const client = clientFixture(),
      controller = createMinecraftUiController(client);
    expect(minecraftPropertyValues(profile.configuration.properties)).toEqual({
      pvp: false,
      'view-distance': 10,
    });
    expect(
      await minecraftUiModule.handlers.properties?.(client, { serverId, values: {} }),
    ).toMatchObject({ values: { pvp: true, 'view-distance': 12 } });
    expect(await controller.updateProperties(serverId, 'properties-one', { pvp: true })).toEqual({
      serverId,
      jobId,
    });
    await expect(
      controller.updateProperties(serverId, 'properties-two', { 'online-mode': false }),
    ).rejects.toThrow('integration_unavailable');
    client.request.mockResolvedValueOnce({ ...profile, supportedProperties: undefined });
    await expect(
      controller.updateProperties(serverId, 'properties-three', { pvp: true }),
    ).rejects.toThrow('integration_unavailable');
  });
  it('requires exact destructive consent and preserves original deletion preview', async () => {
    const client = clientFixture(),
      controller = createMinecraftUiController(client);
    await expect(
      controller.operate(serverId, 'delete-one', {
        kind: 'world-remove',
        world: 'world',
        backupBefore: true,
      }),
    ).rejects.toThrow();
    await expect(
      controller.operate(serverId, 'delete-two', {
        kind: 'world-remove',
        world: '../world',
        confirm: true,
        backupBefore: true,
      }),
    ).rejects.toThrow();
    const replacement = {
      kind: 'modpack-upload',
      archiveRef: sourceId,
      replace: { wipeConsent: true, expectedDeletePaths: ['world', 'mods'], backupBefore: true },
    };
    await controller.operate(serverId, 'replace-one', replacement);
    expect(client.request).toHaveBeenLastCalledWith(
      `/v1/servers/${serverId}/minecraft/operations`,
      expect.objectContaining({
        body: { idempotencyKey: 'replace-one', action: 'minecraft-content', command: replacement },
      }),
    );
    expect(client.request.mock.calls.some(([path]) => path.endsWith('wipe-preview'))).toBe(false);
  });
  it('derives the pack runtime from validated wizard response and rejects inconsistent choices', async () => {
    const client = clientFixture(),
      controller = createMinecraftUiController(client);
    client.request.mockResolvedValueOnce({
      choices: [
        {
          id: choiceId,
          release: '26.1',
          runtime: 'vanilla',
          nameKey: 'games.minecraft-java.runtimes.vanilla',
        },
      ],
      derived: { choiceId, release: '26.1', runtime: 'vanilla' },
    });
    expect((await controller.inspectModpack(sourceId)).derived?.choiceId).toBe(choiceId);
    client.request.mockResolvedValueOnce({
      choices: [],
      derived: { choiceId, release: '26.1', runtime: 'vanilla' },
    });
    await expect(controller.inspectModpack(sourceId)).rejects.toThrow('integration_unavailable');
  });
  it('uploads the original Blob without buffering and re-reads source state before proceeding', async () => {
    const client = clientFixture();
    client.request.mockResolvedValue({ id: sourceId, state: 'ready' });
    const upload = vi.fn<NonNullable<GameUiClient['upload']>>(async () => ({ id: sourceId }));
    const file = new Blob(['world bytes']);
    const controller = createMinecraftUiController({ ...client, upload });
    await controller.uploadSource({
      kind: 'world',
      serverId,
      idempotencyKey: 'source-one',
      file,
      sha256: 'a'.repeat(64),
    });
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      '/v1/minecraft/sources',
      expect.objectContaining({
        body: {
          kind: 'world',
          serverId,
          idempotencyKey: 'source-one',
          bytes: 11,
          sha256: 'a'.repeat(64),
        },
      }),
    );
    expect(upload).toHaveBeenCalledWith(
      `/v1/minecraft/sources/${sourceId}/upload`,
      file,
      expect.objectContaining({ bytes: 11 }),
    );
    expect(client.request).toHaveBeenLastCalledWith(
      `/v1/minecraft/sources/${sourceId}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });
  it('carries cancellation and rejects path-injection IDs before touching the API', async () => {
    const client = clientFixture(),
      controller = createMinecraftUiController(client),
      abort = new AbortController();
    await controller.profile(serverId, abort.signal);
    expect(client.request).toHaveBeenCalledWith(
      `/v1/servers/${serverId}/minecraft`,
      expect.objectContaining({ signal: abort.signal }),
    );
    client.request.mockClear();
    await expect(controller.profile('../owner/settings')).rejects.toThrow();
    expect(client.request).not.toHaveBeenCalled();
  });
});
