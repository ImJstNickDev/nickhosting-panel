import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { FilemanReadService } from '@nickhosting/game-sdk';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOpenworldPlayerModeration } from '../../../packages/server-management/src/openworld-player-moderation.js';
import { openworldInstance } from '../tests/openworld-instance.js';
import type { Variables } from './app.js';
import { registerOpenworldPlayerModerationRoutes } from './openworld-player-moderation.js';

const account = 'c7608bae-65b7-413e-a7eb-cb43ccd12c8b',
  other = 'd31de5f5-1f3a-49d7-a591-1445de348ffd';
const inspect = 'game.openworld.players.inspect';
const read = 'game.openworld.players.read',
  ban = 'game.openworld.bans.manage',
  mod = 'game.openworld.players.moderate',
  roles = 'game.openworld.roles.manage';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
async function fixture() {
  const { db } = database;
  const f = await openworldInstance(db);
  await f.power('running');
  await db
    .updateTable('openworld_server_profiles')
    .set({ version: 'a1.2.10' })
    .where('server_id', '=', f.id)
    .execute();
  const state = {
    connected: true,
    disconnectAfterCursor: false,
    duplicate: false,
    aliasRole: false,
    aliasStats: false,
    unreadable: false,
    role: 'player',
    ignore: false,
    banned: new Set<string>([other]),
    commands: [] as string[],
  };
  const rows: { seq: number; text: string }[] = [];
  const append = (source: string, msg: string) =>
    rows.push({
      seq: rows.length + 1,
      text: `2026-11-22 10:11:12.123 [INFO ] [${source}] [t0] ${msg}`,
    });
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const files = {
    list: async (path: string) => {
      if (path === '') return [{ name: 'owserver_data', kind: 'directory' }];
      if (path === 'owserver_data') return [{ name: 'players', kind: 'directory' }];
      const ids =
        state.duplicate || state.aliasStats || state.unreadable ? [account, other] : [account];
      if (path.endsWith('/stats')) return [{ name: `${other}.json`, kind: 'file', size: 80 }];
      return [
        ...(state.aliasStats ? [{ name: 'stats', kind: 'directory' }] : []),
        ...ids.map((uuid) => ({ name: `${uuid}.json`, kind: 'file', size: 80 })),
      ];
    },
    readMany: async (reqs: { path: string }[]) =>
      new Map(
        reqs.map((r) => {
          const uuid = r.path.split('/').at(-1)?.slice(0, -5);
          if (state.unreadable && uuid === other) return [r.path, bytes({ unreadable: true })];
          const pseudo =
            state.aliasStats && uuid === other && !r.path.includes('/stats/') ? 'Different' : 'Ada';
          return [r.path, bytes({ uuid, pseudo })];
        }),
      ),
    read: async (path: { path: string }) => {
      if (path.path !== 'roles.json') throw Error('unexpected read');
      return bytes({
        roles: { player: { name: 'Player' }, mod: { name: 'Moderator' } },
        players: {
          [account]: { role: state.role, pseudo: 'Ada' },
          ...(state.aliasRole && { [other]: { role: 'mod', pseudo: 'aDa' } }),
        },
        defaultRole: 'player',
      });
    },
  } as unknown as FilemanReadService;
  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname === '/api/live/auth')
      return Response.json({ required: true, loopback: false, canAct: false });
    if (u.pathname === '/api/live/login') return Response.json({ token: 'test' });
    if (u.pathname === '/api/live/players')
      return Response.json({
        players: state.connected ? [{ id: 3, name: 'Ada', account, accountVerified: true }] : [],
      });
    if (u.pathname !== '/api/live/console') throw Error(`unexpected fetch ${u.pathname}`);
    if (init?.method !== 'POST') {
      const after = u.searchParams.get('after');
      if (after === null && state.disconnectAfterCursor && state.commands.at(-1) === 'banlist')
        state.connected = false;
      return Response.json({
        last: rows.length,
        lines: after === null ? rows.slice(-1) : rows.filter((r) => r.seq > Number(after)),
      });
    }
    const { command } = JSON.parse(String(init.body));
    const verb = command.split(' ')[0];
    state.commands.push(command);
    append('web', `web console (127.0.0.1) > ${command}  (WebActions.cpp:77)`);
    let lines = ['OK'];
    if (verb === 'banlist')
      lines = state.banned.size
        ? [
            `${state.banned.size} banned player(s):`,
            ...[...state.banned].map((uuid) => `  Ada (${uuid}), banned by Admin: review`),
          ]
        : ['Nobody is banned.'];
    else if (!state.ignore) {
      if (verb === 'ban') state.banned.add(account);
      if (verb === 'unban') state.banned.delete(command.slice(6));
      if (verb === 'role') state.role = command.split(' ')[3];
    }
    for (const line of lines) append('server-console', `console: ${line}  (ConsoleVerbs.cpp:618)`);
    append(
      'server-console',
      `EVT event=console.exec req=RULES verb=${verb}  (ConsoleVerbs.cpp:621)`,
    );
    return Response.json({ ok: true });
  };
  const app = new Hono<{ Variables: Variables }>();
  app.onError((e, c) =>
    c.json(
      { error: e instanceof DomainError ? e.code : 'internal_error' },
      e instanceof DomainError ? (e.status as 400) : 500,
    ),
  );
  const service = createOpenworldPlayerModeration({
    db,
    target: f.target,
    withFiles: async (_who, _id, _grant, _signal, work) => work(files),
    fetcher,
  });
  registerOpenworldPlayerModerationRoutes(
    app,
    { db, principal: async () => f.sub.context },
    service,
  );
  const request = async (path: string, body?: unknown) =>
    app.request(
      `/v1/servers/${f.id}/openworld/players/moderation${path}`,
      body === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
  return { ...f, state, request };
}
it('reads an unindexed ban, revokes by UUID without a player-inspection grant and fences duplicate ban requests', async () => {
  const f = await fixture();
  await f.grant(read);
  expect((await f.request('/bans')).status).toBe(403);
  await f.grant(ban);
  expect((await f.request('/bans')).status).toBe(403);
  await f.grant(read, ban);
  const view = await (await f.request('/bans')).json();
  expect(view.bans).toMatchObject([{ uuid: other }]);
  const unban = {
    requestId: randomUUID(),
    processRef: view.processRef,
    action: { kind: 'unban', account: other },
  };
  expect((await f.request('', unban)).status).toBe(200);
  expect(f.state.banned.size).toBe(0);
  expect((await f.request('', unban)).status).toBe(200);
  expect(f.state.commands.filter((c) => c.startsWith('unban '))).toHaveLength(1);
  const action = {
    requestId: randomUUID(),
    processRef: view.processRef,
    action: { kind: 'ban', account, name: 'Ada', reason: 'Test' },
  };
  expect((await f.request('', action)).status).toBe(403);
  await f.grant(read, mod);
  expect((await f.request('', action)).status).toBe(403);
  await f.grant(read, mod, ban);
  expect((await f.request('', action)).status).toBe(403);
  await f.grant(read, inspect, mod, ban);
  f.state.connected = false;
  expect(await (await f.request('', action)).json()).toEqual({ error: 'game_request_unsupported' });
  expect(f.state.commands).not.toContain('ban Ada Test');
  f.state.connected = true;
  f.state.duplicate = true;
  expect(await (await f.request('', { ...action, requestId: randomUUID() })).json()).toEqual({
    error: 'conflict',
  });
  expect(f.state.commands).not.toContain('ban Ada Test');
  f.state.duplicate = false;
  expect((await f.request('', { ...action, requestId: randomUUID() })).status).toBe(200);
  expect(f.state.banned.has(account)).toBe(true);
});
it('assigns role by corroborated offline name, verifies saved UUID and marks an unconfirmed write uncertain', async () => {
  const f = await fixture();
  await f.grant(read, ban);
  expect((await f.request(`/roles/${account}`)).status).toBe(403);
  await f.grant(read, roles);
  expect((await f.request(`/roles/${account}`)).status).toBe(403);
  await f.grant(read, inspect, roles);
  const view = await (await f.request(`/roles/${account}`)).json();
  expect(view).toMatchObject({ current: 'player', mutable: true });
  f.state.connected = false;
  const change = {
    requestId: randomUUID(),
    processRef: view.processRef,
    action: { kind: 'role', account, name: 'Ada', previous: 'player', role: 'mod' },
  };
  f.state.ignore = true;
  expect(await (await f.request('', change)).json()).toEqual({ error: 'operation_uncertain' });
  f.state.ignore = false;
  expect(await (await f.request('', change)).json()).toEqual({ error: 'operation_uncertain' });
  expect(f.state.commands).toEqual(['role assign Ada mod']);
  const verified = { ...change, requestId: randomUUID() };
  expect((await f.request('', verified)).status).toBe(200);
  expect((await (await f.request(`/roles/${account}`)).json()).current).toBe('mod');
  await f.grant(read);
  expect((await f.request('', verified)).status).toBe(403);
});

