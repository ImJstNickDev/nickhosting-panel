import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
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
    columns: [4, 3, 5, 4, 17, 8],
    changes: [[0, 4, 3, 4]],
    reset: false,
  };
  const creatureLimits: string[] = [];
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
        return new Response(new Int32Array(state.columns).buffer);
      case 'map/surface':
        return new Response(null, { status: 404 });
      case 'map/changes':
        return Response.json({ stamp: 31, reset: state.reset, columns: state.changes });
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
      case 'ovm':
        return Response.json({
          enabled: true,
          hz: 19.9,
          targetHz: 20,
          stepMs: { p95: 0.06 },
          counts: { nodes: 34 },
          privateField: 'internal',
        });
      case 'entities': {
        const limit = remote.searchParams.get('limit') ?? '';
        creatureLimits.push(limit);
        const sample = { species: 11, face: 1, x: 112, z: 48, privateField: 'internal' };
        return Response.json({
          total: 300,
          items: 7,
          bySpecies: [{ id: 11, key: 'fox', name: 'Fox', count: 300, hostile: false }],
          list: [sample],
        });
      }
      case 'space': {
        const checkpoint = { ...state.checkpoint, helio: [1, 2, 3] };
        return Response.json({
          t: 5,
          bodies: [
            {
              index: 0,
              name: 'Earth',
              world: 'earth',
              parent: -1,
              radiusMeters: 100,
              position: [3, 2, 1],
              atmosphere: true,
              isLight: false,
            },
          ],
          players: [
            {
              id: 2,
              name: 'Ada',
              world: null,
              inSpace: true,
              helio: [1, 2, 3],
              account: 'internal',
            },
          ],
          checkpoints: [
            checkpoint,
            { ...checkpoint, id: 2, name: 'Public', visibility: 'players' },
            { ...checkpoint, id: 3, name: 'Unknown', visibility: 'other' },
          ],
        });
      }
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
    return (
      path: string,
      body?: unknown,
      as: 'owner' | 'sub' = 'sub',
      area: 'map' | 'factories' = 'map',
    ) =>
      app.request(`/v1/servers/${id}/openworld/${area}${path}`, {
        headers: { 'content-type': 'application/json', 'X-Reader': as },
        method: body ? 'POST' : 'GET',
        body: body ? JSON.stringify(body) : undefined,
      });
  };
  const request = router();
  const ref = async () =>
    (await (await request('', undefined, 'owner')).json()).processRef as string;
  return {
    id,
    db,
    grant,
    power,
    ref,
    reads,
    creatureLimits,
    writes,
    state,
    target,
    request,
    router,
  };
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

it('round-trips wide column coordinates, overview buckets, and native tile origins without collisions', async () => {
  const f = await fixture();
  await f.grant(read);
  await f.power('running');
  const processRef = await f.ref();
  const q = `?world=earth&face=0&processRef=${processRef}`;
  // Both pairs used to encode as the same number for a 131072-column face.
  f.state.columns = [131072, 262144, 131074, 0, 0x7ffffffe, 0x7fffffff];
  expect(await (await f.request(`/columns${q}&stride=2`)).json()).toEqual({
    columns: [
      [131072, 262144],
      [131074, 0],
      [0x7ffffffe, 0x7ffffffe],
    ],
  });
  expect(
    await (
      await f.request(`/columns${q}&i0=2147483646&i1=2147483647&j0=2147483647&j1=2147483647`)
    ).json(),
  ).toEqual({ columns: [[0x7ffffffe, 0x7fffffff]] });
  expect(await (await f.request(`/columns${q}&stride=2147483648`)).json()).toEqual({
    columns: [[0, 0]],
  });
  expect((await f.request(`/surface${q}&ci=2147483640&cj=951424`)).status).toBe(200);
  expect((await f.request(`/surface${q}&ci=2147483648&cj=0`)).status).toBe(400);
  expect((await f.request(`/columns${q}&stride=2147483647`)).status).toBe(400);
  f.state.changes = [[0, 12622489, 951427, 5]];
  expect(
    await (await f.request(`/changes?world=earth&processRef=${processRef}&since=30`)).json(),
  ).toEqual({ stamp: 31, reset: false, columns: [[0, 12622489, 951427]] });
  expect(f.reads.filter((r) => r === 'map/columns')).toHaveLength(1);
  expect(f.reads.filter((r) => r === 'map/surface')).toHaveLength(1);
});

