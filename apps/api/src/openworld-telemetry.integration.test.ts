import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { Hono } from 'hono';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import {
  claimOpenworldCaptureScans,
  createOpenworldCaptureCollector,
} from '../../../packages/server-management/src/openworld-capture-index.js';
import { createOpenworldPlayerActions } from '../../../packages/server-management/src/openworld-player-actions.js';
import { createOpenworldPlayerChannel } from '../../../packages/server-management/src/openworld-player-channel.js';
import { createOpenworldPlayerDirectory } from '../../../packages/server-management/src/openworld-player-directory.js';
import { createOpenworldSkinCollector } from '../../../packages/server-management/src/openworld-player-skins.js';
import {
  createOpenworldTelemetry,
  readOpenworldScope,
} from '../../../packages/server-management/src/openworld-telemetry.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerOpenworldPlayerActionRoutes } from './openworld-player-actions.js';
import { registerOpenworldPlayerDirectoryRoutes } from './openworld-player-directory.js';
import { registerOpenworldThumbnailRoute } from './openworld-screenshot-thumbnails.js';
import { registerOpenworldScreenshotRoutes } from './openworld-screenshots.js';
import { registerOpenworldTelemetryRoutes } from './openworld-telemetry.js';

const capturePng = Uint8Array.from(PNG.sync.write(new PNG({ width: 7, height: 5 })));
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

async function fixture(capture?: (url: URL) => Response | undefined) {
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
    now: Date.now(),
    name: 'Ada',
    connectedS: 90,
    serviceDown: false,
    token: 'fixture1',
    invalidLogin: false,
    beforeReply: undefined as ((resource: string) => Promise<void>) | undefined,
    empty: false,
    actionResult: undefined as (() => Response | Promise<Response>) | undefined,
  };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const resource = url.pathname.split('/').at(-1);
    if (!resource || url.origin !== `http://${admin.backend_address}:${admin.port}`)
      throw new Error('unexpected upstream');
    calls.push(resource);
    await state.beforeReply?.(resource);
    const supplied = capture?.(url);
    if (supplied) return supplied;
    if (resource === 'auth')
      return Response.json({ required: true, loopback: false, canAct: false });
    if (resource === 'login')
      return Response.json(state.invalidLogin ? {} : { token: state.token });
    if (new Headers(init?.headers).get('X-OW-Token') !== state.token)
      return new Response(null, { status: 401 });
    if (state.serviceDown) return new Response(null, { status: 503 });
    if (url.pathname.startsWith('/api/live/player/') && init?.method === 'POST')
      return state.actionResult ? state.actionResult() : Response.json({ ok: true });
    if (resource === 'checkpoints')
      return Response.json({
        checkpoints: [{ id: 2, world: 'earth', name: 'Base', note: 'private' }],
      });
    const player = {
      id: 7,
      name: state.name,
      connectedS: state.connectedS,
      skinHash: '12ab34cd',
      address: 'private-socket',
      account: 'private-account',
      accountVerified: true,
      heldItem: { name: 'Iron sword', count: 1 },
      client: { fps: 63 },
      geo: { lat: 10 },
      inventory: { hotbar: [], bag: [] },
      record: { joins: 2 },
      screenshots: ['private-capture'],
    };
    if (resource === 'players') return Response.json({ players: state.empty ? [] : [player] });
    if (resource === 'player')
      return state.empty ? new Response(null, { status: 404 }) : Response.json(player);
    if (resource === 'screenshots')
      return Response.json({
        files: [{ name: 'conn7-fixture.png', mtimeMs: 100, bytes: capturePng.byteLength }],
      });
    if (resource === 'screenshot')
      return new Response(capturePng, { headers: { 'content-type': 'image/png' } });
    if (resource === 'skin') {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOgeONsAAAAASUVORK5CYII=',
        'base64',
      );
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    }
    if (resource === 'status')
      return Response.json({ players: { online: state.empty ? 0 : 1, slots: 9 }, tps: 30 });
    if (resource === 'history') return Response.json({ t: [1], tps: [30] });
    if (resource === 'chunks') return Response.json({ hot: [], worlds: [] });
    if (resource === 'storage') return Response.json({ parts: [], worlds: [], totalBytes: 200 });
    throw new Error('unplanned native API request');
  };
  const appWithErrors = () => {
    const app = new Hono<{ Variables: Variables }>();
    app.onError((e, c) =>
      c.json(
        { error: e instanceof DomainError ? e.code : 'internal_error' },
        e instanceof DomainError ? (e.status as 400) : 500,
      ),
    );
    return app;
  };
  const router = () => {
    const app = appWithErrors();
    registerOpenworldTelemetryRoutes(
      app,
      {
        db,
        principal: async (c) => (c.req.header('x-reader') === 'sub' ? sub.context : owner.context),
      },
      createOpenworldTelemetry({ db, now: () => state.now, target, fetcher }),
    );
    return (path: string, reader: 'sub' | 'owner' = 'owner') =>
      app.request(`/v1/servers/${id}/openworld/telemetry/${path}`, {
        headers: { 'x-reader': reader },
      });
  };
  const actionRouter = () => {
    const app = appWithErrors();
    registerOpenworldPlayerActionRoutes(
      app,
      {
        db,
        principal: async (c) => (c.req.header('x-reader') === 'sub' ? sub.context : owner.context),
      },
      createOpenworldPlayerActions({ db, now: () => state.now, target, fetcher }),
    );
    return (body?: unknown, reader = 'sub') =>
      app.request(`/v1/servers/${id}/openworld/players/${body ? 'actions' : 'destinations'}`, {
        method: body ? 'POST' : 'GET',
        body: body ? JSON.stringify(body) : undefined,
        headers: { 'content-type': 'application/json', 'x-reader': reader },
      });
  };
  const gallery = appWithErrors();
  registerOpenworldScreenshotRoutes(
    gallery,
    { db, principal: async () => sub.context },
    createOpenworldPlayerChannel({ db, now: () => state.now, target, fetcher }),
    fetcher,
  );
  registerOpenworldThumbnailRoute(
    gallery,
    { db, principal: async () => sub.context },
    createOpenworldPlayerChannel({ db, now: () => state.now, target, fetcher }),
    fetcher,
  );
  const galleryRead = (suffix = '') =>
    gallery.request(`/v1/servers/${id}/openworld/screenshots${suffix}`);
  return {
    id,
    db,
    principal: sub.context,
    grant,
    power,
    state,
    calls,
    target,
    request: router(),
    router,
    actionRouter,
    galleryRead,
    fetcher,
  };
}