it('rejects name-based mutations before dispatch for retained role aliases, old statistics aliases and unprovable saves', async () => {
  const f = await fixture();
  await f.grant(read, inspect, roles);
  const { processRef } = await (await f.request(`/roles/${account}`)).json();
  const attempt = () =>
    f.request('', {
      requestId: randomUUID(),
      processRef,
      action: { kind: 'role', account, name: 'Ada', previous: 'player', role: 'mod' },
    });
  f.state.aliasRole = true;
  expect(await (await attempt()).json()).toEqual({ error: 'conflict' });
  f.state.aliasRole = false;
  f.state.aliasStats = true;
  expect(await (await attempt()).json()).toEqual({ error: 'conflict' });
  f.state.aliasStats = false;
  f.state.unreadable = true;
  expect(await (await attempt()).json()).toEqual({ error: 'integration_unavailable' });
  expect(f.state.commands).toEqual([]);
});

it('observes a late disconnect after the console cursor and before the write', async () => {
  const f = await fixture();
  await f.grant(read, inspect, mod, ban);
  const { processRef } = await (await f.request('/bans')).json();
  f.state.commands.length = 0;
  f.state.disconnectAfterCursor = true;
  const reply = await f.request('', {
    requestId: randomUUID(),
    processRef,
    action: { kind: 'ban', name: 'Ada', account, reason: 'Test' },
  });
  expect(await reply.json()).toEqual({ error: 'game_request_unsupported' });
  expect(f.state.commands).toEqual(['banlist']);
});
