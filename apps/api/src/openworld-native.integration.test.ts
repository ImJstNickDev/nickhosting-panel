import { randomBytes, randomUUID } from 'node:crypto';
import type { Identity } from '@nickhosting/auth';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ManagementRuntime } from '@nickhosting/server-management';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { openworldInstance, openworldNativeProvider } from '../tests/openworld-instance.js';
import { createApp } from './app.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await database?.destroy();
});

async function fixture() {
  const instance = await openworldInstance(database.db);
  const provider = await openworldNativeProvider(database.db, instance);
  await instance.power('running');
  const state = {
    token: 'session-1',
    beforeReply: undefined as ((path: string) => Promise<void>) | undefined,
  };
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    const { origin, pathname } = new URL(String(input));
    if (origin !== provider.origin) throw new Error('Unexpected native origin');
    const path = pathname.replace('/api/live/', '');
    calls.push(path);
    await state.beforeReply?.(path);
    if (path === 'auth') return Response.json({ required: true, loopback: false, canAct: false });
    if (path === 'login' && JSON.parse(String(init?.body)).password === provider.password)
      return Response.json({ token: state.token });
    if (path === '/api/info') {
      expect(new Headers(init?.headers).has('X-OW-Token')).toBe(false);
      return new Response(null, { status: 404 });
    }
    if (new Headers(init?.headers).get('X-OW-Token') !== state.token)
      return new Response(null, { status: 401 });
    switch (path) {
      case 'status':
        return Response.json({
          tps: 20,
          players: { online: 1, slots: 8 },
          memory: { rssMB: 48 },
          tick: 1234,
        });
      case 'players':
        return Response.json({
          players: [{ id: 7, name: 'Ada', account: 'private-account', accountVerified: true }],
        });
      case 'chunks':
        return Response.json({
          worlds: [{ key: 'earth', name: 'Earth', faceEdgeMeters: 8000 }],
          hot: [],
        });
      case 'checkpoints':
        return Response.json({ checkpoints: [] });
      case 'console':
        return new Response(null, { status: 404 });
      case 'screenshots':
        return Response.json({ files: [] });
      default:
        throw new Error('Unexpected native path');
    }
  });
  const runtime: Pick<ManagementRuntime, 'adapter' | 'fileReadScope'> = {
    adapter: provider.adapter,
    fileReadScope: async () => {
      throw new Error('Optional rule files unavailable');
    },
  };
  const management = vi.fn(async () => runtime as ManagementRuntime);
  const app = createApp({
    database,
    management,
    identity: async () =>
      ({
        authenticate: async (headers: Headers) => ({
          context: headers.has('x-sub') ? instance.sub.context : instance.owner.context,
          sessionId: 'fixture',
          locale: 'en',
        }),
      }) as Identity,
    origins: [],
    codec: new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } }),
  });
  const request = (path: string, asSub = false) =>
    app.request(`/v1/servers/${instance.id}/openworld/${path}`, {
      headers: asSub ? { 'x-sub': '1' } : {},
    });
  return { ...instance, state, calls, provider, management, request };
}

it('reuses one verified session from overview to players, map and back while applying each current grant', async () => {
  const f = await fixture();
  const overview = await f.request('telemetry/status');
  expect(await overview.json()).toMatchObject({ source: 'live', data: { tps: 20 } });
  const players = await f.request('telemetry/players');
  expect(await players.json()).toMatchObject({
    data: { players: [{ account: 'private-account' }] },
  });
  await f.grant('game.openworld.map.read');
  const { worlds, processRef } = await (await f.request('map', true)).json();
  expect(worlds).toMatchObject([{ key: 'earth' }]);
  expect((await f.request('telemetry/players', true)).status).toBe(403);
  await f.grant('game.openworld.players.read');
  const roster = await (await f.request('telemetry/players', true)).json();
  expect(roster).toMatchObject({ source: 'live', data: { players: [{ id: 7, name: 'Ada' }] } });
  expect(roster.data.players[0]).not.toHaveProperty('account');
  expect((await f.request(`map/players?processRef=${processRef}`, true)).status).toBe(403);
  expect((await f.request('players/destinations', true)).status).toBe(403);
  expect((await f.request('screenshots', true)).status).toBe(403);
  expect((await f.request('seed', true)).status).toBe(403);
  expect((await f.request('rules', true)).status).toBe(403);
  expect((await f.request('telemetry/status', true)).status).toBe(403);
  expect((await f.request('dashboard/status', true)).status).toBe(403);
  expect(f.calls).toEqual(['auth', 'login', 'status', 'players', 'chunks']);
  for (const grant of ['settings.read', 'game.openworld.dashboard.admin']) {
    await f.grant(grant);
    expect(await (await f.request('dashboard/status', true)).json()).toEqual({
      tps: 20,
      players: { online: 1, slots: 8 },
      memory: { rssMB: 48 },
    });
    expect((await f.request('telemetry/status', true)).status).toBe(403);
  }
  expect(await (await f.request('players/destinations')).json()).toMatchObject({
    worlds: [{ key: 'earth' }],
  });
  expect(await (await f.request('screenshots')).json()).toMatchObject({ files: [] });
  expect(f.management).toHaveBeenCalledTimes(1);
  expect(f.provider.fetcher).toHaveBeenCalledTimes(1);
  expect(f.calls.filter((path) => path === 'login')).toHaveLength(1);
});