it('uses current granular permissions even on cached data and never sends native credentials or raw player fields', async () => {
  const { grant, power, state, calls, target, request, router } = await fixture();
  await power('running');
  await grant('game.openworld.dashboard.admin', 'game.openworld.players.moderate');
  expect((await request('players', 'sub')).status).toBe(403);
  expect((await request('status', 'sub')).status).toBe(403);
  expect(target).not.toHaveBeenCalled();
  await grant('game.openworld.players.read');
  const replies = await Promise.all([
    request('players', 'sub'),
    request('players'),
    request('players', 'sub'),
  ]);
  for (const [index, res] of replies.entries()) {
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toEqual({
      source: 'live',
      processRef: expect.stringMatching(/^[a-f0-9]{64}$/),
      reason: null,
      gameVersion: 'a1.2.9',
      observedAt: new Date(state.now).toISOString(),
      data: {
        players: [
          {
            id: 7,
            name: 'Ada',
            connectedS: 90,
            skinHash: '12ab34cd',
            ...(index === 1 ? { account: 'private-account', accountVerified: true } : {}),
          },
        ],
      },
    });
  }
  expect(calls).toEqual(['auth', 'login', 'players']);
  await power('offline');
  const saved = await (await router()('players', 'sub')).json();
  expect(saved).toMatchObject({ source: 'snapshot', reason: 'offline' });
  expect(saved.data.players).toEqual([
    { id: 7, name: 'Ada', connectedS: 90, skinHash: '12ab34cd' },
  ]);
  await grant('game.openworld.players.read', 'game.openworld.players.inspect');
  expect((await (await router()('players', 'sub')).json()).data.players[0].account).toBe(
    'private-account',
  );
  await grant('game.openworld.players.read');
  await power('running');

  const selection = `name=Ada&joinedAt=${state.now - 90000}`;
  expect((await request(`players/7?${selection}`, 'sub')).status).toBe(403);
  const skin = `players/7/skin?${selection}&view=head&h=12ab34cd`;
  const image = await request(skin, 'sub');
  expect(image.status).toBe(200);
  expect(image.headers.get('content-type')).toBe('image/png');
  expect(image.headers.get('cache-control')).toContain('no-store');
  expect((await request(skin.replace('12ab34cd', 'ffffffff'), 'sub')).status).toBe(404);
  await grant('game.openworld.players.inspect');
  expect((await request(`players/7?${selection}`, 'sub')).status).toBe(403);
  expect((await request(skin, 'sub')).status).toBe(403);
  await grant('game.openworld.players.read', 'game.openworld.players.inspect');
  const selected = await (await request(`players/7?${selection}`, 'sub')).json();
  expect(selected.data).toMatchObject({
    id: 7,
    name: 'Ada',
    accountVerified: true,
    heldItem: { name: 'Iron sword', count: 1 },
    client: { fps: 63 },
    inventory: { bag: [], hotbar: [] },
    geo: { lat: 10 },
    record: { joins: 2 },
  });
  expect(selected.data).not.toHaveProperty('address');
  expect(selected.data).not.toHaveProperty('screenshots');
  expect((await request('players/99999999999?name=Ada', 'sub')).status).toBe(400);
  expect((await request('players/7', 'sub')).status).toBe(400);
  expect((await request('players/7/skin?name=Ada&h=http://invalid', 'sub')).status).toBe(400);
  state.now += 6000;
  state.connectedS = 1;
  expect((await request(`players/7?${selection}`, 'sub')).status).toBe(404);
  expect((await request(skin, 'sub')).status).toBe(404);
  state.now += 6000;
  state.name = 'Other';
  expect((await request('players/7?name=Ada', 'sub')).status).toBe(404);
  state.now += 6000;
  state.empty = true;
  expect((await request('players/7?name=Ada', 'sub')).status).toBe(404);
});