it('bounds the framing sample on a large explored face and retains isolated extrema', async () => {
  const f = await fixture();
  await f.grant(read);
  await f.power('running');
  const q = `?world=earth&face=0&processRef=${await f.ref()}`;
  f.state.columns = Array.from({ length: 40000 }, (_, n) => [
    30000 + (n % 200),
    45000 + Math.floor(n / 200),
  ]).flat();
  f.state.columns.splice(550, 2, 12500000, 930000);
  const res = await f.request(`/columns${q}&sample=1`);
  expect(res.status).toBe(200);
  const { columns } = (await res.json()) as { columns: [number, number][] };
  expect(columns.length).toBeLessThanOrEqual(4096);
  expect(columns.length).toBeGreaterThan(4000);
  expect(columns).toContainEqual([12500000, 930000]);
  expect(columns.every(([i, j]) => j >= 45000 && i >= 30000)).toBe(true);
  expect((await f.request(`/columns${q}&sample=1&stride=2`)).status).toBe(400);
  expect((await f.request(`/columns${q}&sample=1&i0=0&i1=50&j0=0&j1=50`)).status).toBe(400);
  expect(f.reads.filter((r) => r === 'map/columns')).toHaveLength(1);
});

it('reports the provider cooldown for map metadata and reuses its verification across retries', async () => {
  const f = await fixture();
  await f.grant(read);
  await f.power('running');
  const throttle = new PterodactylError('rate_limited', 'application', 'rejected', 429, 4250);
  f.target.mockRejectedValueOnce(throttle);
  const now = vi.spyOn(Date, 'now').mockImplementation(() => f.state.clock);
  try {
    const rejected = await f.request('');
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBe('5');
    expect(await rejected.json()).toEqual({ error: 'rate_limited' });
    f.state.clock += 2000;
    const retry = await f.request('');
    expect(retry.status).toBe(429);
    expect(retry.headers.get('retry-after')).toBe('3');
    expect(f.target).toHaveBeenCalledTimes(1);
    f.state.clock += 4000;
    expect((await f.request('')).status).toBe(200);
    expect(f.target).toHaveBeenCalledTimes(2);
  } finally {
    now.mockRestore();
  }
});

it('loads factories only with performance access and only while the bound server is running', async () => {
  const f = await fixture();
  const factories = () => f.request('', undefined, 'sub', 'factories');
  await f.grant(read);
  expect((await factories()).status).toBe(403);
  await f.grant('game.openworld.performance.read');
  expect(await (await factories()).json()).toEqual({ error: 'game_not_ready' });
  expect(f.target).not.toHaveBeenCalled();
  await f.power('running');
  const processRef = await f.ref();
  expect((await f.request(`/space?processRef=${processRef}`)).status).toBe(403);
  expect((await f.request(`/creatures?world=earth&processRef=${processRef}`)).status).toBe(403);
  expect(f.reads).toEqual(['chunks']);
  const responses = await Promise.all([factories(), factories()]);
  for (const response of responses) {
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      enabled: true,
      hz: 19.9,
      targetHz: 20,
      stepMs: { p95: 0.06 },
      counts: { nodes: 34 },
    });
  }
  expect(f.reads.filter((r) => r === 'ovm')).toHaveLength(1);
  await f.grant(read);
  expect((await factories()).status).toBe(403);
  expect(f.writes).toEqual([]);
});