it('reuses the same verification for a gallery thumbnail and for seed and rules capability checks', async () => {
  const f = await fixture();
  expect((await f.request('telemetry/status')).status).toBe(200);
  const thumbnail = await f.request('screenshots/thumbnail?name=missing.png&bytes=8&mtimeMs=2');
  expect(thumbnail.status).toBe(404);
  for (const section of ['seed', 'rules']) {
    const result = await f.request(section);
    expect(await result.json()).toMatchObject({ error: { code: 'game_request_unsupported' } });
  }
  expect(f.calls).toEqual(['auth', 'login', 'status', 'screenshots', '/api/info', 'console']);
  expect(f.provider.fetcher).toHaveBeenCalledTimes(1);
});

it('coalesces cold cross-section requests, rejects an old process reference and refreshes once after restart', async () => {
  const f = await fixture();
  const [overview, map, roster, dashboard] = await Promise.all([
    f.request('telemetry/status'),
    f.request('map'),
    f.request('telemetry/players'),
    f.request('dashboard/status'),
  ]);
  expect([overview.status, map.status, roster.status, dashboard.status]).toEqual([
    200, 200, 200, 200,
  ]);
  const { processRef } = await map.json();
  expect(processRef).toMatch(/^[0-9a-f]{64}$/);
  expect(f.provider.fetcher).toHaveBeenCalledTimes(1);
  await database.db
    .insertInto('gateway_server_states')
    .values({
      server_id: f.id,
      generation: randomUUID(),
      enabled: true,
      protocol_id: 'openworld',
      game_version: 'a1.2.9',
      state: 'online',
      readiness_timeout_seconds: 90,
      readiness_max_age_seconds: 10,
      estimate_max_age_seconds: 120,
      wake_retry_seconds: 10,
      process_started_at: new Date().toISOString(),
    })
    .onConflict((c) =>
      c.column('server_id').doUpdateSet({ process_started_at: new Date().toISOString() }),
    )
    .execute();
  f.state.token = 'session-2';
  expect((await f.request(`map/players?processRef=${processRef}`)).status).toBe(409);
  expect(f.provider.fetcher).toHaveBeenCalledTimes(1);
  const responses = await Promise.all([
    f.request('screenshots'),
    f.request('map'),
    f.request('telemetry/status'),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  expect((await responses[1].json()).processRef).not.toBe(processRef);
  expect(f.provider.fetcher).toHaveBeenCalledTimes(2);
  expect(f.calls.filter((path) => path === 'auth')).toHaveLength(2);
  expect(f.calls.filter((path) => path === 'login')).toHaveLength(2);
});

it.each([
  { path: 'map', upstream: 'chunks', grant: 'game.openworld.map.read' },
  { path: 'dashboard/status', upstream: 'status', grant: 'settings.read' },
])(
  'rechecks the $path viewer after revocation while another route uses the session',
  async ({ path, upstream, grant }) => {
    const f = await fixture();
    await f.grant(grant);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.state.beforeReply = async (resource) => {
      if (resource === upstream) {
        entered.resolve();
        await release.promise;
      }
    };
    const pending = f.request(path, true);
    await entered.promise;
    try {
      expect((await f.request('telemetry/players')).status).toBe(200);
      await f.grant('game.openworld.players.read');
    } finally {
      release.resolve();
    }
    expect((await pending).status).toBe(403);
    expect(f.provider.fetcher).toHaveBeenCalledTimes(1);
    expect(f.calls.filter((path) => path === 'login')).toHaveLength(1);
  },
);

it('recovers at the original provider deadline when map first sees a 429 already observed by telemetry', async () => {
  const realNow = Date.now;
  let now: number | undefined;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now ?? realNow());
  try {
    const f = await fixture();
    now = realNow();
    f.provider.fetcher.mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: { 'Retry-After': '10' },
      }),
    );
    expect(await (await f.request('telemetry/status')).json()).toMatchObject({
      source: 'unavailable',
    });
    now += 8100;
    const map = await f.request('map');
    expect(map.status).toBe(429);
    expect(map.headers.get('Retry-After')).toBe('2');
    now += 1700;
    const seed = await f.request('seed');
    expect(seed.status).toBe(429);
    expect(seed.headers.get('Retry-After')).toBe('1');
    const dashboard = await f.request('dashboard/status');
    expect(dashboard.status).toBe(429);
    expect(dashboard.headers.get('Retry-After')).toBe('1');
    expect((await f.request('map')).headers.get('Retry-After')).toBe('1');
    expect(f.provider.fetcher).toHaveBeenCalledTimes(1);
    now += 200;
    expect((await f.request('map')).status).toBe(200);
    expect(f.provider.fetcher).toHaveBeenCalledTimes(2);
    expect(f.calls.filter((path) => path === 'login')).toHaveLength(1);
  } finally {
    clock.mockRestore();
  }
});