it('shares authentication across endpoints, renews once and recovers projected snapshots after an API restart without waking an instance', async () => {
  const { id, db, state, power, request, router, target, calls, grant } = await fixture();
  const neverObserved = await (await request('history')).json();
  expect(neverObserved).toEqual({
    source: 'unavailable',
    reason: 'offline',
    data: null,
    observedAt: null,
  });
  expect(target).not.toHaveBeenCalled();
  await power('running');
  await grant('game.openworld.performance.read');
  const resources = ['status', 'history', 'chunks', 'storage'];
  const responses = await Promise.all(resources.map((path) => request(path, 'sub')));
  for (const res of responses)
    expect(await res.json()).toMatchObject({
      source: 'live',
      observedAt: new Date(state.now).toISOString(),
    });
  expect(calls.filter((c) => c === 'login')).toHaveLength(1);
  expect(target).toHaveBeenCalledTimes(1);
  state.token = 'fixture2';
  state.now += 16000;
  await Promise.all(['status', 'history'].map((path) => request(path, 'sub')));
  expect(calls.filter((c) => c === 'login')).toHaveLength(2);
  state.empty = true;
  const empty = await (await request('players')).json();
  expect(empty).toMatchObject({ source: 'live', data: { players: [] } });
  const lastTime = state.now;
  state.now += 16000;
  state.serviceDown = true;
  const stale = await (await request('status', 'sub')).json();
  expect(stale).toMatchObject({
    source: 'snapshot',
    reason: 'not_ready',
    observedAt: new Date(lastTime).toISOString(),
    data: { players: { online: 1, slots: 9 } },
  });
  state.invalidLogin = true;
  expect(await (await router()('status', 'sub')).json()).toMatchObject({
    source: 'snapshot',
    reason: 'unreachable',
  });
  await power('offline');
  const count = calls.length;
  const freshRouter = router();
  const offline = await (await freshRouter('players')).json();
  expect(offline).toEqual({
    gameVersion: 'a1.2.9',
    data: empty.data,
    observedAt: empty.observedAt,
    source: 'snapshot',
    reason: 'offline',
  });
  expect(await (await freshRouter('players/7?name=Ada')).json()).toEqual({
    source: 'unavailable',
    reason: 'offline',
    data: null,
    observedAt: null,
  });
  expect((await freshRouter('players', 'sub')).status).toBe(403);
  await grant('game.openworld.players.read');
  expect((await freshRouter('status', 'sub')).status).toBe(403);
  const rows = await db
    .selectFrom('openworld_telemetry_snapshots')
    .select('resource')
    .where('server_id', '=', id)
    .execute();
  expect(rows.map((r) => r.resource).sort()).toEqual([
    'chunks',
    'history',
    'players',
    'status',
    'storage',
  ]);
  await db
    .updateTable('managed_servers')
    .set({ pterodactyl_uuid: randomUUID() })
    .where('id', '=', id)
    .execute();
  expect(await (await freshRouter('players')).json()).toEqual({
    gameVersion: 'a1.2.9',
    source: 'unavailable',
    reason: 'offline',
    data: null,
    observedAt: null,
  });
  expect(calls).toHaveLength(count);
});

