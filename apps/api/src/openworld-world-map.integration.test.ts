import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import { createOpenworldWorldMap } from '../../../packages/server-management/src/openworld-world-map.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerOpenworldWorldMapRoutes } from './openworld-world-map.js';

const read = 'game.openworld.map.read';
const manage = 'game.openworld.checkpoints.manage';
const fields = {
  name: 'Refuge',
  note: 'private notes',
  color: '#22aabb',
  icon: 'flag',
  visibility: 'admins',
};
const position = { type: 'geo', lat: 8, lon: 15, alt: null };
const create = { kind: 'create', fields, position };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

async function fixture() {
  const db = database.db;
  const owner = await managementFixture(db);
  const sub = await managementFixture(db);
  const id = await owner.server();
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
    .values({
      server_id: id,
      version: 'a1.2.9',
      sha256: 'a'.repeat(64),
      size: 123,
      dashboard_credential_prepared: true,
    })
    .execute();
  const game = await db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', id)
    .executeTakeFirstOrThrow();
  const admin = {
    ...game,
    id: randomUUID(),
    role: 'dashboard',
    port: game.port + 1,
    pterodactyl_allocation_id: game.pterodactyl_allocation_id + 1,
    protocols: ['tcp'] as ('tcp' | 'udp')[],
    is_primary: false,
    private_only: true,
    direct_endpoint: null,
  };
  await db.insertInto('server_allocations').values(admin).execute();
  await db
    .insertInto('server_subusers')
    .values({
      server_id: id,
      user_id: sub.context.subjectUserId,
      permission_keys: JSON.stringify(['settings.read']),
      created_by: owner.context.subjectUserId,
    })
    .execute();
  const grant = (...keys: string[]) =>
    db
      .updateTable('server_subusers')
      .set({ permission_keys: JSON.stringify(keys) })
      .where('server_id', '=', id)
      .where('user_id', '=', sub.context.subjectUserId)
      .execute();
  const power = (state: 'running' | 'offline') =>
    db.updateTable('managed_servers').set({ runtime_state: state }).where('id', '=', id).execute();
  const target = vi.fn(async () => ({
    address: `http://${admin.backend_address}:${admin.port}`,
    password: 'p'.repeat(43),
  }));
  const state = {
    checkpoint: {
      id: 1,
      world: 'earth',
      ...fields,
      geo: { lat: 8, lon: 15, alt: 5 },
      pos: { x: 40, y: 5, z: 60, face: 0 },
      author: 'private owner IP',
      createdAtMs: 100,
    },
    onRead: undefined as ((path: string) => Promise<void>) | undefined,
    onWrite: undefined as (() => Response | Promise<Response>) | undefined,
    clock: Date.now(),
    explored: true,
    reset: false,
  };
  const writes: string[] = [],
    reads: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const remote = new URL(String(url)),
      resource = remote.pathname.slice('/api/live/'.length);
    if (resource === 'auth')
      return Response.json({ required: true, loopback: false, canAct: false });
    if (resource === 'login') return Response.json({ token: 'owned-fixture' });
    if (new Headers(init?.headers).get('X-OW-Token') !== 'owned-fixture')
      return new Response(null, { status: 401 });
    if (init?.method === 'POST') {
      writes.push(resource);
      return state.onWrite
        ? state.onWrite()
        : Response.json(resource.endsWith('/delete') ? { ok: true } : state.checkpoint);
    }
    reads.push(resource);
    const explored = state.explored;
    await state.onRead?.(resource);
    switch (resource) {
      case 'chunks':
        return Response.json({
          worlds: [{ key: 'earth', name: 'Earth', faceEdgeMeters: 8000 }],
          hot: [],
        });
      case 'map/index':
        return Response.json({
          stamp: explored ? 30 : 29,
          faces: explored ? [{ face: 0, count: 3, i0: 4, j0: 0, i1: 17, j1: 8 }] : [],
        });
      case 'map/columns':
        return new Response(new Int32Array([4, 3, 5, 4, 17, 8]).buffer);
      case 'map/surface':
        return new Response(null, { status: 404 });
      case 'map/changes':
        return Response.json({ stamp: 31, reset: state.reset, columns: [[0, 4, 3, 4]] });
      case 'players':
        return Response.json({
          players: [
            {
              id: 2,
              name: 'Ada',
              connectedS: 12,
              world: 'earth',
              pos: { face: 0, x: 5, z: 8 },
              account: 'private',
            },
          ],
        });
      case 'checkpoints':
        return Response.json({ checkpoints: [state.checkpoint] });
      default:
        throw Error('Unexpected native resource');
    }
  };
  const router = () => {
    const app = new Hono<{ Variables: Variables }>();
    app.onError((e, c) =>
      c.json(
        { error: e instanceof DomainError ? e.code : 'internal_error' },
        e instanceof DomainError ? (e.status as 400) : 500,
      ),
    );
    registerOpenworldWorldMapRoutes(
      app,
      {
        db,
        principal: async (c) =>
          c.req.header('X-Reader') === 'owner' ? owner.context : sub.context,
      },
      createOpenworldWorldMap({ db, target, fetcher, now: () => state.clock }),
    );
    return (path: string, body?: unknown, as: 'owner' | 'sub' = 'sub') =>
      app.request(`/v1/servers/${id}/openworld/map${path}`, {
        headers: { 'content-type': 'application/json', 'X-Reader': as },
        method: body ? 'POST' : 'GET',
        body: body ? JSON.stringify(body) : undefined,
      });
  };
  const request = router();
  const ref = async () =>
    (await (await request('', undefined, 'owner')).json()).processRef as string;
  return { id, db, grant, power, ref, reads, writes, state, target, request, router };
}

