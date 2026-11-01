import { type AuthContext, DomainError } from '@nickhosting/core';
import { recordAudit } from '@nickhosting/database';
import type { FilemanReadService } from '@nickhosting/game-sdk';
import type { ConsoleRelayOptions } from '@nickhosting/pterodactyl-adapter';
import type { ManagementRuntime } from '@nickhosting/server-management';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { minecraftPlayerDataFixture } from '../../../games/minecraft/src/player-data-fixture.js';
import { minecraftPlayerDetailSchema } from '../../../games/minecraft/src/player-details-contracts.js';
import { discoverMinecraftPlayers } from '../../../packages/server-management/src/minecraft-player-details.js';
import type { Variables } from './app.js';
import {
  minecraftDetailCommandsSupported,
  registerMinecraftPlayerDetailRoutes,
} from './minecraft-player-details.js';

vi.mock('@nickhosting/database', async (original) => ({
  ...(await original<typeof import('@nickhosting/database')>()),
  recordAudit: vi.fn(async () => {}),
}));
vi.mock('@nickhosting/server-management', async (original) => ({
  ...(await original<typeof import('@nickhosting/server-management')>()),
  inspectMinecraftCombination: vi.fn(async () => ({
    combination: { release: '26.3' },
    capabilities: { playerManagement: true },
  })),
  getServerPermissionKeys: vi.fn(
    async (_db, context) => (context as { permissions: string[] }).permissions,
  ),
}));
const uuid = '11111111-1111-1111-1111-111111111111';
const other = '22222222-2222-2222-2222-222222222222';
const permission = (action: string) => `game.minecraft.players.${action}`;
beforeEach(() => vi.clearAllMocks());