it('invalidates cached proof when allocation claims change and respects a provider retry interval', async () => {
  const { id, db, power, state, target, request, calls } = await fixture();
  await power('running');
  expect(await (await request('status')).json()).toMatchObject({ source: 'live' });
  const game = await db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', id)
    .where('is_primary', '=', true)
    .executeTakeFirstOrThrow();
  await db
    .insertInto('server_allocations')
    .values({
      ...game,
      id: randomUUID(),
      pterodactyl_allocation_id: 918273,
      port: game.port + 2,
      role: 'auxiliary',
      direct_endpoint: null,
      is_primary: false,
    })
    .execute();
  target.mockRejectedValueOnce(
    new PterodactylError('rate_limited', 'application', 'rejected', 429, 25_000),
  );
  expect(await (await request('players')).json()).toMatchObject({
    source: 'unavailable',
    reason: 'unreachable',
  });
  state.now += 5000;
  expect(await (await request('status')).json()).toMatchObject({
    source: 'unavailable',
    reason: 'unreachable',
  });
  expect(target).toHaveBeenCalledTimes(2);
  expect(calls.filter((c) => c === 'status')).toHaveLength(1);
  state.now += 25000;
  expect(await (await request('status')).json()).toMatchObject({ source: 'live' });
  expect(target).toHaveBeenCalledTimes(3);
});

it('never uses the password when an instance is replaced at the same private origin during target resolution', async () => {
  const { id, db, target, power, request, calls } = await fixture();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const original = target.getMockImplementation();
  if (!original) throw new Error('missing target fixture');
  target.mockImplementationOnce(async () => {
    const verified = await original();
    entered.resolve();
    await gate.promise;
    return verified;
  });
  await power('running');
  const pending = request('status');
  await entered.promise;
  await db
    .updateTable('managed_servers')
    .set({ pterodactyl_uuid: randomUUID() })
    .where('id', '=', id)
    .execute();
  gate.resolve();
  expect(await (await pending).json()).toMatchObject({ error: 'provenance_mismatch' });
  expect(calls).toEqual([]);
});

it('discards observations spanning a stop and persists last-player departure within the write interval', async () => {
  const { state, power, request, router } = await fixture();
  await power('running');
  const live = await (await request('players')).json();
  state.now += 3000;
  state.empty = true;
  const left = await (await request('players')).json();
  expect(left).toMatchObject({ source: 'live', data: { players: [] } });
  expect(left.observedAt).not.toBe(live.observedAt);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  state.beforeReply = async (resource) => {
    if (resource === 'players') {
      entered.resolve();
      await gate.promise;
    }
  };
  state.now += 3000;
  state.empty = false;
  const pending = request('players');
  await entered.promise;
  await power('offline');
  gate.resolve();
  const snapshot = {
    gameVersion: 'a1.2.9',
    data: left.data,
    observedAt: left.observedAt,
    source: 'snapshot',
    reason: 'offline',
  };
  expect(await (await pending).json()).toEqual(snapshot);
  expect(await (await router()('players')).json()).toEqual(snapshot);
});

it('rechecks a pending reader grant without cancelling a different authorized reader', async () => {
  const { state, power, request, grant, calls } = await fixture();
  await power('running');
  await grant('game.openworld.players.read');
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  state.beforeReply = async (resource) => {
    if (resource === 'players') {
      entered.resolve();
      await gate.promise;
    }
  };
  const pending = request('players', 'sub');
  await entered.promise;
  const ownerRead = request('players');
  await grant('settings.read');
  gate.resolve();
  expect((await pending).status).toBe(403);
  expect(await (await ownerRead).json()).toMatchObject({ source: 'live' });
  expect(calls.filter((key) => key === 'players')).toHaveLength(1);
});

it('authorizes and records one native player action across concurrent attempts, retries and API restarts', async () => {
  const { id, db, grant, power, state, calls, request, actionRouter } = await fixture();
  await power('running');
  const action = actionRouter(),
    { processRef } = await (await request('players')).json();
  const input = {
    requestId: randomUUID(),
    processRef,
    player: { id: 7, name: 'Ada', joinedAt: state.now - 90_000 },
    action: { kind: 'message', text: 'Only to Ada' },
  };
  const read = 'game.openworld.players.read',
    moderate = 'game.openworld.players.moderate',
    shots = 'game.openworld.players.screenshots';
  await grant(read);
  expect((await action(input)).status).toBe(403);
  expect((await action()).status).toBe(403);
  await grant(read, moderate);
  const d = await (await action()).json();
  expect(d.checkpoints).toEqual([{ id: 2, name: 'Base', world: 'earth' }]);
  const screenshots = { ...input, requestId: randomUUID(), action: { kind: 'screenshot' } };
  expect((await action(screenshots)).status).toBe(403);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  state.actionResult = async () => {
    entered.resolve();
    await release.promise;
    return Response.json({ ok: true });
  };
  const first = action(input);
  await entered.promise;
  try {
    expect(await (await actionRouter()(input)).json()).toEqual({ error: 'operation_uncertain' });
  } finally {
    release.resolve();
  }
  expect((await first).status).toBe(202);
  expect((await actionRouter()(input)).status).toBe(202);
  expect((await action({ ...input, action: { kind: 'kill' } })).status).toBe(409);
  expect(calls.filter((c) => c === 'message')).toHaveLength(1);
  const receipt = await db
    .selectFrom('audit_events')
    .select(['actor_user_id', 'metadata'])
    .where('action', '=', 'server.openworld.player.action')
    .executeTakeFirstOrThrow();
  expect(receipt.metadata).toMatchObject({
    serverId: id,
    operationId: input.requestId,
    outcome: 'accepted',
    connectionId: 7,
    playerAction: 'message',
  });
  expect(JSON.stringify(receipt.metadata)).not.toContain('Only to Ada');
  await grant(read, shots);
  expect((await actionRouter()(input)).status).toBe(403);
  expect((await action(screenshots)).status).toBe(202);
  expect(calls.filter((c) => c === 'screenshot')).toHaveLength(1);
});

