import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { FilemanReadService } from '@nickhosting/game-sdk';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import { createOpenworldPlayerDirectory } from '../../../packages/server-management/src/openworld-player-directory.js';
import { readOpenworldScope } from '../../../packages/server-management/src/openworld-telemetry.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerOpenworldPlayerDirectoryRoutes } from './openworld-player-directory.js';

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  fixture = await createTestDatabase();
});
afterAll(async () => {
  await fixture?.destroy();
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function server() {
  const db = fixture.db;
  const owner = await managementFixture(db),
    id = await owner.server();
  await db
    .insertInto('game_integrations')
    .values({ id: 'openworld', version: openworldManifest.version, manifest: openworldManifest })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'openworld', runtime_id: 'dedicated' })
    .where('id', '=', owner.mappingId)
    .execute();
  await db
    .insertInto('openworld_server_profiles')
    .values({ server_id: id, version: 'a1.2.9', sha256: 'a'.repeat(64), size: 100 })
    .execute();
  await db
    .updateTable('managed_servers')
    .set({ runtime_state: 'offline' })
    .where('id', '=', id)
    .execute();
  return { id, owner };
}
function fileFixture() {
  const stats = new Map<string, Uint8Array>();
  const docs = new Map<string, Uint8Array>(),
    stamp = '2026-11-20T17:00:00.000Z';
  const list = vi.fn(async (root: string) => {
    if (root === '') return [{ name: 'owserver_data', kind: 'directory' as const, size: 0 }];
    if (root === 'owserver_data') return [{ name: 'players', kind: 'directory' as const, size: 0 }];
    if (root === 'owserver_data/players' || root === 'owserver_data/players/stats') {
      const entries = root.endsWith('/stats') ? stats : docs;
      return [
        ...(!root.endsWith('/stats') && stats.size
          ? [{ name: 'stats', kind: 'directory' as const, size: 0 }]
          : []),
        ...Array.from(entries.entries(), ([name, buf]) => ({
          name: `${name}.json`,
          kind: 'file' as const,
          size: buf.length,
          modifiedAt: stamp,
        })),
      ];
    }
    throw Error(root);
  });
  const files: FilemanReadService = {
    list,
    read: vi.fn(),
    listMany: vi.fn(),
    prepare: vi.fn(),
    readMany: vi.fn<FilemanReadService['readMany']>(
      async (requests) =>
        new Map(
          requests.map(({ path }) => [
            path,
            (path.includes('/stats/') ? stats : docs).get(
              path.split('/').at(-1)?.slice(0, -5) ?? '',
            ),
          ]),
        ),
    ),
  };
  const put = (uuid: string, name: string) =>
    docs.set(
      uuid,
      bytes({
        uuid,
        pseudo: name,
        format: 3,
        gameMode: 'survival',
        savedAtMs: Date.parse(stamp),
        vitals: { health: 58, food: 76, saturation: 28.25, air: 300 },
        inventory: { selected: 0, hotbar: [[11, 2]], bag: [], armor: [80, 0, 0, 0], gear: [0, 0] },
      }),
    );
  return { docs, stats, list, files, put };
}

