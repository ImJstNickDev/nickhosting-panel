import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createOpenworldWorldMap } from '../../../packages/server-management/src/openworld-world-map.js';
import { openworldInstance } from '../tests/openworld-instance.js';
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
  const { owner, sub, id, grant, power, target } = await openworldInstance(db);
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
    asset: undefined as ((url: URL) => Response | undefined) | undefined,
    afterScopeQuery: undefined as (() => void) | undefined,
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
      resource = remote.pathname.replace(/^\/api\/live\//, '');
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
    const asset = state.asset?.(remote);
    if (asset) return asset;
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
      createOpenworldWorldMap({
        db: db.withPlugin({
          transformQuery: ({ node }) => node,
          async transformResult({ result }) {
            state.afterScopeQuery?.();
            return result;
          },
        }),
        target,
        fetcher,
        now: () => state.clock,
      }),
    );
    return (
      path: string,
      body?: unknown,
      as: 'owner' | 'sub' = 'sub',
      area: 'map' | 'factories' = 'map',
      signal?: AbortSignal,
    ) =>
      app.request(`/v1/servers/${id}/openworld/${area}${path}`, {
        headers: { 'content-type': 'application/json', 'X-Reader': as },
        method: body ? 'POST' : 'GET',
        body: body ? JSON.stringify(body) : undefined,
        signal,
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
  // Both readers must have started their authorized read before the sample finishes.
  const secondScope = Promise.withResolvers<void>();
  f.state.afterScopeQuery = secondScope.resolve;
  const owner = f.request(path, undefined, 'owner');
  await secondScope.promise;
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

function atlasCatalog() {
  return {
    planet: 'earth',
    planets: [{ key: 'earth' }],
    seed: 'fixture-secret',
    fixedSeed: true,
    version: 32,
    seedScheme: 1,
    faceEdgeMeters: 8000,
    fullChunkMeters: 16,
    voxelSize: 0.25,
    tileSize: 256,
    maxZoom: 15,
    materials: [{ id: 1, key: 'stone', color: '#808080', texture: '/pack/stone.png' }],
    biomes: [{ id: 1, name: 'Grassland', color: '#77aa44' }],
    featureKinds: [
      { key: 'ore_vein', name: 'Ore', color: '#aabbcc', category: 'deposit', cellMeters: 12 },
    ],
  };
}
function atlasTile(x = 0, y = 0, z = 7) {
  const side = 256,
    pixels = side ** 2,
    data = new Uint8Array(32 + 16 * pixels),
    view = new DataView(data.buffer);
  const span = 8000 / 2 ** z;
  view.setUint32(0, 0x4f575431);
  view.setUint16(4, side, true);
  view.setFloat64(8, x * span, true);
  view.setFloat64(16, y * span, true);
  view.setFloat32(24, span / side, true);
  view.setInt16(32, 1400, true);
  view.setInt16(32 + 2 * pixels, -32768, true);
  data.fill(77, 32 + 8 * pixels);
  return new Response(data);
}
it('streams scoped native geometry, honours its stamp and invalidates only touched columns', async () => {
  const f = await fixture();
  await f.grant(read);
  await f.power('running');
  const q = `?world=earth&processRef=${await f.ref()}&face=0`;
  const mesh = (i: number, j: number) => `/mesh${q}&i=${i}&j=${j}&lod=1&stamp=10`;
  const surface = `/terrain${q}&ci=0&cj=0&n=2&lod=2&stamp=10`;
  let wrongFace = false,
    serial = 1;
  f.state.asset = (url) => {
    const p = url.searchParams,
      n = Number(p.get('n')),
      lod = Number(p.get('lod'));
    if (url.pathname === '/api/live/map/surface') {
      const bytes = new Uint8Array(32 + 4 * n * n),
        v = new DataView(bytes.buffer);
      v.setUint32(0, 0x4f574d53);
      v.setUint16(4, 2, true);
      v.setUint16(6, lod, true);
      v.setUint16(20, n, true);
      v.setUint16(22, 64 >> lod, true);
      return new Response(bytes);
    }
    if (url.pathname === '/api/live/map/mesh') {
      const data = new Uint8Array(48),
        v = new DataView(data.buffer);
      v.setUint32(0, 0x4f574d31);
      v.setUint32(4, 1, true);
      v.setInt32(8, wrongFace ? 5 : 0, true);
      v.setInt32(12, Number(p.get('i')), true);
      v.setInt32(16, Number(p.get('j')), true);
      v.setUint16(20, lod, true);
      data[35] = serial++;
      return new Response(data);
    }
  };
  const results = await Promise.all([
    f.request(mesh(4, 3)),
    f.request(mesh(4, 3)),
    f.request(mesh(5, 3)),
  ]);
  for (const res of results) {
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  }
  expect(f.reads.filter((x) => x === 'map/mesh')).toHaveLength(2);
  expect((await f.request(surface)).status).toBe(200);
  expect((await f.request(surface.replace('ci=0', 'ci=1'))).status).toBe(400);
  expect((await f.request(surface.replace('n=2&lod=2', 'n=32&lod=0'))).status).toBe(400);
  expect((await f.request(mesh(4, 3).replace('lod=1', 'lod=3'))).status).toBe(400);
  await f.request(`/changes?world=earth&processRef=${await f.ref()}&since=30`);
  await Promise.all([f.request(mesh(4, 3)), f.request(mesh(5, 3))]);
  expect(f.reads.filter((x) => x === 'map/mesh')).toHaveLength(3);
  wrongFace = true;
  expect(await (await f.request(mesh(8, 3))).json()).toEqual({ error: 'integration_unavailable' });
  await f.grant(manage);
  expect((await f.request(mesh(4, 3))).status).toBe(403);
});

it('shares native capacity across terrain and mesh routes, drops queued cancellations and checks a changed private binding before dispatch', async () => {
  const f = await fixture();
  await f.power('running');
  await f.grant(read);
  const q = `?world=earth&face=0&processRef=${await f.ref()}`;
  const mesh = (i: number) => `/mesh${q}&i=${i}&j=0&lod=1`;
  const terrain = `/terrain${q}&ci=0&cj=0&n=2&lod=5`;
  f.state.asset = (url) => {
    if (url.pathname.endsWith('/map/mesh') || url.pathname.endsWith('/map/surface'))
      return new Response(null, { status: 504 });
  };
  for (const path of [terrain, mesh(0), `/meshes${q}&lod=1&cells=0,0`, terrain]) {
    const failed = await f.request(path);
    expect(failed.status).toBe(504);
    expect(await failed.json()).toEqual({ error: 'game_request_timeout' });
  }
  expect(f.reads.filter((r) => r === 'map/surface')).toHaveLength(2);
  f.state.asset = () => new Response(null, { status: 503 });
  expect((await f.request(terrain)).status).toBe(503);
  f.state.asset = () => new Response(null, { status: 404 });
  const busy = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let sent = 0;
  f.state.onRead = async (resource) => {
    if (resource === 'map/mesh' || resource === 'map/surface') {
      if (++sent === 3) busy.resolve();
      await release.promise;
    }
  };
  const inFlight = [terrain, mesh(1), mesh(2)].map((path) => f.request(path));
  await busy.promise;
  const enqueue = async (i: number, signal?: AbortSignal) => {
    const checked = Promise.withResolvers<void>();
    f.state.afterScopeQuery = checked.resolve;
    const response = f.request(mesh(i), undefined, 'sub', 'map', signal);
    await checked.promise;
    f.state.afterScopeQuery = undefined;
    await new Promise<void>((done) => setImmediate(done));
    return { response };
  };
  const abort = new AbortController();
  const abandoned = await enqueue(3, abort.signal);
  abort.abort();
  expect(await (await abandoned.response).json()).toEqual({ error: 'game_not_ready' });
  const waiting = await enqueue(4);
  await f.db
    .updateTable('managed_servers')
    .set({ pterodactyl_uuid: randomUUID() })
    .where('id', '=', f.id)
    .execute();
  release.resolve();
  for (const response of await Promise.all([...inFlight, waiting.response])) {
    expect(await response.json()).toEqual({ error: 'provenance_mismatch' });
  }
  expect(sent).toBe(3);
});

it('requires both grants for seed overlays, binds the generation arguments and returns only the filtered data', async () => {
  const f = await fixture();
  await f.power('running');
  const q = `?world=earth&processRef=${await f.ref()}`;
  const tile = `/seed-tile${q}&face=3&x=0&y=0&z=7`,
    legend = `/seed-legend${q}`;
  let bound = 'earth';
  let fixed = true;
  f.state.asset = (u) => {
    if (u.pathname === '/api/info')
      return Response.json({ ...atlasCatalog(), planet: bound, fixedSeed: fixed });
    if (u.pathname === '/api/tile') {
      expect([...u.searchParams.entries()].sort()).toEqual(
        Object.entries({
          planet: 'earth',
          seed: 'fixture-secret',
          face: '3',
          x: '0',
          y: '0',
          z: '7',
        }).sort(),
      );
      return atlasTile();
    }
    if (u.pathname === '/api/features')
      return Response.json({
        features: [
          { kind: 'ore_vein', x: 1, y: 2, z: 4, seed: 'PRIVATE' },
          { kind: 'ore_vein', x: 500, y: 0, z: 0 },
        ],
        truncated: false,
      });
    if (u.pathname === '/pack/stone.png') return new Response(null, { status: 404 });
  };
  const seed = 'game.openworld.seed.inspect';
  for (const grants of [[seed], [read]]) {
    await f.grant(...grants);
    expect((await f.request(tile)).status).toBe(403);
    expect((await f.request(legend)).status).toBe(403);
  }
  expect(f.reads).not.toContain('/api/info');
  const paint = await (await f.request(`/palette${q}`)).json();
  expect(paint.materials[0]).toMatchObject({ key: 'stone', textured: true });
  expect(JSON.stringify(paint)).not.toMatch(/fixture-secret|\/pack|Grassland/);
  expect((await f.request(`/texture${q}&id=1`)).status).toBe(204);
  expect((await f.request(`/texture${q}&id=1&path=%2Fapi%2Ftile`)).status).toBe(400);
  await f.grant(read, seed);
  expect((await f.request(`/seed-tile${q}&face=3&x=2&y=0&z=1`)).status).toBe(400);
  const native = await f.request(tile);
  expect(native.status).toBe(200);
  const buf = await native.arrayBuffer(),
    d = new DataView(buf);
  expect(buf.byteLength).toBe(32 + 8 * 256 ** 2);
  expect(d.getUint32(0)).toBe(0x4e485354);
  expect(d.getInt16(32, true)).toBe(1400);
  expect(d.getInt16(32 + 2 * 256 ** 2, true)).toBe(-32768);
  const catalog = await (await f.request(legend)).json();
  expect(catalog.biomes[0].name).toBe('Grassland');
  expect(catalog.featureKinds[0].key).toBe('ore_vein');
  expect(catalog).not.toHaveProperty('seed');
  const features = `${tile.replace('seed-tile', 'seed-features')}&kind=ore_vein`;
  expect(await (await f.request(features)).json()).toEqual({
    features: [{ kind: 'ore_vein', x: 1, y: 2, z: 4 }],
    truncated: false,
  });
  expect((await f.request(features.replace('z=7', 'z=0'))).status).toBe(400);
  expect((await f.request(features.replace('ore_vein', 'unknown'))).status).toBe(400);
  expect(f.reads.filter((x) => x === '/api/features')).toHaveLength(1);
  bound = 'moon';
  expect(await (await f.router()(tile)).json()).toEqual({ error: 'game_request_unsupported' });
  fixed = false;
  bound = 'earth';
  expect(await (await f.router()(tile)).json()).toEqual({ error: 'game_request_unsupported' });
  expect(f.reads.filter((x) => x === '/api/tile')).toHaveLength(1);
});

it('rechecks a seed grant after a flight, bounds generator work across API processes, and reuses the local result', async () => {
  const f = await fixture();
  await f.power('running');
  await f.grant(read, 'game.openworld.seed.inspect');
  const q = `?world=earth&processRef=${await f.ref()}`;
  const tile = (x: number) => `/seed-tile${q}&face=0&z=7&y=0&x=${x}`;
  const other = f.router();
  f.state.asset = (u) =>
    u.pathname === '/api/info'
      ? Response.json(atlasCatalog())
      : u.pathname === '/api/tile'
        ? atlasTile(Number(u.searchParams.get('x')))
        : undefined;
  await f.request(`/seed-legend${q}`);
  await other(`/seed-legend${q}`);
  const first = Promise.withResolvers<void>(),
    both = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  let running = 0;
  f.state.onRead = async (path) => {
    if (path !== '/api/tile') return;
    running++;
    if (running === 1) first.resolve();
    if (running === 2) both.resolve();
    await resume.promise;
  };
  const a = f.request(tile(0));
  await first.promise;
  try {
    expect((await other(tile(0))).status).toBe(429);
    const b = other(tile(1));
    await both.promise;
    const busy = await f.request(tile(2));
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('1');
    await f.grant(read);
    resume.resolve();
    expect((await a).status).toBe(403);
    expect((await b).status).toBe(403);
    expect((await f.request(tile(0))).status).toBe(403);
    expect((await f.request(tile(0), undefined, 'owner')).status).toBe(200);
    expect(f.reads.filter((x) => x === '/api/tile')).toHaveLength(2);
  } finally {
    resume.resolve();
  }
});

it('shares cached mesh reads between bounded NHMB frames and single columns, preserving order, holes and the current grant', async () => {
  const f = await fixture();
  await f.power('running');
  await f.grant(read);
  const q = `?world=earth&face=0&lod=1&stamp=1&processRef=${await f.ref()}`;
  const group = (cells: string) => `/meshes${q}&cells=${encodeURIComponent(cells)}`;
  f.state.asset = (u) => {
    if (u.pathname !== '/api/live/map/mesh') return;
    const i = Number(u.searchParams.get('i')),
      j = Number(u.searchParams.get('j'));
    if (i === 5) return new Response(null, { status: 404 });
    const d = new Uint8Array(32),
      v = new DataView(d.buffer);
    v.setUint32(0, 0x4f574d31);
    v.setInt32(12, i, true);
    v.setInt32(16, j, true);
    v.setUint16(20, 1, true);
    return new Response(d);
  };
  for (const cells of [
    '',
    '1,1;1,1',
    '-1,2',
    '0,2147483648',
    '0,1,4',
    Array.from({ length: 17 }, (_, i) => `${i},0`).join(';'),
  ]) {
    expect((await f.request(group(cells))).status).toBe(400);
  }
  expect(f.reads.filter((x) => x === 'map/mesh')).toHaveLength(0);
  await f.request(`/mesh${q}&i=4&j=3`);
  const result = await f.request(group('5,2;4,3;2,1'));
  const buf = await result.arrayBuffer(),
    v = new DataView(buf);
  expect(result.status).toBe(200);
  expect(result.headers.get('content-length')).toBe(String(buf.byteLength));
  expect(v.getUint32(0)).toBe(0x4e484d42);
  expect(v.getUint16(4, true)).toBe(1);
  expect(v.getUint16(6, true)).toBe(3);
  let off = 8;
  for (const [i, j, len] of [
    [5, 2, 0],
    [4, 3, 32],
    [2, 1, 32],
  ] as const) {
    expect([v.getInt32(off, true), v.getInt32(off + 4, true), v.getUint32(off + 8, true)]).toEqual([
      i,
      j,
      len,
    ]);
    off += 12;
    if (len) {
      expect(v.getUint32(off)).toBe(0x4f574d31);
      off += len;
    }
  }
  expect(off).toBe(buf.byteLength);
  expect((await f.request(`/mesh${q}&i=2&j=1`)).status).toBe(200);
  expect(f.reads.filter((x) => x === 'map/mesh')).toHaveLength(3);
  const started = Promise.withResolvers<void>(),
    done = Promise.withResolvers<void>();
  let pending = 0;
  f.state.onRead = async (path) => {
    if (path === 'map/mesh') {
      pending++;
      if (pending === 3) started.resolve();
      await done.promise;
    }
  };
  const batch = f.request(group('6,0;7,0;8,0;9,0;10,0;11,0'));
  await started.promise;
  expect(pending).toBe(3);
  await f.grant(manage);
  done.resolve();
  expect((await batch).status).toBe(403);
  expect((await f.request(group('5,2;4,3;2,1'))).status).toBe(403);
});