it('validates both sessions, current grants and process before acting, and never repeats an ambiguous send', async () => {
  const { grant, power, state, calls, request, actionRouter } = await fixture();
  await power('running');
  const read = 'game.openworld.players.read',
    moderate = 'game.openworld.players.moderate';
  await grant(read, moderate);
  const action = actionRouter(),
    { processRef } = await (await request('players')).json();
  const player = { id: 7, name: state.name, joinedAt: state.now - 90_000 };
  const input = {
    requestId: randomUUID(),
    processRef,
    player,
    action: { kind: 'kick', reason: 'Fixture' },
  };
  expect((await action({ ...input, processRef: 'a'.repeat(64) })).status).toBe(409);
  expect(
    (
      await action({
        ...input,
        requestId: randomUUID(),
        player: { ...player, name: 'Someone else' },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await action({
        ...input,
        requestId: randomUUID(),
        player: { ...player, joinedAt: state.now - 8000 },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await action({
        ...input,
        requestId: randomUUID(),
        action: { kind: 'teleport', destination: { type: 'player', player: { ...player, id: 8 } } },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await action({
        ...input,
        requestId: randomUUID(),
        action: { kind: 'teleport', destination: { type: 'checkpoint', id: 11 } },
      })
    ).status,
  ).toBe(404);
  expect(calls).not.toContain('kick');
  expect(calls).not.toContain('teleport');
  const during = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  state.beforeReply = async (r) => {
    if (r === 'players') {
      during.resolve();
      await release.promise;
    }
  };
  const blocked = action({ ...input, requestId: randomUUID() });
  await during.promise;
  await grant(read);
  release.resolve();
  expect((await blocked).status).toBe(403);
  expect(calls).not.toContain('kick');
  state.beforeReply = undefined;
  await grant(read, moderate);
  state.actionResult = () => {
    throw new TypeError('connection interrupted');
  };
  expect(await (await action(input)).json()).toEqual({ error: 'operation_uncertain' });
  expect(await (await actionRouter()(input)).json()).toEqual({ error: 'operation_uncertain' });
  expect(calls.filter((c) => c === 'kick')).toHaveLength(1);
  await power('offline');
  const count = calls.length;
  expect((await action({ ...input, requestId: randomUUID() })).status).toBe(409);
  expect(calls).toHaveLength(count);
});

it('isolates screenshot metadata and image bytes from inspection and moderation and denies revoked access', async () => {
  const { grant, power, calls, galleryRead } = await fixture();
  await power('running');
  const read = 'game.openworld.players.read',
    shots = 'game.openworld.players.screenshots';
  const image = '/image?name=conn7-fixture.png';
  const preview = `/thumbnail?name=conn7-fixture.png&mtimeMs=100&bytes=${capturePng.byteLength}`;
  for (const keys of [
    [read, 'game.openworld.players.inspect'],
    [read, 'game.openworld.players.moderate'],
    [shots],
  ]) {
    await grant(...keys);
    expect((await galleryRead()).status).toBe(403);
    expect((await galleryRead(image)).status).toBe(403);
    expect((await galleryRead(preview)).status).toBe(403);
  }
  expect(calls).toEqual([]);
  await grant(read, shots);
  const files = await galleryRead();
  expect(files.status).toBe(200);
  expect(await files.json()).toEqual({
    files: [{ name: 'conn7-fixture.png', mtimeMs: 100, bytes: capturePng.byteLength }],
  });
  expect((await galleryRead(preview.replace('mtimeMs=100', 'mtimeMs=99'))).status).toBe(404);
  const rendered = await galleryRead(preview);
  expect(rendered.status).toBe(200);
  expect(PNG.sync.read(Buffer.from(await rendered.arrayBuffer()))).toMatchObject({
    width: 7,
    height: 5,
  });
  const downloads = calls.filter((c) => c === 'screenshot').length;
  expect((await galleryRead(preview)).status).toBe(200);
  expect(calls.filter((c) => c === 'screenshot')).toHaveLength(downloads);
  const opened = await galleryRead(image);
  expect(opened.status).toBe(200);
  expect(opened.headers.get('content-type')).toBe('image/png');
  expect(opened.headers.get('cache-control')).toContain('no-store');
  expect(new Uint8Array(await opened.arrayBuffer()).slice(1, 4)).toEqual(
    Uint8Array.from([80, 78, 71]),
  );
  await grant(read);
  const count = calls.length;
  expect((await galleryRead(preview)).status).toBe(403);
  expect((await galleryRead()).status).toBe(403);
  expect((await galleryRead(image)).status).toBe(403);
  expect(calls).toHaveLength(count);
});

it('collects native captures independently, fences the verified roster, and protects account attribution', async () => {
  const account = randomUUID();
  const filename = 'world-screenshot-mono100-conn2-req1.png';
  const stamp = '2026-11-22 00:20:24.710';
  const log = (channel: string, message: string, source: string) =>
    `${stamp} [INFO ] [${channel}] [t0] ${message}  (${source}.cpp:100)`;
  const logs = ['booted'];
  let visible = false;
  const file = { name: filename, mtimeMs: Date.parse('2026-11-21T23:20:24.703Z'), bytes: 1900 };
  const { db, id, grant, power, galleryRead, target, fetcher, state } = await fixture((url) => {
    switch (url.pathname) {
      case '/api/live/console':
        return Response.json({
          last: logs.length,
          lines: logs
            .map((text, i) => ({ seq: i + 1, text }))
            .filter((l) => l.seq > Number(url.searchParams.get('after'))),
        });
      case '/api/live/players':
        return Response.json({
          players: [{ id: 2, account, admitted: true, accountVerified: true }],
        });
      case '/api/live/screenshots':
        return Response.json({ files: visible ? [file] : [] });
    }
  });
  await power('running');
  const scan = createOpenworldCaptureCollector({
    db,
    target,
    fetcher,
    now: () => file.mtimeMs + 20,
  });
  async function claim() {
    // The test schema may also contain servers created by earlier cases.
    const [a, b] = await Promise.all([
      claimOpenworldCaptureScans(db, 128),
      claimOpenworldCaptureScans(db, 128),
    ]);
    const leases = [...a, ...b].filter((r) => r.server_id === id);
    expect(leases).toHaveLength(1);
    const lease = leases[0];
    if (!lease) throw new Error('missing lease');
    return lease;
  }
  await scan(await claim());
  logs.push(
    log(
      'server-console',
      'EVT event=console.exec req=U-08 verb=screenshot target=2 request_id=1',
      'ConsoleVerbs',
    ),
  );
  logs.push(
    log(
      'server-net',
      `conn=2 : screenshot written: owserver_data/screenshots/${filename} (request_id=1, 2560x1600, 1900 byte(s))`,
      'ScreenshotDataHandler',
    ),
  );
  await db
    .updateTable('openworld_capture_cursors')
    .set({ next_scan_at: new Date(0) })
    .where('server_id', '=', id)
    .execute();
  await scan(await claim());
  expect(
    await db
      .selectFrom('openworld_capture_owners')
      .select('server_id')
      .where('server_id', '=', id)
      .execute(),
  ).toHaveLength(0);
  visible = true;
  await db
    .updateTable('openworld_capture_cursors')
    .set({ next_scan_at: new Date(0) })
    .where('server_id', '=', id)
    .execute();
  await createOpenworldCaptureCollector({ db, target, fetcher, now: () => file.mtimeMs + 20 })(
    await claim(),
  );
  const row = await db
    .selectFrom('openworld_capture_owners')
    .selectAll()
    .where('server_id', '=', id)
    .executeTakeFirstOrThrow();
  expect(row).toMatchObject({
    account_id: account,
    file_name: filename,
    request_id: '1',
    requested_seq: '2',
    written_seq: '3',
  });
  const permissions = ['game.openworld.players.read', 'game.openworld.players.screenshots'];
  await grant(...permissions);
  expect((await galleryRead(`?account=${account}`)).status).toBe(403);
  expect(await (await galleryRead()).json()).toEqual({ files: [file] });
  await grant(...permissions, 'game.openworld.players.inspect');
  expect(await (await galleryRead(`?account=${account}`)).json()).toEqual({
    files: [{ ...file, accountId: account }],
  });
  expect(await (await galleryRead(`?account=${randomUUID()}`)).json()).toEqual({ files: [] });
  file.mtimeMs++;
  expect(await (await galleryRead()).json()).toEqual({ files: [{ ...file, accountId: null }] });
  state.beforeReply = async (resource) => {
    if (resource === 'screenshots') await grant(...permissions);
  };
  expect((await galleryRead()).status).toBe(403);
});

it('checks the original image revision after transfer when a same-size file is replaced', async () => {
  let mtimeMs = 100;
  const { power, grant, galleryRead, state, calls } = await fixture((url) =>
    url.pathname === '/api/live/screenshots'
      ? Response.json({
          files: [{ name: 'conn7-fixture.png', bytes: capturePng.byteLength, mtimeMs }],
        })
      : undefined,
  );
  await power('running');
  await grant('game.openworld.players.read', 'game.openworld.players.screenshots');
  const image = '/image?name=conn7-fixture.png';
  expect((await galleryRead(`${image}&bytes=${capturePng.byteLength}`)).status).toBe(400);
  expect((await galleryRead(`${image}&mtimeMs=100`)).status).toBe(400);
  expect((await galleryRead(`${image}&bytes=${capturePng.byteLength}&mtimeMs=100`)).status).toBe(
    200,
  );
  state.beforeReply = async (resource) => {
    if (resource === 'screenshot') mtimeMs++;
  };
  expect((await galleryRead(`${image}&bytes=${capturePng.byteLength}&mtimeMs=100`)).status).toBe(
    404,
  );
  expect(calls.slice(-2)).toEqual(['screenshot', 'screenshots']);
  const preview = `/thumbnail?name=conn7-fixture.png&bytes=${capturePng.byteLength}&mtimeMs=${mtimeMs}`;
  expect((await galleryRead(preview)).status).toBe(404);
  expect(calls.slice(-3)).toEqual(['screenshots', 'screenshot', 'screenshots']);
});

it('archives both native skin views in the background and serves the exact revision after shutdown and permission recheck', async () => {
  const account = randomUUID();
  const skinHash = 'cafebabe';
  const member = {
    id: 2,
    name: 'Ada',
    account: account.toUpperCase(),
    accountVerified: true,
    admitted: true,
    skinHash,
  };
  const avatars = {
    head: capturePng,
    body: Uint8Array.from(PNG.sync.write(new PNG({ width: 9, height: 18 }))),
  };
  const { db, id, principal, power, grant, calls, target, fetcher, state } = await fixture(
    (url) => {
      if (url.pathname === '/api/live/console') return Response.json({ last: 0, lines: [] });
      if (url.pathname === '/api/live/players') return Response.json({ players: [member] });
      if (url.pathname === '/api/live/skin')
        return new Response(avatars[url.searchParams.get('view') as keyof typeof avatars], {
          headers: { 'content-type': 'image/png' },
        });
    },
  );
  await power('running');
  const options = { db, target, fetcher, now: () => state.now };
  const capture = createOpenworldCaptureCollector(options);
  const claim = (await claimOpenworldCaptureScans(db, 128)).find((l) => l.server_id === id);
  if (!claim) throw Error('missing lease');
  const observation = await capture(claim);
  if (!observation) throw Error('missing observation');
  expect(observation.sessions).toEqual([{ connection: 2, account }]);
  const skins = createOpenworldSkinCollector(options);
  await skins(observation.scope, observation.sessions);
  expect(calls.filter((c) => c === 'skin')).toHaveLength(2);
  const before = calls.length;
  await skins(observation.scope, observation.sessions);
  await skins(observation.scope, []);
  expect(calls).toHaveLength(before);
  await skins(observation.scope, observation.sessions);
  expect(calls.filter((c) => c === 'skin')).toHaveLength(2);
  await power('offline');
  const fileScope = vi.fn(async () => {
    throw Error('Unexpected file I/O');
  });
  let queries = 0;
  const directory = createOpenworldPlayerDirectory(
    db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        queries++;
        return result;
      },
    }),
    fileScope,
  );
  const app = new Hono<{ Variables: Variables }>();
  app.onError((err, c) =>
    c.json(
      { error: err instanceof DomainError ? err.code : 'internal_error' },
      err instanceof DomainError ? (err.status as 400) : 500,
    ),
  );
  registerOpenworldPlayerDirectoryRoutes(app, { db, principal: async () => principal }, directory);
  const endpoint = (view: string, h = skinHash, a: string = account) =>
    app.request(`/v1/servers/${id}/openworld/players/saved/${a}/skin?h=${h}&view=${view}`);
  const read = 'game.openworld.players.read',
    inspect = 'game.openworld.players.inspect';
  await grant(read, inspect);
  const callsWhileOff = calls.length;
  for (const view of ['head', 'body'] as const) {
    const response = await endpoint(view);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(avatars[view]);
  }
  expect(queries).toBe(2);
  expect((await endpoint('head', 'abcdef01')).status).toBe(404);
  expect((await endpoint('head', skinHash, account.toUpperCase())).status).toBe(200);
  expect((await endpoint('body', skinHash, randomUUID())).status).toBe(404);
  expect((await endpoint('other')).status).toBe(400);
  for (const keys of [[read], [inspect], ['game.openworld.players.moderate']]) {
    await grant(...keys);
    expect((await endpoint('head')).status).toBe(403);
  }
  await grant(read, inspect);
  await db
    .updateTable('openworld_server_profiles')
    .set({ sha256: 'b'.repeat(64) })
    .where('server_id', '=', id)
    .execute();
  expect((await endpoint('body')).status).toBe(404);
  expect(calls).toHaveLength(callsWhileOff);
  expect(fileScope).not.toHaveBeenCalled();
});

it('skips guest, ambiguous and reassigned connections and atomically refreshes a changed skin', async () => {
  const account = randomUUID(),
    replacement = randomUUID();
  const first = {
    id: 2,
    name: 'Ada',
    account,
    accountVerified: true,
    admitted: true,
    skinHash: '1234abcd',
  };
  let roster = [first],
    replaceDuringSkin = false,
    invalid = false;
  const { db, id, power, state, target, fetcher, calls } = await fixture((url) => {
    if (url.pathname === '/api/live/players') return Response.json({ players: roster });
    if (url.pathname === '/api/live/skin') {
      if (replaceDuringSkin) roster = [{ ...first, account: replacement }];
      const bytes =
        invalid && url.searchParams.get('view') === 'body'
          ? capturePng.subarray(0, 55)
          : capturePng;
      return new Response(bytes, { headers: { 'content-type': 'image/png' } });
    }
  });
  await power('running');
  const scope = await readOpenworldScope(db, id),
    session = [{ connection: 2, account }];
  const collect = createOpenworldSkinCollector({ db, target, fetcher, now: () => state.now });
  const scan = async () => {
    state.now += 61000;
    await collect(scope, session);
  };
  const row = () =>
    db
      .selectFrom('openworld_player_skins')
      .select('skin_hash')
      .where('server_id', '=', id)
      .executeTakeFirst();
  roster = [{ ...first, accountVerified: false }];
  await scan();
  roster = [first, { ...first, id: 3, skinHash: '00000001' }];
  await scan();
  expect(calls).not.toContain('skin');
  roster = [first];
  replaceDuringSkin = true;
  await scan();
  expect(await row()).toBeUndefined();
  roster = [first];
  replaceDuringSkin = false;
  await scan();
  expect(await row()).toEqual({ skin_hash: first.skinHash });
  roster = [{ ...first, skinHash: 'cafebabe' }];
  invalid = true;
  await scan();
  expect(await row()).toEqual({ skin_hash: first.skinHash });
  invalid = false;
  await scan();
  expect(await row()).toEqual({ skin_hash: 'cafebabe' });
});

it('bounds concurrent skin requests and rotates past a timed-out batch of accounts', async () => {
  const roster = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    name: 'Player',
    account: `10000000-0000-4000-8000-00000000000${i}`,
    accountVerified: true,
    admitted: true,
    skinHash: '1234abcd',
  }));
  let abort = new AbortController();
  const requested: number[] = [];
  const { db, id, power, target, fetcher, state } = await fixture((url) => {
    if (url.pathname === '/api/live/players') return Response.json({ players: roster });
    if (url.pathname === '/api/live/skin') {
      requested.push(Number(url.searchParams.get('id')));
      return new Response(capturePng, { headers: { 'content-type': 'image/png' } });
    }
  });
  await power('running');
  const scope = await readOpenworldScope(db, id);
  const collect = createOpenworldSkinCollector(
    { db, target, fetcher, now: () => state.now },
    (current, work) => work(current.origin, 'fixture1', abort.signal),
  );
  const sessions = roster.map((p) => ({ connection: p.id, account: p.account }));
  const gate = Promise.withResolvers<void>();
  let waiting = 0;
  state.beforeReply = async (resource) => {
    if (resource === 'skin') {
      waiting++;
      await gate.promise;
    }
  };
  const first = collect(scope, sessions);
  try {
    await vi.waitFor(() => expect(waiting).toBe(8));
  } finally {
    abort.abort();
    gate.resolve();
    await expect(first).rejects.toThrow();
  }
  expect(new Set(requested)).toEqual(new Set([1, 2, 3, 4]));
  requested.length = 0;
  abort = new AbortController();
  await collect(scope, sessions);
  expect(new Set(requested.slice(0, 4))).toEqual(new Set([5, 6]));
  expect(requested).toHaveLength(8);
  expect(
    await db
      .selectFrom('openworld_player_skins')
      .select('account_id')
      .where('server_id', '=', id)
      .execute(),
  ).toHaveLength(4);
});
