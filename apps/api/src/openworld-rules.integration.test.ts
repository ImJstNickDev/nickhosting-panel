import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import {
  performOpenworldRule,
  readOpenworldRules,
} from '../../../games/openworld/src/rules-native.js';
import { createOpenworldRules } from '../../../packages/server-management/src/openworld-rules.js';
import { openworldInstance } from '../tests/openworld-instance.js';
import type { Variables } from './app.js';
import { registerOpenworldRulesRoutes } from './openworld-rules.js';

vi.mock('../../../games/openworld/src/rules-native.js', () => ({
  performOpenworldRule: vi.fn(),
  readOpenworldRules: vi.fn(),
}));

const read = 'game.openworld.rules.view',
  write = 'game.openworld.rules.manage',
  bans = 'game.openworld.bans.manage';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(() => {
  vi.mocked(readOpenworldRules)
    .mockReset()
    .mockResolvedValue({
      difficulty: 'normal',
      roles: null,
      zones: [],
      borders: null,
      bans: [],
      capabilities: { unban: true, difficulty: true },
    });
  vi.mocked(performOpenworldRule)
    .mockReset()
    .mockImplementation(async (_native, _version, _action, beforeDispatch) => {
      await beforeDispatch();
    });
});
async function fixture() {
  const { db } = database;
  const instance = await openworldInstance(db);
  const { id, sub, owner, target } = instance;
  const router = () => {
    const app = new Hono<{ Variables: Variables }>();
    app.onError((err, c) =>
      c.json(
        { error: err instanceof DomainError ? err.code : 'internal_error' },
        err instanceof DomainError ? (err.status as 400) : 500,
      ),
    );
    const service = createOpenworldRules({
      db,
      target,
      fetcher: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/live/auth')
          return Response.json({ required: true, loopback: false, canAct: false });
        if (path === '/api/live/login') return Response.json({ token: 'fixture-token' });
        throw Error('unexpected fixture resource');
      },
    });
    registerOpenworldRulesRoutes(
      app,
      {
        db,
        principal: async (c) =>
          c.req.header('x-reader') === 'owner' ? owner.context : sub.context,
      },
      service,
    );
    return (input?: unknown, reader: 'owner' | 'sub' = 'sub') =>
      app.request(`/v1/servers/${id}/openworld/rules`, {
        headers: { 'X-Reader': reader, 'Content-Type': 'application/json' },
        method: input === undefined ? 'GET' : 'POST',
        body: input === undefined ? undefined : JSON.stringify(input),
      });
  };
  return { ...instance, request: router(), router };
}

it('authorizes viewing rules independently from the seed, console, live moderation and both writing grants', async () => {
  const f = await fixture();
  for (const grants of [
    [write, bans],
    [
      'game.openworld.map.read',
      'game.openworld.players.moderate',
      'game.openworld.seed.inspect',
      'console.command',
    ],
  ]) {
    await f.grant(...grants);
    expect((await f.request()).status).toBe(403);
  }
  await f.grant(read);
  expect(await (await f.request()).json()).toEqual({ error: 'game_not_ready' });
  expect(f.target).not.toHaveBeenCalled();
  await f.power('running');
  const response = await f.request();
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const { processRef } = await response.json();
  expect(processRef).toMatch(/^[a-f0-9]{64}$/);
  const edit = {
    processRef,
    requestId: randomUUID(),
    action: { kind: 'difficulty', value: 'hard' },
  };
  expect((await f.request(edit)).status).toBe(403);
  await f.grant(read, bans);
  expect((await f.request(edit)).status).toBe(403);
  await f.grant(read, write);
  const lift = { ...edit, action: { kind: 'unban', uuid: randomUUID() } };
  expect((await f.request(lift)).status).toBe(403);
  expect(
    (await f.request({ ...edit, action: { kind: 'difficulty', value: 'other' } })).status,
  ).toBe(400);
  expect((await f.request({ ...edit, processRef: '0'.repeat(64) })).status).toBe(409);
  expect(performOpenworldRule).not.toHaveBeenCalled();
  expect(await (await f.request(edit)).json()).toMatchObject({
    requestId: edit.requestId,
    outcome: 'accepted',
  });
  expect((await f.router()(edit)).ok).toBe(true);
  expect((await f.request({ ...edit, action: { kind: 'difficulty', value: 'easy' } })).status).toBe(
    409,
  );
  expect(performOpenworldRule).toHaveBeenCalledTimes(1);
  await f.grant(read);
  expect((await f.request(edit)).status).toBe(403);
});