it('requires map access and a matching private process, bounds reads and returns only visible explored columns', async () => {
  const f = await fixture();
  await f.grant('game.openworld.performance.read', manage);
  expect((await f.request('')).status).toBe(403);
  await f.grant(read);
  expect(await (await f.request('')).json()).toEqual({ error: 'game_not_ready' });
  expect(f.target).not.toHaveBeenCalled();
  await f.power('running');
  const meta = await f.request('');
  expect(meta.headers.get('cache-control')).toBe('private, no-store');
  const { processRef, worlds } = await meta.json();
  expect(worlds[0].key).toBe('earth');
  const q = `?world=earth&processRef=${processRef}`;
  expect(await (await f.request(`/index${q}`)).json()).toMatchObject({ stamp: 30 });
  expect(
    await (await f.request(`/columns${q}&face=0&i0=1&i1=15&j0=0&j1=14&stride=8`)).json(),
  ).toEqual({ columns: [[0, 0]] });
  expect(await (await f.request(`/columns${q}&face=0&i0=16&i1=20&j0=0&j1=20`)).json()).toEqual({
    columns: [[17, 8]],
  });
  expect(f.reads.filter((r) => r === 'map/columns')).toHaveLength(1);
  expect(await (await f.request(`/changes${q}&since=30`)).json()).toEqual({
    stamp: 31,
    reset: false,
    columns: [[0, 4, 3]],
  });
  const tile = await (await f.request(`/surface${q}&face=0&ci=0&cj=0`)).json();
  expect(tile.side).toBe(32);
  expect(tile.samples).toEqual(Array(1024).fill(-1));
  expect((await f.request(`/surface${q}&face=6&ci=0&cj=0`)).status).toBe(400);
  expect((await f.request(`/surface${q}&face=0&ci=1&cj=0`)).status).toBe(400);
  expect((await f.request(`/columns${q}&face=0&i0=8`)).status).toBe(400);
  expect(
    (await f.request(`/surface?world=missing&processRef=${processRef}&face=0&ci=0&cj=0`)).status,
  ).toBe(404);
  expect((await f.request(`/index?world=earth&processRef=${'0'.repeat(64)}`)).status).toBe(409);
  expect(f.reads.filter((r) => r === 'map/surface')).toHaveLength(1);
  await f.power('offline');
  expect(await (await f.request(`/index${q}`)).json()).toEqual({ error: 'game_not_ready' });
  expect(f.target).toHaveBeenCalledTimes(1);
});

