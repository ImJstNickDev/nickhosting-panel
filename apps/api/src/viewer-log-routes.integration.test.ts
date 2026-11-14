import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AuthContext, authSessionId, DomainError, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { authorizeServer, type ManagementRuntime } from '@nickhosting/server-management';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { ViewerCache } from './viewer-cache.js';
import { registerLogViewerRoutes } from './viewer-log-routes.js';
import type { ViewerLogSessions } from './viewer-log-sessions.js';
import type { FileViewerService } from './viewer-service.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let fixture: Awaited<ReturnType<typeof managementFixture>>;
let app: Hono<{ Variables: Variables }>,
  actor: AuthContext,
  id: string,
  root: string,
  cache: ViewerCache,
  sessions: ViewerLogSessions;
let content: Buffer,
  revision: number,
  downloads: number,
  checks: number,
  denied: boolean,
  binding: string,
  revocation: AbortController;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.destroy();
});
beforeEach(async () => {
  fixture = await managementFixture(database.db, { interactive: true });
  id = await fixture.server();
  actor = { ...fixture.context, [authSessionId]: 'browser-session' };
  root = await mkdtemp(join(tmpdir(), 'nh-log-routes-'));
  cache = new ViewerCache({ root });
  content = Buffer.from(
    Array.from(
      { length: 1200 },
      (_, i) => `LogGame: ${i === 20 ? 'Error' : 'Display'}: line ${i + 1}`,
    ).join('\n'),
  );
  revision = 1;
  downloads = 0;
  checks = 0;
  denied = false;
  binding = 'binding';
  revocation = new AbortController();
  const runtime = {
    fileReadAccess: async (
      context: AuthContext,
      serverId: string,
      work: (identifier: string, db: unknown, actor: AuthContext, server: unknown) => unknown,
    ) => {
      checks++;
      if (denied) throw new DomainError('forbidden');
      const server = await authorizeServer(database.db, context, serverId, 'server:read');
      return work('fixture', database.db, context, server);
    },
    uploadBatchBinding: () => binding,
  } as unknown as ManagementRuntime;
  const viewer = {
    open: vi.fn(
      async (_context: AuthContext, _runtime: ManagementRuntime, _id: string, path: string) => {
        const bytes = content,
          version = revision;
        return {
          source: {
            size: bytes.length,
            mtimeMs: version,
            read: async (offset: number, length: number) => bytes.subarray(offset, offset + length),
            stream: () => {
              downloads++;
              return new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              });
            },
          },
          path,
          cache,
          key: `${id}:${path}:${version}`,
          signal: revocation.signal,
          close: async () => {},
          restat: async () => ({ size: content.length, mtimeMs: revision }),
          siblingExists: async () => false,
        };
      },
    ),
  } as unknown as FileViewerService;
  app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'internal_error' },
      error instanceof DomainError ? (error.status as 400) : 500,
    ),
  );
  sessions = registerLogViewerRoutes(
    app,
    {
      db: database.db,
      codec: new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 1) } }),
      env: {},
      principal: async () => actor,
      management: async () => runtime,
      acquireUploadSlot: () => () => {},
    },
    async () => viewer,
  );
});
afterEach(async () => {
  await sessions.close();
  await cache.close();
  await rm(root, { recursive: true, force: true });
});
const req = (suffix = '', body: unknown = {}, method = 'POST') =>
  app.request(`/v1/servers/${id}/files/viewer/log/session${suffix}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
  });
const open = async () => {
  const response = await req('', { path: 'FactoryGame/Saved/Logs/FactoryGame.log' });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ sessionId: string; revision: string }>;
};
describe('authorized full log routes', () => {
  it('pages and searches the entire disk snapshot with one download and fresh access checks', async () => {
    const tab = await open();
    expect(downloads).toBe(1);
    const first = await (await req(`/${tab.sessionId}/page`, { offset: 0, limit: 200 })).json();
    const next = await (await req(`/${tab.sessionId}/page`, { offset: 200, limit: 200 })).json();
    const found = await (
      await req(`/${tab.sessionId}/page`, { query: 'line 21', level: 'error' })
    ).json();
    expect(first.rows[0].line).toBe(1);
    expect(next.rows[0].line).toBe(201);
    expect(found.rows[0].line).toBe(21);
    expect(first.totalLines).toBe(1200);
    expect(downloads).toBe(1);
    expect(checks).toBe(4);
    expect((await req(`/${tab.sessionId}/renew`)).status).toBe(204);
    expect(downloads).toBe(1);
  });
  it('denies another authenticated browser session and rechecks revoked permission before cached reads', async () => {
    const tab = await open();
    actor = { ...actor, [authSessionId]: 'other-browser' };
    expect((await req(`/${tab.sessionId}/page`)).status).toBe(404);
    actor = { ...actor, [authSessionId]: 'browser-session' };
    denied = true;
    expect((await req(`/${tab.sessionId}/page`)).status).toBe(403);
    denied = false;
    expect((await req(`/${tab.sessionId}/page`)).status).toBe(404);
    expect(downloads).toBe(1);
  });
  it('shares tabs and deletes snapshot after the last explicit close', async () => {
    const first = await open(),
      second = await open();
    expect(downloads).toBe(1);
    await req(`/${first.sessionId}`, {}, 'DELETE');
    expect((await req(`/${second.sessionId}/page`)).status).toBe(200);
    await req(`/${second.sessionId}`, {}, 'DELETE');
    const dirs = await readdir(root);
    const files = await readdir(join(root, dirs[0] ?? 'missing'));
    expect(files.filter((file) => !file.startsWith('.'))).toEqual([]);
    expect((await req(`/${second.sessionId}/page`)).status).toBe(404);
  });
  it('refreshes changed snapshots once and retains the prior snapshot on invalid replacement', async () => {
    const tab = await open();
    expect((await (await req(`/${tab.sessionId}/refresh`)).json()).changed).toBe(false);
    expect(downloads).toBe(1);
    content = Buffer.from('new first\nnew last');
    revision++;
    expect((await (await req(`/${tab.sessionId}/refresh`)).json()).changed).toBe(true);
    const page = await (await req(`/${tab.sessionId}/page`)).json();
    expect(page.rows[1].text).toBe('new last');
    expect(downloads).toBe(2);
    content = Buffer.from([0xff]);
    revision++;
    expect((await req(`/${tab.sessionId}/refresh`)).status).toBe(422);
    expect((await (await req(`/${tab.sessionId}/page`)).json()).rows[1].text).toBe('new last');
  });
  it('rejects changed provider binding and malformed queries without serving cached data', async () => {
    const tab = await open();
    expect((await req(`/${tab.sessionId}/page`, { limit: 501 })).status).toBe(400);
    binding = 'migrated';
    expect((await req(`/${tab.sessionId}/renew`)).status).toBe(403);
    expect((await req(`/${tab.sessionId}/page`)).status).toBe(404);
  });
  it('removes sessions on the existing revocation signal', async () => {
    const tab = await open();
    revocation.abort();
    await vi.waitFor(async () => expect((await req(`/${tab.sessionId}/page`)).status).toBe(404));
  });
});
