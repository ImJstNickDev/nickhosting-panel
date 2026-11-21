import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import { createOpenworldPlayerActions } from '../../../packages/server-management/src/openworld-player-actions.js';
import { createOpenworldPlayerChannel } from '../../../packages/server-management/src/openworld-player-channel.js';
import { createOpenworldTelemetry } from '../../../packages/server-management/src/openworld-telemetry.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerOpenworldPlayerActionRoutes } from './openworld-player-actions.js';
import { registerOpenworldScreenshotRoutes } from './openworld-screenshots.js';
import { registerOpenworldTelemetryRoutes } from './openworld-telemetry.js';

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
      return Response.json({ files: [{ name: 'conn7-fixture.png', mtimeMs: 100, bytes: 67 }] });
    if (resource === 'skin' || resource === 'screenshot') {
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
  const galleryRead = (suffix = '') =>
    gallery.request(`/v1/servers/${id}/openworld/screenshots${suffix}`);
  return {
    id,
    db,
    grant,
    power,
    state,
    calls,
    target,
    request: router(),
    router,
    actionRouter,
    galleryRead,
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
  for (const res of replies) {
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toEqual({
      source: 'live',
      processRef: expect.stringMatching(/^[a-f0-9]{64}$/),
      reason: null,
      observedAt: new Date(state.now).toISOString(),
      data: { players: [{ id: 7, name: 'Ada', connectedS: 90, skinHash: '12ab34cd' }] },
    });
  }
  expect(calls).toEqual(['auth', 'login', 'players']);
  await power('offline');
  const saved = await (await router()('players', 'sub')).json();
  expect(saved).toMatchObject({ source: 'snapshot', reason: 'offline' });
  expect(saved.data.players).toEqual([
    { id: 7, name: 'Ada', connectedS: 90, skinHash: '12ab34cd' },
  ]);
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
  for (const keys of [
    [read, 'game.openworld.players.inspect'],
    [read, 'game.openworld.players.moderate'],
    [shots],
  ]) {
    await grant(...keys);
    expect((await galleryRead()).status).toBe(403);
    expect((await galleryRead(image)).status).toBe(403);
  }
  expect(calls).toEqual([]);
  await grant(read, shots);
  const files = await galleryRead();
  expect(files.status).toBe(200);
  expect(await files.json()).toEqual({
    files: [{ name: 'conn7-fixture.png', mtimeMs: 100, bytes: 67 }],
  });
  const opened = await galleryRead(image);
  expect(opened.status).toBe(200);
  expect(opened.headers.get('content-type')).toBe('image/png');
  expect(opened.headers.get('cache-control')).toContain('no-store');
  expect(new Uint8Array(await opened.arrayBuffer()).slice(1, 4)).toEqual(
    Uint8Array.from([80, 78, 71]),
  );
  await grant(read);
  const count = calls.length;
  expect((await galleryRead()).status).toBe(403);
  expect((await galleryRead(image)).status).toBe(403);
  expect(calls).toHaveLength(count);
});
