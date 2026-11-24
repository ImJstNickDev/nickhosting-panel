import { randomUUID } from 'node:crypto';
import { type AuthContext, authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { createOpenworldDashboardIngress } from './openworld-dashboard-ingress.js';
import { issueDashboardCode, publishedInspectorLink } from './openworld-dashboard-sso.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

it('binds the panel login to one host, browser and parent session and rechecks native grants on each private request', async () => {
  const { db } = database;
  const f = await managementFixture(db, { interactive: true });
  const sub = await managementFixture(db, { interactive: true });
  const id = await f.server();
  const hostname = 'aurora.games.example';
  const origin = `https://${hostname}`;
  const panelOrigin = 'https://panel.other.example';
  await db
    .insertInto('game_integrations')
    .values({ id: 'openworld', version: openworldManifest.version, manifest: openworldManifest })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'openworld', runtime_id: 'dedicated' })
    .where('id', '=', f.mappingId)
    .execute();
  await db
    .updateTable('managed_servers')
    .set({ runtime_state: 'running' })
    .where('id', '=', id)
    .execute();
  const allocation = await db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', id)
    .executeTakeFirstOrThrow();
  const address = '10.131.2.3';
  const port = allocation.port + 1;
  await db
    .insertInto('server_allocations')
    .values({
      ...allocation,
      id: randomUUID(),
      pterodactyl_allocation_id: allocation.pterodactyl_allocation_id + 1,
      role: 'dashboard',
      private_only: true,
      direct_endpoint: null,
      is_primary: false,
      backend_address: address,
      port,
      protocols: ['tcp'],
    })
    .execute();
  const assignment = randomUUID();
  await db
    .insertInto('dns_assignments')
    .values({
      id: assignment,
      server_id: id,
      ownership_token: randomUUID(),
      hostname,
      plan: JSON.stringify({ connection: { hostname } }),
      ledger: '[]',
      state: 'active',
    })
    .execute();
  await db
    .insertInto('dns_hostname_reservations')
    .values({ hostname, owner_id: assignment, release_after: null })
    .execute();
  await db
    .insertInto('server_dns_preferences')
    .values({
      server_id: id,
      assignment_id: assignment,
      subdomain: 'aurora',
      domain_id: 'domain',
      enabled: true,
    })
    .execute();
  await sql`UPDATE openworld_dashboard_publications
    SET enabled=true, tracked_hostname=${hostname}, proxy_host_id=42, provider_origin='https://npm.example', state='active'
    WHERE server_id=${id}::uuid`.execute(db);
  const backend = `http://${address}:${port}`;
  const target = vi.fn(async () => ({ address: backend, password: 'private-fixture' }));
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input.toString());
    const headers = new Headers(init?.headers);
    expect(url.origin).toBe(backend);
    if (url.pathname === '/api/live/login') {
      expect(init?.body).toBe(JSON.stringify({ password: 'private-fixture' }));
      return Response.json({ token: 'internal-only' });
    }
    if (url.pathname === '/api/live/auth' && !headers.has('x-ow-token'))
      return Response.json({ required: true, canAct: false, loopback: false });
    if (url.pathname.startsWith('/api/live/'))
      expect(headers.get('x-ow-token')).toBe('internal-only');
    else expect(headers.get('x-ow-token')).toBeNull();
    for (const header of [
      'cookie',
      'authorization',
      'x-forwarded-for',
      'x-forwarded-host',
      'origin',
    ])
      expect(headers.has(header)).toBe(false);
    return new Response(url.pathname, {
      headers: {
        'content-type': 'text/plain',
        'set-cookie': 'native=fake',
        'access-control-allow-origin': '*',
      },
    });
  });
  const app = createOpenworldDashboardIngress({
    db,
    panelOrigin,
    target,
    fetcher: upstream,
    management: () => {
      throw Error('fixture uses private adapter');
    },
  });
  const get = (path: string, extra: Record<string, string> = {}) =>
    app.request(origin + path, { headers: { host: hostname, ...extra } });
  const first = await get('/inspector/?view=2', { accept: 'text/html' });
  expect(first.status).toBe(303);
  const start = new URL(first.headers.get('location') ?? '');
  expect(start.origin).toBe(panelOrigin);
  expect(start.pathname).toBe('/dashboard/authorize');
  const args = { hostname, challenge: start.searchParams.get('challenge') ?? '' };
  expect(args.challenge).toMatch(/^[a-f0-9]{64}$/);
  const nonce = first.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  expect(nonce).toMatch(/^__Host-nh-ow-login-[a-f0-9]{64}=/);
  for (const who of [f.owner, sub.context, { ...f.context, sessionType: 'support' } as AuthContext])
    await expect(issueDashboardCode(db, who, args)).rejects.toThrow('forbidden');
  const grant = async (who: AuthContext) => {
    const { redirectUrl } = await issueDashboardCode(db, who, args);
    const callback = new URL(redirectUrl);
    expect(callback.origin).toBe(origin);
    const path = callback.pathname + callback.search;
    expect((await get(path)).status).toBe(403);
    const responses = await Promise.all([
      get(path, { cookie: nonce }),
      get(path, { cookie: nonce }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([303, 403]);
    const exchanged = responses.find((r) => r.status === 303);
    expect(exchanged?.headers.get('location')).toBe(`${origin}/inspector/?view=2`);
    const cookie =
      exchanged?.headers.getSetCookie().find((item) => item.startsWith('__Host-nh-ow-session=')) ??
      '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain('Domain');
    return cookie.split(';')[0] as string;
  };
  const ownerCookie = await grant(f.context);
  const good = await get('/api/live/status', {
    cookie: ownerCookie,
    authorization: 'Bearer incoming',
    'x-ow-token': 'client-supplied',
    'x-forwarded-host': 'attacker.example',
  });
  expect(good.status).toBe(200);
  expect(await good.text()).toBe('/api/live/status');
  expect(good.headers.get('cache-control')).toContain('no-store');
  expect(good.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  expect(good.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  expect(good.headers.get('set-cookie')).toBeNull();
  expect(good.headers.get('access-control-allow-origin')).toBeNull();
  expect((await get('/inspector/', { cookie: ownerCookie })).status).toBe(200);
  expect((await get('/api/info', { cookie: ownerCookie })).status).toBe(200);
  expect(target).toHaveBeenCalledTimes(1);
  expect(
    (
      await get('/api/info', {
        cookie: ownerCookie,
        'sec-fetch-site': 'same-site',
        accept: 'application/json',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await get('/api/live/status', {
        host: 'unknown.example',
        'x-forwarded-host': hostname,
        cookie: ownerCookie,
      })
    ).status,
  ).toBe(404);
  expect((await get('/api/info')).status).toBe(403);
  const post = (path: string, source: string, cookie = ownerCookie) =>
    app.request(origin + path, {
      method: 'POST',
      headers: { host: hostname, origin: source, cookie, 'content-type': 'application/json' },
      body: '{}',
    });
  expect((await post('/api/live/login', origin)).status).toBe(404);
  expect((await post('/api/live/console', panelOrigin)).status).toBe(403);
  expect((await post('/api/live/console', origin)).status).toBe(200);
  await db
    .insertInto('server_subusers')
    .values({
      server_id: id,
      user_id: sub.context.actorUserId,
      created_by: f.context.actorUserId,
      permission_keys: JSON.stringify(['settings.read']),
    })
    .execute();
  await expect(issueDashboardCode(db, sub.context, args)).rejects.toThrow('forbidden');
  await db
    .updateTable('server_subusers')
    .set({ permission_keys: JSON.stringify(['game.openworld.dashboard.admin']) })
    .where('server_id', '=', id)
    .where('user_id', '=', sub.context.actorUserId)
    .execute();
  const subCookie = await grant(sub.context);
  expect((await post('/api/live/console', origin, subCookie)).status).toBe(200);
  const enteredLive = Promise.withResolvers<void>(),
    releaseLive = Promise.withResolvers<void>();
  upstream.mockImplementationOnce(async () => {
    enteredLive.resolve();
    await releaseLive.promise;
    return Response.json({ players: ['private example'] });
  });
  const pendingLive = get('/api/live/players', { cookie: subCookie });
  await enteredLive.promise;
  await db
    .updateTable('server_subusers')
    .set({ permission_keys: JSON.stringify(['game.openworld.seed.inspect']) })
    .where('server_id', '=', id)
    .where('user_id', '=', sub.context.actorUserId)
    .execute();
  releaseLive.resolve();
  expect((await pendingLive).status).toBe(403);
  const seedCookie = await grant(sub.context);
  expect(await publishedInspectorLink(db, sub.context, id)).toEqual({
    inspectorUrl: `${origin}/inspector/`,
    inspectorPublished: true,
  });
  expect(
    await publishedInspectorLink(db, { ...sub.context, sessionType: 'support' } as AuthContext, id),
  ).toEqual({ inspectorUrl: null, inspectorPublished: true });
  // The regular panel session works on this host for the narrower reader.
  for (const path of [
    '/inspector/',
    '/inspector/js/main.js',
    '/inspector/vendor/three.module.js',
    '/pack/ow_stone.png',
    '/fonts/Nunito-Bold.ttf',
    '/api/info',
    '/api/tile',
  ]) {
    expect((await get(path, { cookie: seedCookie })).status).toBe(200);
  }
  const pendingCatalogs = Promise.withResolvers<void>(),
    finishCatalogs = Promise.withResolvers<void>();
  let catalogReads = 0;
  for (let i = 0; i < 12; i++)
    upstream.mockImplementationOnce(async () => {
      if (++catalogReads === 12) pendingCatalogs.resolve();
      await finishCatalogs.promise;
      return Response.json({ planet: 'moon' });
    });
  const catalogs = Array.from({ length: 12 }, () =>
    get('/api/info?planet=moon', { cookie: seedCookie }),
  );
  try {
    await pendingCatalogs.promise;
    const delayed = await get('/api/doc?planet=moon', { cookie: seedCookie });
    expect(delayed.status).toBe(429);
    expect(delayed.headers.get('retry-after')).toBe('1');
    expect((await get('/api/live/status', { cookie: ownerCookie })).status).toBe(200);
  } finally {
    finishCatalogs.resolve();
  }
  expect((await Promise.all(catalogs)).every((r) => r.ok)).toBe(true);
  const limitedBefore = upstream.mock.calls.length;
  for (const path of [
    '/',
    '/api/live/status',
    '/api/live/checkpoints',
    '/api/live/screenshot',
    '/api/live/players',
  ]) {
    expect((await get(path, { cookie: seedCookie })).status).toBe(403);
  }
  expect((await post('/api/live/console', origin, subCookie)).status).toBe(403);
  expect((await post('/api/live/console', origin, seedCookie)).status).toBe(403);
  expect(upstream.mock.calls).toHaveLength(limitedBefore);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  upstream.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return Response.json({ seed: 'private catalog' });
  });
  const pendingInfo = get('/api/info', { cookie: seedCookie });
  await entered.promise;
  await db
    .deleteFrom('server_subusers')
    .where('server_id', '=', id)
    .where('user_id', '=', sub.context.actorUserId)
    .execute();
  release.resolve();
  expect((await pendingInfo).status).toBe(403);
  const before = upstream.mock.calls.length;
  expect((await post('/api/live/console', origin, subCookie)).status).toBe(403);
  expect((await get('/api/info', { cookie: subCookie })).status).toBe(403);
  await db
    .deleteFrom('session')
    .where('id', '=', f.context[authSessionId] ?? '')
    .execute();
  expect((await get('/api/live/status', { cookie: ownerCookie })).status).toBe(403);
  await db
    .updateTable('openworld_dashboard_publications')
    .set({ enabled: false })
    .where('server_id', '=', id)
    .execute();
  expect((await get('/api/info', { cookie: ownerCookie })).status).toBe(404);
  expect(upstream.mock.calls.length).toBe(before);
});
