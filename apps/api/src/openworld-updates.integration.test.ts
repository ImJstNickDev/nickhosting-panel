import { randomUUID } from 'node:crypto';
import { DomainError, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import { listOpenworldReleases } from '../../../packages/server-management/src/openworld-catalog.js';
import { readOpenworldScope } from '../../../packages/server-management/src/openworld-telemetry.js';
import { enqueueServerOperation } from '../../../packages/server-management/src/registry.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerOpenworldUpdateRoutes } from './openworld-updates.js';

vi.mock('../../../packages/server-management/src/openworld-catalog.js', async (load) => ({
  ...(await load<typeof import('../../../packages/server-management/src/openworld-catalog.js')>()),
  listOpenworldReleases: vi.fn(),
}));
let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb?.destroy();
});
const source = { version: 'a1.2.9', sha256: 'a'.repeat(64), size: 100 };
const target = { version: 'a1.2.10', sha256: 'b'.repeat(64), size: 101 };
const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 12) } });
async function setup() {
  const db = testDb.db;
  const f = await managementFixture(db, { interactive: true });
  const other = await managementFixture(db, { interactive: true });
  const id = await f.server();
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
    .insertInto('openworld_server_profiles')
    .values({ server_id: id, ...source })
    .execute();
  const route = `/v1/servers/${id}/openworld/update`;
  const app = new Hono<{ Variables: Variables }>();
  let actor = f.context;
  app.onError((e, c) => c.json({ error: e instanceof DomainError ? e.code : 'unexpected' }, 400));
  registerOpenworldUpdateRoutes(app, {
    db,
    principal: async () => actor,
    codec,
    env: { NH_OPENWORLD_UPDATE_NOTICE_SECONDS: '75' },
  });
  vi.mocked(listOpenworldReleases).mockResolvedValue([
    source,
    target,
    { ...target, version: 'pre-a1.2.10-4' },
    { ...target, version: 'a1.1.1' },
  ]);
  const post = (path: string, data: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  return {
    db,
    f,
    id,
    route,
    app,
    post,
    outsider: () => {
      actor = other.context;
    },
  };
}
it('pins the release, keeps one operation across retries and reports a cancellable notice before shutdown', async () => {
  const { db, f, id, route, app, post, outsider } = await setup();
  await db
    .updateTable('managed_servers')
    .set({ runtime_state: 'running' })
    .where('id', '=', id)
    .execute();
  const options = await (await app.request(route)).json();
  expect(options).toMatchObject({
    installedVersion: source.version,
    latestVersion: target.version,
    defaultNoticeSeconds: 75,
    current: null,
  });
  expect(options.releases).toEqual([
    { version: target.version, size: target.size },
    { version: 'pre-a1.2.10-4', size: target.size },
  ]);
  const body = {
    version: target.version,
    expectedVersion: source.version,
    mode: 'timed',
    backupBefore: false,
    idempotencyKey: randomUUID(),
  };
  await expect(
    enqueueServerOperation(db, f.context, id, {
      action: 'reinstall',
      confirm: true,
      backupBefore: false,
      idempotencyKey: randomUUID(),
      openworldVersion: { version: target.version, expectedVersion: source.version, mode: 'timed' },
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  const start = await post(route, body);
  const item = await start.json();
  expect(item).toMatchObject({
    phase: 'preparing',
    fromVersion: source.version,
    toVersion: target.version,
    cancellable: true,
  });
  expect(start.status).toBe(202);
  const op = await db
    .selectFrom('server_operations')
    .select('plan')
    .where('job_id', '=', item.id)
    .executeTakeFirstOrThrow();
  expect(op.plan.openworldUpdate).toEqual({
    source,
    target,
    delaySeconds: 75,
    waitForEmpty: false,
    backupBefore: false,
  });
  expect((await (await app.request(`${route}/current`)).json()).current.id).toBe(item.id);
  vi.mocked(listOpenworldReleases).mockRejectedValueOnce(Error('cold catalog'));
  expect((await (await post(route, body)).json()).id).toBe(item.id);
  vi.mocked(listOpenworldReleases).mockReset();
  const cancel = async () => (await post(`${route}/${item.id}/cancel`, {})).json();
  const tomorrow = new Date(Date.now() + 86_400_000);
  await db
    .updateTable('operation_jobs')
    .set({ next_attempt_at: tomorrow })
    .where('id', '=', item.id)
    .execute();
  await db
    .updateTable('job_outbox')
    .set({ next_dispatch_at: tomorrow, last_dispatched_at: new Date() })
    .where('job_id', '=', item.id)
    .execute();
  expect(await cancel()).toMatchObject({ id: item.id, phase: 'cancelled', cancellable: false });
  const delivery = await db
    .selectFrom('job_outbox')
    .selectAll()
    .where('job_id', '=', item.id)
    .executeTakeFirstOrThrow();
  expect(delivery.next_dispatch_at.getTime()).toBeLessThanOrEqual(Date.now());
  expect(delivery.last_dispatched_at).toBeNull();
  const wake = await db
    .selectFrom('operation_jobs')
    .select('next_attempt_at')
    .where('id', '=', item.id)
    .executeTakeFirstOrThrow();
  expect(wake.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());
  expect(await cancel()).toMatchObject({ phase: 'cancelled' });
  await db
    .updateTable('openworld_server_updates')
    .set({ phase: 'stopping' })
    .where('job_id', '=', item.id)
    .execute();
  expect(await cancel()).toEqual({ error: 'conflict' });
  outsider();
  expect(await (await app.request(`${route}/current`)).json()).toEqual({ error: 'forbidden' });
  expect(await cancel()).toEqual({ error: 'forbidden' });
});
it('keeps historical player records reachable across a verified update while rotating the live scope', async () => {
  const { db, id, route, post } = await setup();
  const body = {
    version: target.version,
    expectedVersion: source.version,
    mode: 'when-empty',
    backupBefore: false,
    idempotencyKey: randomUUID(),
  };
  expect(await (await post(route, { ...body, noticeSeconds: 20 })).json()).toEqual({
    error: 'validation_failed',
  });
  expect(await (await post(route, { ...body, expectedVersion: 'a1.2.8' })).json()).toEqual({
    error: 'conflict',
  });
  const original = await readOpenworldScope(db, id);
  await db
    .updateTable('openworld_server_profiles')
    .set({ ...target, history_sha256: source.sha256 })
    .where('server_id', '=', id)
    .execute();
  const upgraded = await readOpenworldScope(db, id);
  expect(upgraded.binding).not.toBe(original.binding);
  expect(upgraded.liveKey).not.toBe(original.liveKey);
  expect(upgraded.historyBinding).toBe(original.binding);
});