it('keeps same-name player searches in the authorized instance, requires inspection, and reads fresh saved details by identity', async () => {
  const a = await server(),
    b = await server(),
    sub = await managementFixture(fixture.db);
  const media = new Map([
    [a.id, fileFixture()],
    [b.id, fileFixture()],
  ]);
  const uuid = randomUUID(),
    other = randomUUID();
  media.get(a.id)?.put(uuid, 'Ada');
  media.get(b.id)?.put(other, 'Ada');
  media.get(a.id)?.stats.set(uuid, bytes({ uuid, pseudo: 'Ada', lastSeenMs: 1740000000000 }));
  const dir = createOpenworldPlayerDirectory(fixture.db, async (_who, id, task) => {
    const entry = media.get(id);
    if (!entry) throw new Error('Unexpected fixture');
    return task(entry.files);
  });
  const app = new Hono<{ Variables: Variables }>();
  app.onError((e, c) =>
    c.json(
      { error: e instanceof DomainError ? e.code : 'internal_error' },
      e instanceof DomainError ? (e.status as 400) : 500,
    ),
  );
  registerOpenworldPlayerDirectoryRoutes(
    app,
    {
      db: fixture.db,
      principal: async (c) => (c.req.header('x-sub') ? sub.context : a.owner.context),
    },
    dir,
  );
  const url = `/v1/servers/${a.id}/openworld/players/saved`;
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const binding = (await readOpenworldScope(fixture.db, a.id)).binding;
  await fixture.db
    .insertInto('openworld_player_skins')
    .values({
      server_id: a.id,
      account_id: uuid,
      binding,
      skin_hash: '12ab34cd',
      observed_at: new Date(),
      head_png: png,
      body_png: png,
    })
    .execute();
  expect((await dir.list(b.owner.context, b.id, '', 1)).players[0]?.skinHash).toBeUndefined();
  const res = await app.request(`${url}?q=Ada`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    total: 1,
    players: [{ uuid, name: 'Ada', lastSeenMs: 1740000000000, skinHash: '12ab34cd' }],
    stale: false,
    indexing: false,
  });
  expect(JSON.stringify(await (await app.request(`${url}?q=%25`)).json())).not.toContain(uuid);
  const search = (asSub = false) =>
    app.request(`${url}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(asSub ? { 'x-sub': '1' } : {}) },
      body: JSON.stringify({ q: 'Ada', page: 1, excludeAccounts: [uuid] }),
    });
  expect(await (await search()).json()).toMatchObject({ total: 0, players: [] });
  const detail = await (await app.request(`${url}/${uuid}`)).json();
  expect(detail.skinHash).toBe('12ab34cd');
  expect(detail).toMatchObject({
    vitals: { health: 58, hunger: 76, saturation: 28.25, air: 15 },
    heldItem: { code: 11, count: 2 },
    armor: [{ slot: 'helmet', code: 80 }, null, null, null],
    gear: [null, null],
  });
  expect(detail).not.toHaveProperty('head_png');
  expect((await app.request(`${url}/${other}`)).status).toBe(404);
  await fixture.db
    .insertInto('server_subusers')
    .values({
      server_id: a.id,
      user_id: sub.context.subjectUserId,
      created_by: a.owner.context.subjectUserId,
      permission_keys: JSON.stringify(['game.openworld.players.read']),
    })
    .execute();
  expect((await app.request(url, { headers: { 'x-sub': '1' } })).status).toBe(403);
  expect((await search(true)).status).toBe(403);
  await fixture.db
    .updateTable('server_subusers')
    .set({
      permission_keys: JSON.stringify([
        'game.openworld.players.read',
        'game.openworld.players.inspect',
      ]),
    })
    .where('server_id', '=', a.id)
    .execute();
  expect((await app.request(url, { headers: { 'x-sub': '1' } })).status).toBe(200);
  const persisted = await fixture.db
    .selectFrom('openworld_saved_players')
    .selectAll()
    .where('server_id', '=', a.id)
    .execute();
  expect(persisted).toHaveLength(1);
  expect(JSON.stringify(persisted)).not.toMatch(/inventory|hotbar|survival/);
});
it('uses a warm index during file I/O, progresses across bounded batches and removes deleted players', async () => {
  const { id, owner } = await server(),
    f = fileFixture(),
    ids: string[] = Array.from({ length: 45 }, () => randomUUID());
  for (const uuid of ids) f.put(uuid, 'Ada');
  let clock = Date.now(),
    pause: Promise<void> | undefined;
  const dir = createOpenworldPlayerDirectory(
    fixture.db,
    async (_who, _id, work) => {
      await pause;
      return work(f.files);
    },
    () => clock,
  );
  const list = (page = 1) => dir.list(owner.context, id, '', page);
  expect(await list()).toMatchObject({ total: 32, indexing: true });
  clock += 3000;
  let release!: () => void;
  pause = new Promise((resolve) => {
    release = resolve;
  });
  expect(await list()).toMatchObject({ total: 32, indexing: true });
  release();
  await vi.waitFor(async () => expect(await list()).toMatchObject({ total: 45, indexing: false }), {
    timeout: 2000,
  });
  expect((await list(2)).players).toHaveLength(5);
  // An existing directory migrates its timestamps in batches without withdrawing valid rows.
  await fixture.db
    .updateTable('openworld_saved_players')
    .set({ revision: sql<string>`substring(revision from 4)`, last_seen_at: null })
    .where('server_id', '=', id)
    .execute();
  clock += 60001;
  expect(await list()).toMatchObject({ total: 45 });
  await vi.waitFor(async () => {
    const upgraded = await fixture.db
      .selectFrom('openworld_saved_players')
      .where('server_id', '=', id)
      .where('revision', 'like', 'v2:%')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(upgraded.n)).toBe(32);
  });
  const excluded = await dir.list(owner.context, id, '', 1, ids.slice(0, 8));
  expect(excluded.total).toBe(37);
  expect(excluded.players).toHaveLength(37);
  expect(excluded.players.some((p) => ids.slice(0, 8).includes(p.uuid))).toBe(false);
  clock += 3000;
  await vi.waitFor(async () => expect(await list()).toMatchObject({ total: 45, indexing: false }));

  const reads = vi.mocked(f.files.readMany).mock.calls.length;
  f.docs.delete(ids[0] as string);
  clock += 60001;
  expect(await list()).toMatchObject({ total: 45, stale: true });
  await vi.waitFor(async () => expect(await list()).toMatchObject({ total: 44, indexing: false }), {
    timeout: 2000,
  });
  expect(vi.mocked(f.files.readMany).mock.calls.length).toBe(reads);
  const stored = await fixture.db
    .selectFrom('managed_servers')
    .select('runtime_state')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  expect(stored.runtime_state).toBe('offline');
});

it('checks the instance again before publishing an index and before returning an individual save', async () => {
  const { id, owner } = await server(),
    f = fileFixture(),
    uuid = randomUUID();
  f.put(uuid, 'Ada');
  for (const operation of ['index', 'detail']) {
    const waiting = Promise.withResolvers<void>(),
      continueRead = Promise.withResolvers<void>();
    const service = createOpenworldPlayerDirectory(fixture.db, async (_who, _id, task) => {
      const data = await task(f.files);
      waiting.resolve();
      await continueRead.promise;
      return data;
    });
    const result =
      operation === 'index'
        ? service.list(owner.context, id, '', 1)
        : service.detail(owner.context, id, uuid);
    await waiting.promise;
    await fixture.db
      .updateTable('managed_servers')
      .set({ pterodactyl_uuid: randomUUID() })
      .where('id', '=', id)
      .execute();
    continueRead.resolve();
    await expect(result).rejects.toMatchObject({ code: 'provenance_mismatch' });
    expect(
      await fixture.db
        .selectFrom('openworld_player_directories')
        .select('server_id')
        .where('server_id', '=', id)
        .execute(),
    ).toEqual([]);
  }
});

it('joins native guest statistics by embedded identity across save paths and counts the account once', async () => {
  const { id, owner } = await server(),
    media = fileFixture();
  media.put('guest:fixtureada', 'Ada');
  media.stats.set('fixtureada', bytes({ uuid: 'guest:fixtureada', pseudo: 'Ada', joins: 7 }));
  const service = createOpenworldPlayerDirectory(fixture.db, async (_who, _id, task) =>
    task(media.files),
  );
  expect(await service.list(owner.context, id, '', 1)).toMatchObject({
    total: 1,
    players: [{ uuid: 'guest:fixtureada' }],
  });
  expect(await service.detail(owner.context, id, 'guest:fixtureada')).toMatchObject({
    uuid: 'guest:fixtureada',
    stats: { joins: 7 },
    inventory: { selected: 0 },
  });
  await expect(service.detail(owner.context, id, 'fixtureada')).rejects.toMatchObject({
    code: 'not_found',
  });
});

it('returns a separately timestamped vital observation only on the matching saved profile without native vitals', async () => {
  const { id, owner } = await server();
  const { id: otherId, owner: otherOwner } = await server();
  const io = fileFixture();
  const directory = createOpenworldPlayerDirectory(fixture.db, async (_who, _id, work) =>
    work(io.files),
  );
  const account = randomUUID();
  const other = randomUUID();
  const at = new Date('2026-11-21T19:00:00.000Z');
  const binding = (await readOpenworldScope(fixture.db, id)).binding;
  await fixture.db
    .insertInto('openworld_player_vitals')
    .values({
      server_id: id,
      binding,
      account_id: account,
      observed_at: at,
      vitals: JSON.stringify({ health: 71, maxHealth: 100, saturation: 25 }),
    })
    .execute();
  for (const uuid of [account, other])
    io.docs.set(uuid, bytes({ format: 3, uuid, inventory: { armor: [0, 0, 5, 0] } }));
  expect(await directory.detail(owner.context, id, account)).toMatchObject({
    vitals: { health: 71, maxHealth: 100, saturation: 25, maxSaturation: 50 },
    vitalsObservedAt: at.toISOString(),
    armor: [null, null, { code: 5, slot: 'leggings' }, null],
  });
  expect(await directory.detail(owner.context, id, other)).not.toHaveProperty('vitals');
  expect(await directory.detail(otherOwner.context, otherId, account)).not.toHaveProperty('vitals');
  io.put(account, 'Ada');
  const native = await directory.detail(owner.context, id, account);
  expect(native.vitals?.health).toBe(58);
  expect(native).not.toHaveProperty('vitalsObservedAt');
  io.docs.set(account, bytes({ uuid: account, format: 3 }));
  await fixture.db
    .updateTable('openworld_player_vitals')
    .set({ binding: 'previous-provider-binding' })
    .where('server_id', '=', id)
    .execute();
  expect(await directory.detail(owner.context, id, account)).not.toHaveProperty('vitals');
});
