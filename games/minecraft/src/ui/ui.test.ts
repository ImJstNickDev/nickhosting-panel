import { availableGameUiSections, type GameUiClient } from '@nickhosting/game-sdk/ui';
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
      return [
        {
          id: choiceId,
          version: '26.1',
          runtime: 'vanilla',
          protocol: 775,
          capabilities: { playerManagement: true, gateway: true, sleepWake: true },
        },
      ];
    if (path === `/v1/servers/${serverId}/minecraft`) return profile;
    return { serverId, jobId };
  });
  return { request };
}
describe('Minecraft browser module and exact API contracts', () => {
  it('contains complete EN/IT catalogs and browser-safe module metadata', () => {
    expect(minecraftUiModule.descriptor.gameId).toBe('minecraft');
    expect(Object.keys(minecraftUiCatalogs.en).sort()).toEqual(
      Object.keys(minecraftUiCatalogs.it).sort(),
    );
    expect(minecraftUiModule.descriptor.creation.fields.some((f) => f.id === 'protocol')).toBe(
      false,
    );
  });
  it('splits content navigation by declared runtime without changing runtime eligibility', () => {
    const sections = (runtimeId: string) =>
      availableGameUiSections(minecraftUiModule, {
        runtimeId,
        permissions: ['server:read'],
        capabilities: { files: true, players: true, worlds: true, mods: true },
      }).map((section) => section.id);
    expect(sections('vanilla')).toEqual([
      'properties',
      'players',
      'worlds',
      'datapacks',
      'modpacks',
    ]);
    for (const runtime of ['fabric', 'forge']) {
      expect(sections(runtime)).toContain('mods');
      expect(sections(runtime)).not.toContain('plugins');
    }
    for (const runtime of ['paper', 'folia']) {
      expect(sections(runtime)).toContain('plugins');
      expect(sections(runtime)).not.toContain('mods');
    }
    const packs = minecraftUiModule.descriptor.sections.find(
      (section) => section.id === 'modpacks',
    );
    expect(packs?.aliases).toEqual(['content']);
    expect(packs?.forms.map((form) => form.id)).toEqual(['verify', 'replace-pack']);
    expect(
      minecraftUiModule.descriptor.sections.find((section) => section.id === 'datapacks')?.forms,
    ).toEqual([]);
  });
  it('projects the existing tracked inventory without scanning files or duplicating requests', async () => {
    const client = clientFixture();
    const paths = [
      'mods/example.jar',
      'plugins/example.jar',
      'world/datapacks/example.zip',
      'config/example.properties',
      'mods-other/example.jar',
    ];
    client.request.mockResolvedValue({
      ...profile,
      content: paths.map((path) => ({ path, artifact: {}, installed_at: '2026-10-18T00:00:00Z' })),
    });
    for (const [sectionId, expected] of [
      ['mods', [paths[0]]],
      ['plugins', [paths[1]]],
      ['datapacks', [paths[2]]],
      ['modpacks', paths],
    ] as const) {
      client.request.mockClear();
      const result = (await minecraftUiModule.handlers.content?.(client, {
        serverId,
        values: { sectionId },
      })) as { rows: { path: string }[] };
      expect(result.rows.map((row) => row.path)).toEqual(expected);
      expect(client.request).toHaveBeenCalledTimes(1);
      expect(client.request).toHaveBeenCalledWith(
        `/v1/servers/${serverId}/minecraft`,
        expect.any(Object),
      );
    }
  });
  it('uses only eligible opaque public choices and strips technical metadata', async () => {
    const client = clientFixture(),
      controller = createMinecraftUiController(client);
    expect(await controller.choices()).toEqual([
      {
        id: choiceId,
        version: '26.1',
        runtime: 'vanilla',
        capabilities: { playerManagement: true, gateway: true, sleepWake: true },
      },
    ]);
    expect(await controller.choiceOptions()).toEqual([
      {
        value: choiceId,
        label: '26.1',
        disabled: false,
        releaseType: 'release',
        capabilities: { playerManagement: true, gateway: true, sleepWake: true },
      },
    ]);
  });
  it('declares runtime before name, offers only eligible runtimes, and filters version-only labels', async () => {
    const client = clientFixture();
    const paperId = '10000000-0000-4000-8000-000000000002';
    const release = { id: choiceId, version: '26.1', runtime: 'vanilla' };
    client.request.mockResolvedValue([release, { ...release, id: paperId, runtime: 'paper' }]);
    expect(minecraftUiModule.descriptor.creation.pages.map((page) => page.id)).toEqual([
      'runtime',
      'version',
      'address',
      'operators',
      'whitelist',
    ]);
    expect(minecraftUiModule.descriptor.creation.pages[2]).toMatchObject({
      kind: 'address',
      field: 'connection',
    });
    expect(minecraftUiModule.descriptor.creation.pages[0]).toMatchObject({
      field: 'runtime',
      kind: 'choice-list',
      position: 'before-name',
      resetFields: ['choiceId', 'operators', 'whitelist', 'whitelistEnabled', 'eula'],
    });
    expect(await minecraftUiModule.handlers.runtimes?.(client, { values: {} })).toEqual([
      { value: 'vanilla', labelKey: 'games.minecraft.runtimes.vanilla', disabled: false },
      { value: 'paper', labelKey: 'games.minecraft.runtimes.paper', disabled: false },
    ]);
    expect(
      await minecraftUiModule.handlers.choices?.(client, { values: { runtime: 'vanilla' } }),
    ).toEqual([{ value: choiceId, label: '26.1', disabled: false, releaseType: 'release' }]);
    expect(
      await minecraftUiModule.handlers.choices?.(client, { values: { runtime: 'forge' } }),
    ).toEqual([]);
    expect(await minecraftUiModule.handlers.choices?.(client, { values: {} })).toEqual([]);
    await expect(
      minecraftUiModule.handlers['prepare-create']?.(client, {
        values: { runtime: 'paper', choiceId },
      }),
    ).rejects.toThrow('integration_unavailable');
    client.request.mockResolvedValue([release]);
    expect(await minecraftUiModule.handlers.runtimes?.(client, { values: {} })).toEqual([
      { value: 'vanilla', labelKey: 'games.minecraft.runtimes.vanilla', disabled: false },
    ]);
  });
  it('retains legacy direct capability flags and clears unsupported player fields in preparation', async () => {
    const client = clientFixture();
    client.request.mockResolvedValue([
      {
        id: choiceId,
        version: '1.6.4',
        runtime: 'vanilla',
        capabilities: { playerManagement: false, gateway: false, sleepWake: false },
      },
    ]);
    const controller = createMinecraftUiController(client);
    expect(await controller.choiceOptions()).toEqual([
      {
        value: choiceId,
        label: '1.6.4',
        disabled: false,
        releaseType: 'release',
        capabilities: { playerManagement: false, gateway: false, sleepWake: false },
      },
    ]);
    expect(
      await minecraftUiModule.handlers['prepare-create']?.(client, {
        values: { choiceId, operators: ['Notch'], whitelist: ['Notch'], whitelistEnabled: true },
      }),
    ).toMatchObject({
      values: { playerManagement: false, operators: [], whitelist: [], whitelistEnabled: false },
    });
    expect(
      minecraftUiModule.descriptor.creation.pages
        ?.filter((page) => page.id === 'operators' || page.id === 'whitelist')
        .every((page) => page.requiredCapability === 'playerManagement'),
    ).toBe(true);
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
  it('forwards common domain choice through the integration handler without losing automatic defaults', async () => {
    const client = clientFixture();
    for (const connection of [
      {
        domainId: 'main',
        subdomain: 'blue-panda',
        reservationId: '20000000-0000-4000-8000-000000000002',
      },
      {},
    ]) {
      await minecraftUiModule.handlers.create?.(client, {
        idempotencyKey: 'domain-create',
        values: {
          name: 'World',
          choiceId,
          runtime: 'vanilla',
          eula: true,
          limits: { memory: 1024, cpu: 100 },
          connection,
        },
      });
      expect(client.request).toHaveBeenLastCalledWith(
        '/v1/minecraft/servers',
        expect.objectContaining({ body: expect.objectContaining({ connection }) }),
      );
    }
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
    client.request.mockClear();
    expect(await controller.updateProperties(serverId, 'properties-one', { pvp: true })).toEqual({
      serverId,
      jobId,
    });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith(
      `/v1/servers/${serverId}/minecraft/operations`,
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ command: { kind: 'properties', changes: { pvp: true } } }),
      }),
    );
    // Current support/permissions are checked by the API, never inferred from
    // another frontend profile read immediately before the same POST.
    client.request.mockRejectedValueOnce(new Error('property_unavailable'));
    await expect(
      controller.updateProperties(serverId, 'properties-two', { 'online-mode': false }),
    ).rejects.toThrow('property_unavailable');
  });
  it('normalizes historical property enums without treating ordinary numeric properties as enums', () => {
    expect(
      minecraftPropertyValues({ difficulty: '1', gamemode: '0', 'view-distance': '3' }),
    ).toEqual({
      difficulty: 'easy',
      gamemode: 'survival',
      'view-distance': 3,
    });
    expect(minecraftPropertyValues({ difficulty: 'hard', gamemode: 'creative' })).toEqual({
      difficulty: 'hard',
      gamemode: 'creative',
    });
    expect(minecraftPropertyValues({ difficulty: '9', gamemode: 'unknown' })).toEqual({
      difficulty: '9',
      gamemode: 'unknown',
    });
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
          nameKey: 'games.minecraft.runtimes.vanilla',
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
  it('uses the acknowledged upload response without buffering the Blob or requesting source state again', async () => {
    const client = clientFixture();
    client.request.mockResolvedValue({ id: sourceId, state: 'ready' });
    const upload = vi.fn<NonNullable<GameUiClient['upload']>>(async () => ({
      id: sourceId,
      state: 'ready',
    }));
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
    expect(client.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    { id: sourceId, state: 'receiving' },
    { id: serverId, state: 'ready' },
  ])('rejects an unconfirmed or mismatched upload response: %s', async (result) => {
    const client = clientFixture();
    client.request.mockResolvedValue({ id: sourceId, state: 'reserved' });
    const controller = createMinecraftUiController({ ...client, upload: async () => result });
    await expect(
      controller.uploadSource({
        kind: 'world',
        serverId,
        idempotencyKey: 'source-one',
        file: new Blob(['bytes']),
        sha256: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'conflict', reason: 'source_not_ready' });
    expect(client.request).toHaveBeenCalledTimes(1);
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

describe('shared creation catalog chronology', () => {
  it('mixes release kinds by official dates and leaves unknown dates last', () => {
    const catalog = minecraftUiModule.creationCatalog;
    const data = [
      {
        id: '10000000-0000-4000-8000-000000000001',
        version: '26.1',
        runtime: 'vanilla',
        releaseType: 'release',
        releaseTime: '2026-03-01T00:00:00Z',
      },
      {
        id: '10000000-0000-4000-8000-000000000002',
        version: '26.2-snapshot-1',
        runtime: 'vanilla',
        releaseType: 'snapshot',
        releaseTime: '2026-04-01T00:00:00Z',
      },
      {
        id: '10000000-0000-4000-8000-000000000003',
        version: '99.0',
        runtime: 'vanilla',
        releaseTime: null,
      },
    ];
    expect(
      catalog?.options(data, 'choices', { runtime: 'vanilla' }).map((entry) => entry.label),
    ).toEqual(['26.2-snapshot-1', '26.1', '99.0']);
    expect(catalog?.options(data, 'choices', { runtime: 'paper' })).toEqual([]);
    expect(catalog?.applies?.('choices', { sourceMode: 'modpack' })).toBe(false);
  });
});

describe('Minecraft Players UI contracts', () => {
  const snapshot = {
    supported: true,
    installed: true,
    operators: [
      {
        name: 'Notch',
        uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
        level: 4,
        bypassesPlayerLimit: false,
      },
    ],
    whitelist: [],
    banned: [],
    whitelistEnabled: false,
    enforceWhitelist: false,
  };
  it('uses a dedicated authoritative Players loader rather than the content profile', async () => {
    const client = clientFixture();
    client.request.mockResolvedValue(snapshot);
    expect(
      minecraftUiModule.descriptor.sections.find((section) => section.id === 'players'),
    ).toMatchObject({
      renderer: 'minecraft-players',
      forms: [],
      columns: [],
    });
    expect(await minecraftUiModule.handlers.players?.(client, { serverId, values: {} })).toEqual({
      values: {},
      rows: [],
      metadata: { players: snapshot, installed: true },
    });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls[0]?.[0]).toBe(`/v1/servers/${serverId}/minecraft/players`);
  });
  it('preserves unavailable roster status and only reports dispatched command outcomes', async () => {
    const client = clientFixture();
    const controller = createMinecraftUiController(client);
    client.request.mockResolvedValueOnce({ state: 'unavailable', players: [], observedAt: null });
    expect(await controller.onlinePlayers(serverId)).toEqual({
      state: 'unavailable',
      players: [],
      observedAt: null,
    });
    client.request.mockResolvedValueOnce({ outcome: 'dispatched' });
    expect(
      await controller.playerAction(serverId, { action: 'kick', name: 'Notch', reason: 'Test' }),
    ).toEqual({ outcome: 'dispatched' });
    expect(client.request.mock.calls.at(-1)).toMatchObject([
      `/v1/servers/${serverId}/minecraft/players/actions`,
      { method: 'POST', body: { action: 'kick', name: 'Notch', reason: 'Test' } },
    ]);
  });
  it('rejects console injection, missing targets and unsupported temporary bans before dispatch', async () => {
    const client = clientFixture();
    const controller = createMinecraftUiController(client);
    for (const action of [
      { action: 'kick', name: 'Notch', reason: 'bye\nop Attacker' },
      { action: 'op' },
      { action: 'tempban', name: 'Notch' },
      { action: 'whitelist-on', name: 'Notch' },
    ]) {
      await expect(
        controller.playerAction(serverId, action as Parameters<typeof controller.playerAction>[1]),
      ).rejects.toThrow();
    }
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe('Minecraft Worlds UI contracts', () => {
  const snapshot = {
    installed: true,
    supported: true,
    selectedWorld: 'adventure',
    release: '26.1',
    compatibility: 'available',
    worlds: [{ name: 'adventure', status: 'verified' }],
  };
  it('loads one shared inventory with the selected world and no per-form scans', async () => {
    const client = clientFixture();
    client.request.mockResolvedValue(snapshot);
    expect(
      minecraftUiModule.descriptor.sections.find((section) => section.id === 'worlds'),
    ).toMatchObject({
      renderer: 'minecraft-worlds',
      requiredPermissions: ['server:read'],
      columns: [],
      forms: [],
    });
    expect(await minecraftUiModule.handlers.worlds?.(client, { serverId, values: {} })).toEqual({
      values: {},
      rows: [],
      metadata: { worlds: snapshot, installed: true },
    });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls[0]?.[0]).toBe(`/v1/servers/${serverId}/minecraft/worlds`);
  });
  it('keeps unknown compatibility distinct from empty inventory', async () => {
    const client = clientFixture();
    client.request.mockResolvedValue({
      ...snapshot,
      compatibility: 'unavailable',
      worlds: [{ name: 'adventure', status: 'unavailable' }],
    });
    expect(await createMinecraftUiController(client).worlds(serverId)).toMatchObject({
      compatibility: 'unavailable',
      selectedWorld: 'adventure',
      worlds: [{ name: 'adventure', status: 'unavailable' }],
    });
  });
  it('retains observed and inferred metadata without inventing a version for legacy worlds', async () => {
    const client = clientFixture();
    const common = { sha256: 'a'.repeat(64), uncompressedBytes: 128 };
    const worlds = [
      { name: 'legacy', status: 'unknown', validation: { ...common, storageVersion: 19133 } },
      {
        name: 'modern',
        status: 'incompatible',
        validation: {
          ...common,
          storageVersion: 19133,
          dataVersion: 3700,
          versionName: '1.20.4',
          detectedRelease: '1.20.4',
          versionSeries: 'main',
          snapshot: false,
          versionHistory: [3465, 3700],
        },
      },
      { name: 'broken', status: 'invalid' },
      { name: 'unreadable', status: 'unavailable' },
    ];
    client.request.mockResolvedValue({ ...snapshot, worlds });
    expect((await createMinecraftUiController(client).worlds(serverId)).worlds).toEqual(worlds);
  });
  it('rejects unsafe world paths and implicit replacement before requesting a job', async () => {
    const client = clientFixture();
    const controller = createMinecraftUiController(client);
    for (const command of [
      { kind: 'world-select', world: '../world' },
      { kind: 'world-remove', world: 'world', confirm: false, backupBefore: false },
      {
        kind: 'world-import',
        targetWorld: 'world',
        archiveRef: sourceId,
        replace: { expectedDeletePaths: ['world'], backupBefore: true },
      },
    ])
      await expect(controller.operate(serverId, 'world-test', command)).rejects.toThrow();
    expect(client.request).not.toHaveBeenCalled();
  });
});
