import { randomBytes, randomUUID } from 'node:crypto';
import { DomainError, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type {
  ApplicationServer,
  ConsoleRelayOptions,
  PterodactylAdapter,
} from '@nickhosting/pterodactyl-adapter';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { minecraftPlayerDataFixture } from '../../../games/minecraft/src/player-data-fixture.js';
import { createManagementRuntime } from '../../../packages/server-management/src/runtime.js';
import { setServerSubuser } from '../../../packages/server-management/src/subusers.js';
import {
  managementFixture,
  minecraftManagementFixture,
} from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerMinecraftPlayerDetailRoutes } from './minecraft-player-details.js';

// Only the release capability lookup is synthetic. Access/session/identity,
// advisory locks, direct grants and all audit writes use the real SQL/runtime.
vi.mock('@nickhosting/server-management', async (original) => ({
  ...(await original<typeof import('@nickhosting/server-management')>()),
  inspectMinecraftCombination: vi.fn(async () => ({
    combination: { release: '26.3' },
    capabilities: { playerManagement: true },
  })),
}));
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

it('enforces real direct action grants and serializes recoverable reset with power while preserving partial-failure audit', async () => {
  const f = await minecraftManagementFixture(database.db, { interactive: true });
  const peer = await managementFixture(database.db, { interactive: true });
  const serverId = await f.server();
  const combinationId = randomUUID();
  await f.db
    .insertInto('minecraft_combinations')
    .values({
      id: combinationId,
      mapping_id: f.mappingId,
      identity_digest: '1'.repeat(64),
      mapping_digest: '2'.repeat(64),
      combination: '{}',
      resolved_runtime: '{}',
      binding: '{}',
    })
    .execute();
  await f.db
    .insertInto('minecraft_server_profiles')
    .values({
      server_id: serverId,
      combination_id: combinationId,
      configuration: '{"eula":true}',
      installed: true,
    })
    .execute();
  const server = await f.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow();
  const allocations = await f.db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', serverId)
    .execute();
  const remote = {
    id: server.pterodactyl_id,
    uuid: server.pterodactyl_uuid,
    identifier: server.pterodactyl_identifier,
    external_id: server.external_id,
    node: f.providerNodeId,
    user: server.provider_user_id,
    allocation: allocations.find((row) => row.is_primary)?.pterodactyl_allocation_id,
    relationships: {
      allocations: {
        data: allocations.map((row) => ({
          attributes: {
            id: row.pterodactyl_allocation_id,
            ip: row.address,
            port: row.port,
            assigned: true,
          },
        })),
      },
    },
  } as ApplicationServer;
  const uuid = '11111111-1111-1111-1111-111111111111';
  const path = `world/players/data/${uuid}.dat`;
  const bytes = minecraftPlayerDataFixture(true);
  const files = new Map<string, Buffer>([
    ['server.properties', Buffer.from('level-name=world')],
    ['usercache.json', Buffer.from(JSON.stringify([{ uuid, name: 'PlayerOne' }]))],
    [path, bytes],
    [`${path}_old`, bytes],
  ]);
  const dirs = ['world', 'world/players', 'world/players/data'];
  const listFiles: PterodactylAdapter['listFiles'] = async (_id, directory = '') => {
    const prefix = directory ? `${directory}/` : '';
    return [...dirs, ...files.keys()]
      .filter((value) => value.startsWith(prefix) && !value.slice(prefix.length).includes('/'))
      .map((value) => ({
        name: value.slice(prefix.length),
        mode: '644',
        mode_bits: '420',
        size: files.get(value)?.length ?? 0,
        is_file: files.has(value),
        is_symlink: false,
        mimetype: 'application/octet-stream',
        created_at: '2026-10-22T08:00:00Z',
        modified_at: '2026-10-22T08:00:00Z',
      }));
  };
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let moveCount = 0;
  let running = false,
    revokeDuringPresence = false;
  const sendCommand = vi.fn(async () => {});
  const adapter = {
    ...f.adapter,
    getApplicationServer: vi.fn(async () => remote),
    listFiles,
    getDirectoryBatchSettings: async () => ({
      directoryBatchLimit: 32,
      directoryTimeoutSeconds: 5,
    }),
    listDirectoriesBatch: async (id: string, directories: string[]) =>
      Promise.all(
        directories.map(async (directory) => ({
          directory,
          files: await listFiles(id, directory),
        })),
      ),
    getResources: vi.fn(async () => ({ current_state: running ? 'running' : 'offline' })),
    sendCommand,
    relayConsole: async (_id: string, options: ConsoleRelayOptions) => ({
      async sendCommand() {
        if (revokeDuringPresence)
          await setServerSubuser(f.db, f.context, serverId, peer.context.subjectUserId, {
            permissionKeys: ['game.minecraft.players.read'],
          });
        options.onEvent({
          type: 'console',
          data: '[12:34:56] [Server thread/INFO]: There are 1 of a max of 20 players online: PlayerOne',
        });
      },
      close() {},
    }),
    readFileForEditor: vi.fn(async (_id, target: string) => {
      const value = files.get(target);
      if (!value) throw new DomainError('not_found');
      return value;
    }),
    downloadFile: vi.fn(async (_id, target: string) => {
      const value = files.get(target);
      if (!value) throw new DomainError('not_found');
      return new Response(new Uint8Array(value));
    }),
    renameFiles: vi.fn(async (_id, _root, moves: { from: string; to: string }[]) => {
      if (++moveCount === 1) {
        entered.resolve();
        await release.promise;
      } else throw new Error('isolated provider failed after first move');
      for (const move of moves) {
        const value = files.get(move.from);
        if (!value) throw new Error('missing');
        files.set(move.to, value);
        files.delete(move.from);
      }
    }),
  } as unknown as PterodactylAdapter;
  const runtime = await createManagementRuntime({
    db: f.db,
    codec: new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } }),
    adapter,
  });
  const app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'internal_error' },
      error instanceof DomainError ? (error.status as 400) : 500,
    ),
  );
  registerMinecraftPlayerDetailRoutes(app, {
    db: f.db,
    env: {},
    principal: async () => peer.context,
    body: async (c) => c.req.json(),
    management: async () => runtime,
  });
  const grant = (actions: string[]) =>
    setServerSubuser(f.db, f.context, serverId, peer.context.subjectUserId, {
      permissionKeys: actions.map((action) => `game.minecraft.players.${action}`),
    });
  await grant(['read']);
  const url = `/v1/servers/${serverId}/minecraft/players/${uuid}`;
  const post = (input: unknown) =>
    app.request(`${url}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  const response = await app.request(url);
  expect(response.status, await response.clone().text()).toBe(200);
  const detail = await response.json();
  const reset = {
    action: 'reset',
    scopes: ['playerdata'],
    revision: detail.snapshot.revision,
    confirm: true,
  };
  expect((await post(reset)).status).toBe(403);
  expect((await post({ action: 'heal' })).status).toBe(403);
  expect(adapter.renameFiles).not.toHaveBeenCalled();
  await grant(['read', 'reset']);
  const pending = post(reset);
  try {
    await entered.promise;
    const power = vi.fn(async () => {});
    await expect(
      runtime.access(f.context, serverId, true, power, undefined, 'console.power'),
    ).rejects.toMatchObject({ code: 'operation_busy' });
    expect(power).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  expect((await pending).status).toBe(409);
  const receipts = await f.db
    .selectFrom('audit_events')
    .select('metadata')
    .where('action', '=', 'server.minecraft.player.reset')
    .where('actor_user_id', '=', peer.context.actorUserId)
    .orderBy('created_at', 'asc')
    .execute();
  expect(receipts.map((row) => row.metadata.outcome)).toEqual(['requested', 'uncertain']);
  const moves = receipts[0]?.metadata.moves as { from: string; to: string }[];
  expect(files.get(moves[0]?.to ?? '')).toEqual(bytes);
  expect(files.has(path)).toBe(false);
  expect(files.has(`${path}_old`)).toBe(true);
  expect(receipts[0]?.metadata.entries).toEqual(
    moves.map((move) => ({ path: move.from, target: move.to })),
  );
  await expect(
    runtime.access(f.context, serverId, true, async () => 'released', undefined, 'console.power'),
  ).resolves.toBe('released');
  running = true;
  await grant(['read', 'heal']);
  const healed = await post({ action: 'heal' });
  expect(healed.status, await healed.clone().text()).toBe(202);
  expect(sendCommand).toHaveBeenCalledExactlyOnceWith(
    server.pterodactyl_identifier,
    `effect give ${uuid} minecraft:instant_health 1 10 true`,
  );
  expect((await post({ action: 'kill' })).status).toBe(403);
  revokeDuringPresence = true;
  expect((await post({ action: 'heal' })).status).toBe(403);
  expect(sendCommand).toHaveBeenCalledTimes(1);
}, 30000);