it('requests the smallest population sample until markers are opened and fences the selected world and process', async () => {
  const f = await fixture();
  await f.grant(read);
  await f.power('running');
  const processRef = await f.ref();
  const path = `/creatures?processRef=${processRef}&world=earth`;
  const counts = await (await f.request(path)).json();
  expect(counts).toMatchObject({
    total: 300,
    items: 7,
    species: [{ name: 'Fox', count: 300 }],
    markers: [],
    markersTruncated: false,
  });
  expect(await (await f.request(`${path}&markers=1`)).json()).toMatchObject({
    markers: [{ species: 11, face: 1, x: 112, z: 48 }],
    markersTruncated: true,
  });
  await f.request(path);
  expect((await f.request(`${path}&markers=true`)).status).toBe(400);
  expect((await f.request(`/creatures?processRef=${processRef}&world=unlisted`)).status).toBe(404);
  expect((await f.request(`/creatures?world=earth&processRef=${'0'.repeat(64)}`)).status).toBe(409);
  expect(f.creatureLimits).toEqual(['1', '256']);
  expect(f.writes).toEqual([]);
});

it('filters a shared orbital snapshot for the current reader, including a revocation during the native read', async () => {
  const f = await fixture();
  await f.power('running');
  const path = `/space?processRef=${await f.ref()}`;
  const roster = 'game.openworld.players.read',
    inspect = 'game.openworld.players.inspect';
  const full = await (await f.request(path, undefined, 'owner')).json();
  expect(full.players).toEqual([{ id: 2, name: 'Ada', world: null, position: [1, 2, 3] }]);
  expect(full.checkpoints.map((c: { name: string }) => c.name)).toEqual(['Refuge', 'Public']);
  expect(JSON.stringify(full)).not.toMatch(/private notes|private owner IP|internal|Unknown/);
  for (const permissions of [[read], [read, roster], [read, inspect]]) {
    await f.grant(...permissions);
    const limited = await (await f.request(path)).json();
    expect(limited).toMatchObject({
      bodies: [{ name: 'Earth' }],
      players: [],
      checkpoints: [{ name: 'Public' }],
    });
  }
  expect(f.reads.filter((r) => r === 'space')).toHaveLength(4);
  await f.grant(read, roster, inspect, manage);
  f.state.clock += 5000;
  const enter = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.state.onRead = async (resource) => {
    if (resource === 'space') {
      enter.resolve();
      await release.promise;
    }
  };
  const pending = f.request(path);
  await enter.promise;
  const owner = f.request(path, undefined, 'owner');
  await f.grant(read, roster);
  release.resolve();
  expect(await (await pending).json()).toMatchObject({
    players: [],
    checkpoints: [{ name: 'Public' }],
  });
  expect((await (await owner).json()).players).toEqual(full.players);
  expect(f.reads.filter((r) => r === 'space')).toHaveLength(5);
  await f.grant(roster, inspect, manage);
  expect((await f.request(path)).status).toBe(403);
  expect(f.writes).toEqual([]);
});

it('refreshes orbital checkpoint visibility immediately after an edit on a separate API process', async () => {
  const f = await fixture();
  await f.power('running');
  await f.grant(read);
  f.state.checkpoint.visibility = 'players';
  const processRef = await f.ref();
  const orbital = `/space?processRef=${processRef}`;
  const mapRead = await f.request(
    `/checkpoints?world=earth&processRef=${processRef}`,
    undefined,
    'owner',
  );
  const [checkpoint] = (await mapRead.json()).checkpoints;
  expect((await (await f.request(orbital)).json()).checkpoints).toHaveLength(2);
  f.state.onWrite = () => {
    f.state.checkpoint.visibility = 'admins';
    return Response.json(f.state.checkpoint);
  };
  const change = await f.router()(
    '/checkpoints',
    {
      world: 'earth',
      processRef,
      requestId: randomUUID(),
      action: { kind: 'update', id: checkpoint.id, revision: checkpoint.revision, fields },
    },
    'owner',
  );
  expect(change.ok).toBe(true);
  expect(
    (await (await f.request(orbital)).json()).checkpoints.map((row: { name: string }) => row.name),
  ).toEqual(['Public']);
  expect(f.reads.filter((r) => r === 'space')).toHaveLength(2);
});