function fixture(modern = true) {
  const prefix = modern ? 'world/players/data' : 'world/playerdata';
  const statsPrefix = modern ? 'world/players/stats' : 'world/stats';
  const directories = new Set(['world', prefix, statsPrefix, ...(modern ? ['world/players'] : [])]);
  const data = minecraftPlayerDataFixture(modern);
  const contents = new Map<string, Buffer>([
    ['server.properties', Buffer.from('level-name=world\nwhite-list=false')],
    ['usercache.json', Buffer.from(JSON.stringify([{ uuid, name: 'PlayerOne' }]))],
    [`${prefix}/${uuid}.dat`, data],
    [`${prefix}/${uuid}.dat_old`, data],
    [
      `${statsPrefix}/${uuid}.json`,
      Buffer.from('{"stats":{"minecraft:custom":{"minecraft:deaths":2}}}'),
    ],
    [`${prefix}/${other}.dat`, data],
  ]);
  const savedAt = '2026-10-22T08:00:00.000Z';
  const requested: string[] = [];
  const symlinks = new Set<string>();
  let runtimeState = 'running',
    revoked = false,
    presence = true;
  let beforeEffect: (() => void) | undefined;
  const permissions = [
    'read',
    'heal',
    'feed',
    'starve',
    'kill',
    'gamemode',
    'teleport',
    'reset',
  ].map(permission);
  const context = { permissions } as unknown as AuthContext;
  const check = (key: string) => {
    if (revoked || !permissions.includes(key)) throw new DomainError('forbidden');
  };
  const readService = (): FilemanReadService => ({
    async list(directory) {
      requested.push(directory);
      const prefix = directory ? `${directory}/` : '';
      const entries = [...directories, ...contents.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map((path) => ({
          name: path.slice(prefix.length),
          kind: symlinks.has(path)
            ? ('symlink' as const)
            : directories.has(path)
              ? ('directory' as const)
              : ('file' as const),
          size: contents.get(path)?.length ?? 0,
          modifiedAt: savedAt,
        }));
      return entries;
    },
    async read(request) {
      requested.push(request.path);
      const value = contents.get(request.path);
      if (value) return value;
      if (request.missing === 'allow') return undefined;
      throw new DomainError('not_found');
    },
    async readMany(requests) {
      return new Map(
        await Promise.all(
          requests.map(async (request) => [request.path, await this.read(request)] as const),
        ),
      );
    },
    async listMany(paths) {
      return Promise.all(
        paths.map(async (directory) => ({ directory, files: await this.list(directory) })),
      );
    },
    async prepare() {},
  });
  const db = {
    selectFrom: () => ({
      selectAll() {
        return this;
      },
      where() {
        return this;
      },
      async executeTakeFirst() {
        return { installed: true, combination_id: 'choice' };
      },
    }),
  };
  const server = {} as never;
  const adapter = {
    getResources: vi.fn(async () => ({ current_state: runtimeState })),
    sendCommand: vi.fn(async () => {}),
    renameFiles: vi.fn(async (_identifier, _root, moves: { from: string; to: string }[]) => {
      for (const move of moves) {
        const bytes = contents.get(move.from);
        if (!bytes) throw new Error('missing');
        contents.set(move.to, bytes);
        contents.delete(move.from);
      }
    }),
    relayConsole: vi.fn(async (_identifier, options: ConsoleRelayOptions) => ({
      async sendCommand() {
        beforeEffect?.();
        if (await options.authorize?.())
          options.onEvent({
            type: 'console',
            data: presence
              ? '[12:34:56] [Server thread/INFO]: There are 1 of a max of 20 players online: PlayerOne'
              : '[12:34:56] [Server thread/INFO]: There are 0 of a max of 20 players online: ',
          });
        else options.onEvent({ type: 'closed' });
      },
      close() {},
    })),
  };
  const runtime = {
    adapter: adapter as unknown as ManagementRuntime['adapter'],
    async fileReadScope(_context, _id, callback, _signal, key) {
      check(key ?? permission('read'));
      const result = await callback(readService(), 'identifier', db as never, context, server);
      check(key ?? permission('read'));
      return result;
    },
    fileReadPhase: () => readService(),
    async fileMutationAccess(_context, _id, callback, _timing, key) {
      check(key ?? permission('write'));
      return callback('identifier', db as never, context, server);
    },
    async authorizeTransfer(_context, _id, _write, _db, _timing, _expected, _cleanup, key) {
      check(key ?? permission('read'));
    },
  } satisfies Partial<ManagementRuntime>;
  const app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'internal_error' },
      error instanceof DomainError ? (error.status as 400) : 500,
    ),
  );
  registerMinecraftPlayerDetailRoutes(app, {
    db: db as never,
    env: {},
    principal: async () => context,
    body: async (c) => c.req.json(),
    management: async () => runtime as unknown as ManagementRuntime,
  });
  return {
    app,
    contents,
    directories,
    requested,
    symlinks,
    permissions,
    adapter,
    prefix,
    statsPrefix,
    readService,
    offline: () => {
      runtimeState = 'offline';
    },
    presence: (value: boolean) => {
      presence = value;
    },
    revokeBeforeEffect: () => {
      beforeEffect = () => {
        revoked = true;
      };
    },
  };
}
const url = `/v1/servers/server/minecraft/players/${uuid}`;
const action = (f: ReturnType<typeof fixture>, input: unknown) =>
  f.app.request(`${url}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

describe('scoped player detail HTTP contract', () => {
  it('does not infer command support for snapshots, old or unknown future releases', () => {
    for (const release of ['1.7.10', '1.15.2', '26.1-snapshot-6', '26.4', '27.1', 'unknown'])
      expect(minecraftDetailCommandsSupported(release)).toBe(false);
    for (const release of ['1.16.5', '1.20.4', '1.21.1', '26.1', '26.3'])
      expect(minecraftDetailCommandsSupported(release)).toBe(true);
  });
  it.each([false, true])(
    'reads only derived player paths and preserves unknown names, modern=%s',
    async (modern) => {
      const f = fixture(modern);
      const response = await f.app.request(url);
      expect(response.status).toBe(200);
      const value = minecraftPlayerDetailSchema.parse(await response.json());
      expect(value).toMatchObject({
        online: 'online',
        layout: modern ? 'modern' : 'legacy',
        snapshot: {
          source: 'saved-files',
          savedAt: '2026-10-22T08:00:00.000Z',
          state: 'available',
        },
        vitals: { health: 13 },
      });
      expect(value.inventory).toHaveLength(6);
      expect(value.enderChest).toHaveLength(2);
      const known = await discoverMinecraftPlayers(f.readService());
      expect(known.knownPlayers.find((player) => player.uuid === other)?.name).toBeNull();
      expect(f.requested.some((path) => path.endsWith(`${other}.dat`))).toBe(false);
      expect(f.permissions).not.toContain('files.read');
    },
  );
  it('does not present unreadable or absent player data as empty inventory', async () => {
    const f = fixture();
    f.contents.set(`${f.prefix}/${uuid}.dat`, Buffer.from('broken'));
    const value = await (await f.app.request(url)).json();
    expect(value).toMatchObject({
      snapshot: { state: 'unsupported' },
      inventory: null,
      enderChest: null,
    });
  });
  it('rejects world symlinks and arbitrary UUID/path input', async () => {
    const f = fixture();
    f.symlinks.add('world');
    expect((await f.app.request(url)).status).toBe(409);
    expect((await f.app.request('/v1/servers/server/minecraft/players/not-a-uuid')).status).toBe(
      400,
    );
    expect(f.adapter.sendCommand).not.toHaveBeenCalled();
  });
  it.each([
    [{ action: 'heal' }, `effect give ${uuid} minecraft:instant_health 1 10 true`],
    [{ action: 'feed' }, `effect give ${uuid} minecraft:saturation 1 10 true`],
    [{ action: 'starve' }, `effect give ${uuid} minecraft:hunger 30 255 true`],
    [{ action: 'kill' }, `kill ${uuid}`],
    [{ action: 'gamemode', mode: 'spectator' }, `gamemode spectator ${uuid}`],
    [
      { action: 'teleport', x: 1.5, y: 70, z: -2 },
      `execute as ${uuid} at @s run teleport @s 1.5 70 -2`,
    ],
    [
      { action: 'teleport', x: 0.0000001, y: 70, z: -0.0000002 },
      `execute as ${uuid} at @s run teleport @s 0.0000001 70 -0.0000002`,
    ],
  ])(
    'dispatches strict UUID-bound action %j without claiming a confirmed outcome',
    async (input, expected) => {
      const f = fixture();
      const response = await action(f, input);
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ outcome: 'dispatched' });
      expect(f.adapter.sendCommand).toHaveBeenCalledWith('identifier', expected);
    },
  );
  it('requires the specific action grant, fresh presence and current authority', async () => {
    const f = fixture();
    f.permissions.splice(f.permissions.indexOf(permission('kill')), 1);
    expect((await action(f, { action: 'kill' })).status).toBe(403);
    f.presence(false);
    expect((await action(f, { action: 'heal' })).status).toBe(409);
    f.presence(true);
    f.revokeBeforeEffect();
    expect((await action(f, { action: 'heal' })).status).toBe(409);
    expect(f.adapter.sendCommand).not.toHaveBeenCalled();
  });
  it('never substitutes list/Mojang identity when the server usercache has no UUID binding', async () => {
    const f = fixture();
    f.contents.delete('usercache.json');
    f.contents.set(
      'ops.json',
      Buffer.from(JSON.stringify([{ uuid, name: 'PlayerOne', level: 4 }])),
    );
    expect((await action(f, { action: 'heal' })).status).toBe(409);
    expect(f.adapter.sendCommand).not.toHaveBeenCalled();
  });
  it('requires offline state and a current revision, retaining recoverable copies for explicit reset scopes', async () => {
    const f = fixture();
    const initial = await (await f.app.request(url)).json();
    const input = {
      action: 'reset',
      scopes: ['playerdata'],
      revision: initial.snapshot.revision,
      confirm: true,
    };
    expect((await action(f, input)).status).toBe(409);
    f.offline();
    expect((await action(f, { ...input, revision: 'a'.repeat(64) })).status).toBe(409);
    const original = f.contents.get(`${f.prefix}/${uuid}.dat`);
    const response = await action(f, input);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.outcome).toBe('confirmed');
    expect(result.recoveryPaths).toHaveLength(2);
    expect(f.contents.get(result.recoveryPaths[0])).toEqual(original);
    expect(f.contents.has(`${f.prefix}/${uuid}.dat`)).toBe(false);
    expect(f.contents.has(`${f.prefix}/${uuid}.dat_old`)).toBe(false);
    expect(f.contents.has(`${f.statsPrefix}/${uuid}.json`)).toBe(true);
    expect(f.contents.has(`${f.prefix}/${other}.dat`)).toBe(true);
    expect(
      vi
        .mocked(recordAudit)
        .mock.calls.some(
          (call) => call[2] === 'server.minecraft.player.reset' && call[3]?.outcome === 'confirmed',
        ),
    ).toBe(true);
  });
  it('reports uncertain reset after a partial provider effect and preserves the durable recovery receipt', async () => {
    const f = fixture();
    f.offline();
    const initial = await (await f.app.request(url)).json();
    f.adapter.renameFiles.mockRejectedValueOnce(new Error('provider uncertain'));
    const response = await action(f, {
      action: 'reset',
      scopes: ['playerdata'],
      revision: initial.snapshot.revision,
      confirm: true,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'operation_uncertain' });
    expect(vi.mocked(recordAudit).mock.calls.some((call) => call[3]?.outcome === 'requested')).toBe(
      true,
    );
    expect(vi.mocked(recordAudit).mock.calls.some((call) => call[3]?.outcome === 'uncertain')).toBe(
      true,
    );
  });
});
