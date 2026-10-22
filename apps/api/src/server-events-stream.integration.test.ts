import { type AuthContext, DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerServerRoutes } from './servers.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let fixture: Awaited<ReturnType<typeof managementFixture>>;
let serverId: string;
let revoked = false;
let current: AuthContext;
let app: Hono<{ Variables: Variables }>;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await managementFixture(database.db);
  serverId = await fixture.server();
  current = fixture.context;
  app = new Hono<{ Variables: Variables }>();
  registerServerRoutes(app, {
    db: database.db,
    pool: database.pool,
    env: {},
    principal: async () => {
      if (revoked) throw new DomainError('unauthenticated');
      return current;
    },
    management: async () => {
      throw new Error('Unexpected provider access');
    },
    acquireUploadSlot: () => () => {},
  });
});
beforeEach(() => {
  revoked = false;
  current = fixture.context;
});
afterAll(async () => {
  await database?.destroy();
});

async function connect(headers?: Record<string, string>) {
  const response = await app.request(`/v1/servers/${serverId}/events/stream?after=latest`, {
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
async function publish(message = 'servers.operation.succeeded') {
  return database.db.transaction().execute(async (tx) => {
    const event = await tx
      .insertInto('server_events')
      .values({
        server_id: serverId,
        message_key: message,
        data: '{}',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`select pg_notify('nh_server_events_' || md5(current_database() || ':' || current_schema()), ${serverId})`.execute(
      tx,
    );
    return event.id;
  });
}
async function promptly<T>(pending: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Waited for fallback polling')), 1000);
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
