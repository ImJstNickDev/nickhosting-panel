import { randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { migrate } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureProviderAccounts, resolveProviderCredential } from './provider-accounts.js';
import { registerProviderFeed } from './provider-change-feed.js';
import { createUploadTiming } from './upload-timing.js';

describe('durable technical provider accounts', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 3) } });
  const url = 'https://panel.example.test';
  let instanceId: string;
  let userId: string;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  const env = { NH_PTERODACTYL_BASE_URL: url, NH_PTERODACTYL_APPLICATION_KEY: 'fixture-app-key' };
  beforeEach(async () => {
    database = await createTestDatabase();
    instanceId = randomUUID();
    userId = randomUUID();
    await registerProviderFeed(database.db, {
      instanceId,
      providerUrl: url,
      callbackUrl: 'https://app.example.test/v1/provider-events/pterodactyl',
    });
    await sql`insert into "user"(id,name,email,role) values(${userId},'Owner','owner@example.test','owner')`.execute(
      database.db,
    );
    const providerUuid = randomUUID();
    fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/provision'))
        return Response.json({
          providerId: 42,
          providerUuid,
          externalId: `nh:${instanceId}:${userId}`,
        });
      const body = JSON.parse(String(init?.body));
      return Response.json({
        identifier: 'fixture-key-id',
        key: 'private-client-key',
        operationId: body.operationId,
      });
    });
  });
  afterEach(async () => {
    await database?.destroy();
  });
  const run = () => ensureProviderAccounts(database.db, codec, env, { fetcher });
  const credential = () => resolveProviderCredential(database.db, codec, { userId }, url);
  it('queues owner registration atomically and does not enroll rolled back users', async () => {
    expect(await database.db.selectFrom('provider_accounts').selectAll().execute()).toHaveLength(1);
    const aborted = randomUUID();
    await expect(
      database.db.transaction().execute(async (tx) => {
        await sql`insert into "user"(id,name,email) values(${aborted},'Aborted','aborted@example.test')`.execute(
          tx,
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      await database.db
        .selectFrom('provider_accounts')
        .selectAll()
        .where('user_id', '=', aborted)
        .execute(),
    ).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('enrolls once, encrypts credential and refuses another provider URL', async () => {
    expect(await run()).toEqual({ ready: 1, failed: 0 });
    expect((await credential()).clientApiKey).toBe('private-client-key');
    const timing = createUploadTiming();
    expect(
      (await resolveProviderCredential(database.db, codec, { userId }, url, timing)).clientApiKey,
    ).toBe('private-client-key');
    expect(timing.snapshot()['url.accountRead']?.count).toBe(1);
    expect(timing.snapshot()['url.decrypt']?.count).toBe(1);
    expect(JSON.stringify(timing.snapshot())).not.toMatch(
      /private-client-key|fixture-key-id|panel\.example/,
    );
    expect(await run()).toEqual({ ready: 0, failed: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const row = await database.db
      .selectFrom('provider_accounts')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain('private-client-key');
    await expect(
      resolveProviderCredential(database.db, codec, { userId }, 'https://other.example.test'),
    ).rejects.toThrow();
    await database.db.updateTable('provider_change_feeds').set({ enabled: false }).execute();
    await expect(credential()).rejects.toThrow();
  });
  it('recovers a lost key response with the same operation identity', async () => {
    const original = fetcher.getMockImplementation();
    if (!original) throw new Error('Missing mock');
    let lost = true;
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/keys') && lost) {
        lost = false;
        throw new Error('secret must never be persisted');
      }
      return original(input, init);
    });
    expect(await run()).toEqual({ ready: 0, failed: 1 });
    const failed = await database.db
      .selectFrom('provider_accounts')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(failed.provider_id).toBe(42);
    expect(failed.last_error).toBe('provider_enrollment_failed');
    await database.db
      .updateTable('provider_accounts')
      .set({ retry_at: new Date(0) })
      .execute();
    expect(await run()).toEqual({ ready: 1, failed: 0 });
    const calls = fetcher.mock.calls.filter(([input]) => String(input).endsWith('/keys'));
    expect(calls.map(([, init]) => JSON.parse(String(init?.body)).operationId)).toEqual([
      failed.key_operation_id,
      failed.key_operation_id,
    ]);
  });
  it('serializes concurrent workers and recovers expired leases', async () => {
    await database.db
      .updateTable('provider_accounts')
      .set({
        status: 'provisioning',
        lease_token: randomUUID(),
        lease_until: new Date(Date.now() + 60_000),
      })
      .execute();
    expect(await run()).toEqual({ ready: 0, failed: 0 });
    await database.db
      .updateTable('provider_accounts')
      .set({ lease_until: new Date(0) })
      .execute();
    const results = await Promise.all([run(), run()]);
    expect(results.reduce((n, r) => n + r.ready, 0)).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not accept a foreign external identity', async () => {
    fetcher.mockResolvedValue(
      Response.json({ providerId: 42, providerUuid: randomUUID(), externalId: 'foreign' }),
    );
    expect(await run()).toEqual({ ready: 0, failed: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(credential()).rejects.toThrow();
  });
  it('refuses identity drift after a successful account response but lost key response', async () => {
    const original = fetcher.getMockImplementation();
    if (!original) throw new Error('Missing mock');
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/keys')) throw new Error('lost response');
      return original(input, init);
    });
    await run();
    await database.db
      .updateTable('provider_accounts')
      .set({ retry_at: new Date(0) })
      .execute();
    fetcher.mockResolvedValue(
      Response.json({
        providerId: 43,
        providerUuid: randomUUID(),
        externalId: `nh:${instanceId}:${userId}`,
      }),
    );
    expect(await run()).toEqual({ ready: 0, failed: 1 });
    const saved = await database.db
      .selectFrom('provider_accounts')
      .select('provider_id')
      .executeTakeFirstOrThrow();
    expect(saved.provider_id).toBe(42);
  });
  it('binds encrypted keys to account identity and rejects envelope substitution', async () => {
    await run();
    await database.db
      .updateTable('provider_accounts')
      .set({ key_envelope: codec.encrypt('other-key', 'foreign-context') })
      .execute();
    await expect(credential()).rejects.toThrow();
  });
  it('migration backfills pre-existing Owner accounts without seeding provider accounts remotely', async () => {
    // Reconstruct the immediately preceding schema only in this generated test database.
    await sql`drop trigger user_provider_account on "user"`.execute(database.db);
    await sql`drop function enqueue_provider_account()`.execute(database.db);
    await sql`drop table provider_accounts`.execute(database.db);
    await sql`alter table managed_servers drop column provider_user_id`.execute(database.db);
    await sql`delete from schema_migrations where name = '023_provider_accounts.sql'`.execute(
      database.db,
    );
    expect(await migrate(database.pool)).toEqual(['023_provider_accounts.sql']);
    const rows = await database.db.selectFrom('provider_accounts').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: userId,
      status: 'pending',
      provider_id: null,
      key_envelope: null,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
