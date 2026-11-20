import { type AuthContext, DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerServerRoutes } from './servers.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let fixture: Awaited<ReturnType<typeof managementFixture>>;
let serverId: string;
let revoked = false;
let current: AuthContext;
let app: Hono<{ Variables: Variables }>;
let historyReads = 0;
let checks = 0;
function streamApp(listen: boolean) {
  const server = new Hono<{ Variables: Variables }>();
  registerServerRoutes(server, {
    db: database.db.withPlugin({
      transformQuery(args) {
        const { sql } = database.db.getExecutor().compileQuery(args.node, args.queryId);
        if (sql.includes('from "server_events"') && sql.includes('"id" >')) historyReads++;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    }),
    pool: listen ? database.pool : undefined,
    env: {},
    principal: async () => {
      checks++;
      if (revoked) throw new DomainError('unauthenticated');
      return current;
    },
    management: async () => {
      throw new Error('Unexpected provider access');
    },
    acquireUploadSlot: () => () => {},
  });
  return server;
}
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await managementFixture(database.db);
  serverId = await fixture.server();
  current = fixture.context;
  app = streamApp(true);
});
beforeEach(() => {
  revoked = false;
  historyReads = 0;
  checks = 0;
  current = fixture.context;
});
afterAll(async () => {
  await database?.destroy();
});

async function connect(headers?: Record<string, string>, application = app) {
  const response = await application.request(`/v1/servers/${serverId}/events/stream?after=latest`, {
    headers,
  });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing event stream');
  const decoder = new TextDecoder();
  let pending = '';
  return {
    close: () => reader.cancel(),
    async next() {
      while (!pending.includes('\n\n')) {
        const result = await reader.read();
        if (result.done) return undefined;
        pending += decoder.decode(result.value, { stream: true });
      }
      const boundary = pending.indexOf('\n\n');
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const values = Object.fromEntries(
        frame.split('\n').map((line) => {
          const at = line.indexOf(':');
          return [line.slice(0, at), line.slice(at + 1).trim()];
        }),
      );
      return { id: values.id, event: values.event, data: JSON.parse(values.data ?? '{}') };
    },
  };
}
async function publish(message = 'servers.operation.succeeded', simulateMissedHint = false) {
  return database.db.transaction().execute(async (tx) => {
    // This suite owns its isolated schema. Restore the trigger before commit.
    if (simulateMissedHint)
      await sql`alter table server_events disable trigger server_activity_insert_notify`.execute(
        tx,
      );
    const event = await tx
      .insertInto('server_events')
      .values({
        server_id: serverId,
        message_key: message,
        data: '{}',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (simulateMissedHint)
      await sql`alter table server_events enable trigger server_activity_insert_notify`.execute(tx);
    return event.id;
  });
}
async function promptly<T>(pending: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Timed out waiting for the server stream')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
it('delivers a committed activity immediately through the existing server stream', async () => {
  const stream = await connect();
  try {
    expect((await stream.next())?.event).toBe('ready');
    const next = promptly(stream.next());
    const id = await publish();
    expect(await next).toMatchObject({
      id,
      event: 'activity',
      data: { server_id: serverId, message_key: 'servers.operation.succeeded' },
    });
  } finally {
    await stream.close();
  }
});
it('resumes the emitted cursor instead of resetting latest and dropping disconnected events', async () => {
  const first = await connect();
  const ready = await first.next();
  expect(ready?.event).toBe('ready');
  await first.close();
  const id = await publish();
  const resumed = await connect({ 'Last-Event-ID': ready?.id ?? '0' });
  try {
    expect(await resumed.next()).toMatchObject({ event: 'ready', id: ready?.id });
    expect(await promptly(resumed.next())).toMatchObject({ event: 'activity', id });
  } finally {
    await resumed.close();
  }
});
it('reauthorizes before delivering a commit after session revocation', async () => {
  const stream = await connect();
  try {
    expect((await stream.next())?.event).toBe('ready');
    revoked = true;
    const ended = promptly(stream.next());
    await publish();
    expect(await ended).toBeUndefined();
  } finally {
    await stream.close();
  }
});

it('sends only invalidation hints without Activity permission and closes after direct revocation', async () => {
  const peer = await managementFixture(database.db);
  await database.db
    .insertInto('server_subusers')
    .values({
      server_id: serverId,
      user_id: peer.context.subjectUserId,
      permission_keys: JSON.stringify(['files.read']),
      created_by: fixture.context.actorUserId,
    })
    .execute();
  current = peer.context;
  const stream = await connect();
  try {
    expect((await stream.next())?.event).toBe('ready');
    const next = promptly(stream.next());
    await publish('servers.operation.failed');
    expect(await next).toMatchObject({ event: 'activity', data: { serverId } });
    await database.db
      .deleteFrom('server_subusers')
      .where('server_id', '=', serverId)
      .where('user_id', '=', current.subjectUserId)
      .execute();
    const closed = promptly(stream.next());
    await publish();
    expect(await closed).toBeUndefined();
  } finally {
    await stream.close();
  }
});

it('checks access on idle heartbeats without reading history and recovers an unnotified commit', async () => {
  const stream = await connect();
  const realNow = Date.now;
  let offset = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  try {
    expect(await stream.next()).toMatchObject({ event: 'ready', data: { notifications: true } });
    await expect.poll(() => historyReads).toBe(1);
    const initialChecks = checks;
    const id = await publish('servers.operation.succeeded', true);
    await expect.poll(() => checks, { timeout: 7000 }).toBeGreaterThanOrEqual(initialChecks + 2);
    expect(historyReads).toBe(1);
    offset = 16000;
    expect(await promptly(stream.next(), 4500)).toMatchObject({ event: 'activity', id });
    expect(historyReads).toBe(2);
  } finally {
    clock.mockRestore();
    await stream.close();
  }
});

it('polls the durable cursor when a notification listener is unavailable', async () => {
  const stream = await connect(undefined, streamApp(false));
  try {
    expect(await stream.next()).toMatchObject({ event: 'ready', data: { notifications: false } });
    await expect.poll(() => historyReads).toBe(1);
    const id = await publish();
    expect(await promptly(stream.next(), 4500)).toMatchObject({ event: 'activity', id });
    expect(historyReads).toBe(2);
  } finally {
    await stream.close();
  }
});

it('drains multiple cursor pages from one commit and omits a rolled-back insertion', async () => {
  const stream = await connect();
  const values = { server_id: serverId, message_key: 'servers.operation.succeeded', data: '{}' };
  try {
    expect((await stream.next())?.event).toBe('ready');
    await expect.poll(() => historyReads).toBe(1);
    const rollback = new Error('rolled back isolated activity');
    await expect(
      database.db.transaction().execute(async (tx) => {
        await tx.insertInto('server_events').values(values).execute();
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const committed = await database.db.transaction().execute((tx) =>
      tx
        .insertInto('server_events')
        .values(Array.from({ length: 101 }, () => values))
        .returning('id')
        .execute(),
    );
    for (const event of committed)
      expect(await promptly(stream.next())).toMatchObject({ event: 'activity', id: event.id });
    // The initial read and the two pages suffice; rollback does not wake the reader.
    expect(historyReads).toBe(3);
  } finally {
    await stream.close();
  }
});