it('refreshes an empty cached or in-flight index immediately after a native terrain change', async () => {
  const f = await fixture();
  await f.power('running');
  await f.grant(read);
  const ref = await f.ref(),
    q = `?world=earth&processRef=${ref}`;
  f.state.explored = false;
  expect(await (await f.request(`/index${q}`)).json()).toMatchObject({ faces: [] });
  f.state.explored = true;
  await f.request(`/changes${q}&since=29`);
  expect((await (await f.request(`/index${q}`)).json()).faces).toHaveLength(1);
  f.state.clock += 1600;
  f.state.explored = false;
  const enter = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.state.onRead = async (r) => {
    if (r === 'map/index' && !f.state.explored) {
      enter.resolve();
      await release.promise;
    }
  };
  const pending = f.request(`/index${q}`);
  await enter.promise;
  f.state.reset = true;
  f.state.explored = true;
  await f.request(`/changes${q}&since=30`);
  const fresh = await (await f.request(`/index${q}`)).json();
  release.resolve();
  expect(fresh.faces).toHaveLength(1);
  expect((await (await pending).json()).faces).toHaveLength(1);
});

it('rechecks coalesced map reads on grant revocation, private target replacement and player-marker inspection', async () => {
  const f = await fixture();
  await f.power('running');
  await f.grant(read);
  const ref = await f.ref(),
    path = `/index?world=earth&processRef=${ref}`;
  const enter = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.state.onRead = async (r) => {
    if (r === 'map/index') {
      enter.resolve();
      await release.promise;
    }
  };
  const sub = f.request(path);
  await enter.promise;
  const owner = f.request(path, undefined, 'owner');
  await f.grant(manage);
  release.resolve();
  expect((await sub).status).toBe(403);
  expect((await owner).status).toBe(200);
  expect(f.reads.filter((r) => r === 'map/index')).toHaveLength(1);
  const markers = `/players?processRef=${ref}`;
  for (const keys of [
    [read],
    [read, 'game.openworld.players.read'],
    [read, 'game.openworld.players.inspect'],
    ['game.openworld.players.read', 'game.openworld.players.inspect'],
  ]) {
    await f.grant(...keys);
    expect((await f.request(markers)).status).toBe(403);
  }
  expect(f.reads).not.toContain('players');
  await f.grant(read, 'game.openworld.players.read', 'game.openworld.players.inspect');
  const valid = await (await f.request(markers)).json();
  expect(valid).toMatchObject({ processRef: ref, players: [{ name: 'Ada', face: 0 }] });
  expect(valid.players[0]).not.toHaveProperty('account');
  await f.grant(read);
  expect((await f.request(markers)).status).toBe(403);
  const entered = Promise.withResolvers<void>(),
    complete = Promise.withResolvers<void>();
  f.state.onRead = async (r) => {
    if (r === 'map/surface') {
      entered.resolve();
      await complete.promise;
    }
  };
  const pending = f.request(`/surface?world=earth&face=0&ci=0&cj=0&processRef=${ref}`);
  await entered.promise;
  await f.db
    .updateTable('managed_servers')
    .set({ pterodactyl_uuid: randomUUID() })
    .where('id', '=', f.id)
    .execute();
  complete.resolve();
  expect(await (await pending).json()).toEqual({ error: 'provenance_mismatch' });
  expect((await f.request(path)).status).toBe(409);
});