it('rechecks current rules access after a shared read and immediately before dispatch', async () => {
  const f = await fixture();
  await f.grant(read, write);
  await f.power('running');
  const { processRef } = await (await f.request()).json();
  const action = {
    requestId: randomUUID(),
    processRef,
    action: { kind: 'difficulty', value: 'hard' },
  };
  const entered = Promise.withResolvers<void>(),
    released = Promise.withResolvers<void>();
  const sent = vi.fn();
  vi.mocked(performOpenworldRule).mockImplementationOnce(async (_n, _v, _a, beforeDispatch) => {
    entered.resolve();
    await released.promise;
    await beforeDispatch();
    sent();
  });
  const pending = f.request(action);
  await entered.promise;
  try {
    expect(await (await f.router()({ ...action, requestId: randomUUID() })).json()).toEqual({
      error: 'conflict',
    });
    await f.grant(read);
  } finally {
    released.resolve();
  }
  expect((await pending).status).toBe(403);
  expect(sent).not.toHaveBeenCalled();
  const current = await (await f.request()).json();
  const start = Promise.withResolvers<void>(),
    end = Promise.withResolvers<void>();
  vi.mocked(readOpenworldRules).mockImplementationOnce(async () => {
    start.resolve();
    await end.promise;
    return current;
  });
  const snapshot = f.request();
  await start.promise;
  await f.grant('game.openworld.seed.inspect');
  end.resolve();
  expect((await snapshot).status).toBe(403);
});

it('preserves uncertain requests and rejects a replaced process without sending a second command', async () => {
  const f = await fixture();
  await f.grant(read, bans);
  await f.power('running');
  const { processRef } = await (await f.request()).json();
  const input = {
    processRef,
    requestId: randomUUID(),
    action: { kind: 'unban', uuid: randomUUID() },
  };
  vi.mocked(performOpenworldRule).mockImplementationOnce(async (_n, _v, _a, beforeDispatch) => {
    await beforeDispatch();
    throw new DomainError('operation_uncertain');
  });
  for (const send of [f.request, f.router()])
    expect(await (await send(input)).json()).toEqual({ error: 'operation_uncertain' });
  const audit = await database.db
    .selectFrom('audit_events')
    .select('metadata')
    .where('correlation_id', '=', input.requestId)
    .executeTakeFirstOrThrow();
  expect(audit.metadata).toMatchObject({ ruleAction: 'unban', outcome: 'uncertain' });
  expect(JSON.stringify(audit.metadata)).not.toContain(input.action.uuid);
  await database.db
    .updateTable('managed_servers')
    .set({ pterodactyl_uuid: randomUUID() })
    .where('id', '=', f.id)
    .execute();
  expect(await (await f.request({ ...input, requestId: randomUUID() })).json()).toEqual({
    error: 'conflict',
  });
  expect(performOpenworldRule).toHaveBeenCalledTimes(1);
});

it('upgrades the stored Openworld permission declaration without changing unrelated entries or duplicating grants', async () => {
  await fixture();
  const original = openworldManifest.serverPermissions.filter(
    (p) => ![read, write, bans, 'game.openworld.seed.inspect'].includes(p.key),
  );
  const migration = await readFile(
    new URL(
      '../../../packages/database/migrations/085_openworld_rules_seed_permissions.sql',
      import.meta.url,
    ),
    'utf8',
  );
  await database.db.transaction().execute(async (tx) => {
    await tx
      .updateTable('game_integrations')
      .set({ manifest: { ...openworldManifest, serverPermissions: original } })
      .where('id', '=', 'openworld')
      .execute();
    await sql.raw(migration).execute(tx);
    await sql.raw(migration).execute(tx);
    const row = await tx
      .selectFrom('game_integrations')
      .select('manifest')
      .where('id', '=', 'openworld')
      .executeTakeFirstOrThrow();
    expect(row.manifest).toEqual(openworldManifest);
  });
});
