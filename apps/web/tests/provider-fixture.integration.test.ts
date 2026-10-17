import { randomBytes, randomUUID } from 'node:crypto';
import { type AuthContext, authSessionId, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  enqueueServerOperation,
  getPlatformServer,
  listMinecraftWorlds,
} from '@nickhosting/server-management';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { installBrowserFixtures } from './provider-fixture.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let fixture: Awaited<ReturnType<typeof installBrowserFixtures>>;
const env: Record<string, string | undefined> = {};
const ownerId = randomUUID(),
  userId = randomUUID(),
  sessionId = randomUUID();
const context: AuthContext = {
  actorUserId: userId,
  subjectUserId: userId,
  role: 'user',
  sessionType: 'regular',
  ownerElevation: false,
  [authSessionId]: sessionId,
};
beforeAll(async () => {
  database = await createTestDatabase();
  // Test identities only. The real browser harness supplies its actual bootstrap
  // Owner and invited user; installBrowserFixtures never seeds or replaces them.
  await database.db
    .insertInto('user')
    .values([
      {
        id: ownerId,
        name: 'Owner',
        email: 'owner@example.test',
        emailVerified: true,
        role: 'owner',
      },
      { id: userId, name: 'User', email: 'user@example.test', emailVerified: true, role: 'user' },
    ])
    .execute();
  await database.db
    .insertInto('session')
    .values({
      id: sessionId,
      token: randomUUID(),
      userId,
      expiresAt: new Date(Date.now() + 3600000),
    })
    .execute();
  const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
  fixture = await installBrowserFixtures(database, ownerId, userId, env, codec);
});
afterAll(async () => {
  fixture?.dispose();
  await database?.destroy();
});

it('provisions through actual Minecraft verification and preserves the supplied Owner', async () => {
  const server = await database.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', fixture.ids.serverId)
    .executeTakeFirstOrThrow();
  expect(server.installation_state).toBe('installed');
  expect(server.runtime_state).toBe('offline');
  expect(
    await database.db.selectFrom('user').select('id').where('role', '=', 'owner').execute(),
  ).toEqual([{ id: ownerId }]);
  const profile = await database.db
    .selectFrom('minecraft_server_profiles')
    .selectAll()
    .where('server_id', '=', server.id)
    .executeTakeFirstOrThrow();
  expect(profile.installed).toBe(true);
  expect(profile.installed_manifest).not.toEqual([]);
  const worlds = await listMinecraftWorlds(
    database.db,
    fixture.adapter,
    server.id,
    async () => {},
    env,
  );
  expect(worlds).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'world' })]));
  const safe = await getPlatformServer(database.db, context, server.id);
  expect(safe.id).toBe(server.id);
});

it('runs real durable start, stop and backup jobs against the stateful external provider', async () => {
  for (const action of ['start', 'stop', 'backup'] as const) {
    await fixture.management.refreshObservations();
    const operation = await enqueueServerOperation(
      database.db,
      context,
      fixture.ids.serverId,
      { action, idempotencyKey: randomUUID() },
      env,
    );
    const progress = await fixture.processPending();
    const job = await database.db
      .selectFrom('operation_jobs')
      .select(['state', 'error_code'])
      .where('id', '=', operation.jobId)
      .executeTakeFirstOrThrow();
    expect(job, JSON.stringify(progress)).toMatchObject({ state: 'succeeded', error_code: null });
  }
  const server = await database.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', fixture.ids.serverId)
    .executeTakeFirstOrThrow();
  expect(server.intent).toBe('manually_stopped');
  expect(await fixture.adapter.listBackups(server.pterodactyl_identifier ?? '')).toHaveLength(1);
});

it('streams binary files with fresh transfer authorization and reports provider outage', async () => {
  const server = await database.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', fixture.ids.serverId)
    .executeTakeFirstOrThrow();
  let checks = 0;
  const bytes = randomBytes(200000);
  const authorize = async () => {
    checks++;
  };
  const body = new Response(bytes).body;
  if (!body) throw new Error('Fixture stream missing');
  await fixture.adapter.uploadFile(server.pterodactyl_identifier ?? '', 'browser.bin', {
    body,
    contentLength: bytes.length,
    maxBytes: bytes.length,
    authorize,
  });
  const result = await fixture.adapter.downloadFile(
    server.pterodactyl_identifier ?? '',
    'browser.bin',
    { authorize },
  );
  expect(Buffer.from(await new Response(result.body).arrayBuffer())).toEqual(bytes);
  expect(checks).toBeGreaterThan(3);
  fixture.setProviderAvailable(false);
  await expect(fixture.adapter.listApplicationServers()).rejects.toThrow();
  fixture.setProviderAvailable(true);
});

it('refuses new compute against the fixture host limit without powering its remote server', async () => {
  await fixture.setResourcesAvailable(false);
  try {
    await fixture.management.refreshObservations();
    await expect(
      enqueueServerOperation(
        database.db,
        context,
        fixture.ids.serverId,
        { action: 'start', idempotencyKey: randomUUID() },
        env,
      ),
    ).rejects.toMatchObject({ code: 'resources_unavailable' });
    const server = await database.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', fixture.ids.serverId)
      .executeTakeFirstOrThrow();
    expect(
      (await fixture.adapter.getResources(server.pterodactyl_identifier ?? '')).current_state,
    ).toBe('offline');
    expect(server.active_operation_id).toBeNull();
  } finally {
    await fixture.setResourcesAvailable(true);
  }
});