it('checks current checkpoint revision/world and write permission, commits a durable audit fence and never repeats uncertain writes', async () => {
  const f = await fixture();
  await f.power('running');
  await f.grant(read);
  const ref = await f.ref(),
    list = `/checkpoints?processRef=${ref}&world=earth`;
  const input = { world: 'earth', processRef: ref, action: create, requestId: randomUUID() };
  expect((await f.request('/checkpoints', input)).status).toBe(403);
  await f.grant(manage);
  expect((await f.request('/checkpoints', input)).status).toBe(403);
  await f.grant(read, manage);
  const entry = (await (await f.request(list)).json()).checkpoints[0];
  expect(entry).not.toHaveProperty('author');
  const del = {
    ...input,
    action: { kind: 'delete', id: entry.id, revision: entry.revision },
    requestId: randomUUID(),
  };
  f.state.checkpoint.name = 'Other name';
  expect(await (await f.request('/checkpoints', del)).json()).toEqual({ error: 'conflict' });
  expect((await f.request('/checkpoints', { ...input, world: 'missing' })).status).toBe(404);
  expect(
    (
      await f.request('/checkpoints', {
        ...input,
        requestId: randomUUID(),
        action: { kind: 'console' },
      })
    ).status,
  ).toBe(400);
  expect(f.writes).toHaveLength(0);
  const enter = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.state.onWrite = async () => {
    enter.resolve();
    await release.promise;
    return Response.json(f.state.checkpoint);
  };
  const perform = {
    ...input,
    requestId: randomUUID(),
    action: { ...create, fields: { ...fields, name: f.state.checkpoint.name } },
  };
  const pending = f.request('/checkpoints', perform);
  await enter.promise;
  try {
    expect(await (await f.router()('/checkpoints', perform)).json()).toEqual({
      error: 'operation_uncertain',
    });
    expect(
      await (await f.router()('/checkpoints', { ...perform, requestId: randomUUID() })).json(),
    ).toEqual({ error: 'conflict' });
  } finally {
    release.resolve();
  }
  expect((await pending).status).toBe(202);
  expect((await f.router()('/checkpoints', perform)).status).toBe(202);
  expect((await f.request('/checkpoints', { ...perform, action: del.action })).status).toBe(409);
  expect(f.writes).toEqual(['checkpoints']);
  const row = await f.db
    .selectFrom('audit_events')
    .select('metadata')
    .where('correlation_id', '=', perform.requestId)
    .executeTakeFirstOrThrow();
  expect(row.metadata).toMatchObject({ checkpointAction: 'create', outcome: 'accepted' });
  expect(JSON.stringify(row.metadata)).not.toContain(fields.note);
  f.state.onWrite = async () => {
    throw new TypeError('interrupted');
  };
  const edit = {
    ...input,
    requestId: randomUUID(),
    action: {
      kind: 'update',
      id: entry.id,
      fields,
      revision: (await (await f.request(list)).json()).checkpoints[0].revision,
    },
  };
  expect(await (await f.request('/checkpoints', edit)).json()).toEqual({
    error: 'operation_uncertain',
  });
  expect(await (await f.router()('/checkpoints', edit)).json()).toEqual({
    error: 'operation_uncertain',
  });
  expect(f.writes.filter((r) => r === 'checkpoints/update')).toHaveLength(1);
  f.state.onWrite = async () => new Response(null, { status: 400 });
  expect(
    await (await f.request('/checkpoints', { ...edit, requestId: randomUUID() })).json(),
  ).toEqual({ error: 'game_request_rejected' });
});

it('shows HUD checkpoints to map readers and rechecks private visibility before every response', async () => {
  const f = await fixture();
  await f.power('running');
  const ref = await f.ref(),
    path = `/checkpoints?processRef=${ref}&world=earth`;
  await f.grant(read);
  expect(await (await f.request(path)).json()).toEqual({ checkpoints: [] });
  f.state.checkpoint.visibility = 'players';
  const publicPin = (await (await f.request(path)).json()).checkpoints[0];
  expect(publicPin).toMatchObject({ name: fields.name, note: '' });
  f.state.checkpoint.note = 'Another private note';
  expect((await (await f.request(path)).json()).checkpoints).toEqual([publicPin]);
  expect((await (await f.request(path, undefined, 'owner')).json()).checkpoints[0].note).toBe(
    'Another private note',
  );
  f.state.checkpoint.visibility = 'admins';
  await f.grant(read, manage);
  const entered = Promise.withResolvers<void>(),
    done = Promise.withResolvers<void>();
  f.state.onRead = async (r) => {
    if (r === 'checkpoints') {
      entered.resolve();
      await done.promise;
    }
  };
  const pending = f.request(path);
  await entered.promise;
  await f.grant(read);
  done.resolve();
  expect(await (await pending).json()).toEqual({ checkpoints: [] });
  expect((await (await f.request(path, undefined, 'owner')).json()).checkpoints).toHaveLength(1);
});

it('denies checkpoint dispatch when the reader loses the grant during native preflight', async () => {
  const f = await fixture();
  await f.power('running');
  await f.grant(read, manage);
  const ref = await f.ref();
  const enter = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.state.onRead = async (path) => {
    if (path === 'chunks') {
      enter.resolve();
      await release.promise;
    }
  };
  const pending = f.request('/checkpoints', {
    requestId: randomUUID(),
    world: 'earth',
    processRef: ref,
    action: create,
  });
  await enter.promise;
  await f.grant(read);
  release.resolve();
  expect((await pending).status).toBe(403);
  expect(f.writes).toHaveLength(0);
});
