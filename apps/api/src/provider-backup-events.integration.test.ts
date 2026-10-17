import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ProviderBackupEvent, ProviderChange } from '@nickhosting/pterodactyl-adapter';
import {
  enqueueServerOperation,
  linkProviderFeedServer,
  readProviderBackupCompletion,
  registerProviderFeed,
} from '@nickhosting/server-management';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { createApp } from './app.js';
import { createBackupEventStream } from './backup-events-stream.js';
import { PROVIDER_EVENTS_PATH } from './provider-events.js';

describe('signed backup outcomes', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof createApp>;
  let event: ProviderChange;
  let serverId: string;
  let fixture: Awaited<ReturnType<typeof managementFixture>>;
  const identity = vi.fn(async (): Promise<never> => {
    throw new Error('Webhook must not authenticate a browser session');
  });
  const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
  const secret = randomBytes(32).toString('hex');
  const providerUrl = 'https://provider.example.test';
  const publicUrl = 'https://app.example.test';
  beforeAll(async () => {
    database = await createTestDatabase();
    fixture = await managementFixture(database.db);
    serverId = await fixture.server();
    const server = await database.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    if (!server.pterodactyl_id || !server.pterodactyl_uuid || !server.pterodactyl_identifier)
      throw new Error('Missing fixture identity');
    event = {
      schemaVersion: 1,
      eventId: randomUUID(),
      instanceId: randomUUID(),
      server: {
        providerId: server.pterodactyl_id,
        providerUuid: server.pterodactyl_uuid,
        identifier: server.pterodactyl_identifier,
        externalId: server.external_id,
        nodeId: fixture.providerNodeId,
      },
      revision: 1,
      type: 'snapshot',
      limits: { ...fixture.limits, threads: null },
      occurredAt: new Date().toISOString(),
    };
    await database.db
      .updateTable('platform_settings')
      .set({ value: { publicUrl, pterodactylBaseUrl: providerUrl } })
      .where('key', '=', 'platform')
      .execute();
    await registerProviderFeed(database.db, {
      instanceId: event.instanceId,
      providerUrl,
      callbackUrl: new URL(PROVIDER_EVENTS_PATH, publicUrl).href,
    });
    const name = `blueprintWebhook:${event.instanceId}`;
    await database.db
      .insertInto('encrypted_secrets')
      .values({ name, envelope: codec.encrypt(secret, name) })
      .execute();
    await linkProviderFeedServer(database.db, event.instanceId, serverId, event);
    app = createApp({ database, identity, codec, origins: [publicUrl] });
  });
  afterAll(async () => {
    await database?.destroy();
  });
  function signed(value: unknown, patch: Record<string, string> = {}) {
    const raw = JSON.stringify(value);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      raw,
      headers: {
        'content-type': 'application/json',
        'x-nickhosting-timestamp': timestamp,
        'x-nickhosting-signature': createHmac('sha256', secret)
          .update(`${timestamp}.${raw}`)
          .digest('hex'),
        'x-nickhosting-event-id': (value as ProviderChange).eventId,
        ...patch,
      },
    };
  }
  function send(value: unknown, patch: Record<string, string> = {}) {
    const { raw, headers } = signed(value, patch);
    return app.request(`${publicUrl}${PROVIDER_EVENTS_PATH}`, {
      method: 'POST',
      headers,
      body: raw,
    });
  }
  function completion(patch: Partial<ProviderBackupEvent> = {}): ProviderBackupEvent {
    return {
      schemaVersion: 1,
      eventId: randomUUID(),
      instanceId: event.instanceId,
      server: event.server,
      type: 'backup.completed',
      occurredAt: new Date().toISOString(),
      backup: {
        uuid: randomUUID(),
        name: 'backup',
        isSuccessful: true,
        checksum: 'sha256:example',
        bytes: 128,
        completedAt: new Date().toISOString(),
      },
      ...patch,
    };
  }
  it('stores and deduplicates signed outcomes independently of limits revisions', async () => {
    const value = completion();
    expect((await send(value)).status).toBe(200);
    expect((await send(value)).status).toBe(200);
    expect(
      await readProviderBackupCompletion(database.db, serverId, value.backup.uuid, value.type),
    ).toEqual(value);
    const rows = await database.db
      .selectFrom('provider_backup_events')
      .select('event_id')
      .where('event_id', '=', value.eventId)
      .execute();
    expect(rows).toHaveLength(1);
    const limits = await database.db
      .selectFrom('provider_server_projections')
      .select('revision')
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    expect(limits.revision).toBe('1');
    expect(identity).not.toHaveBeenCalled();
  });
  it('accepts delayed authenticated delivery and fences previous restore occurrences', async () => {
    const before = new Date(Date.now() - 3600000).toISOString();
    const value = completion({ type: 'backup.restore-completed', occurredAt: before });
    expect((await send(value)).status).toBe(200);
    expect(
      await readProviderBackupCompletion(
        database.db,
        serverId,
        value.backup.uuid,
        value.type,
        new Date(),
      ),
    ).toBeNull();
  });
  it('rejects forged transport, foreign identities and conflicting reused event IDs', async () => {
    expect((await send(completion(), { 'x-nickhosting-signature': '' })).status).toBe(403);
    expect(
      (
        await send(
          completion({ server: { ...event.server, providerId: event.server.providerId + 100 } }),
        )
      ).status,
    ).toBe(409);
    const value = completion();
    expect((await send(value)).status).toBe(200);
    expect((await send({ ...value, backup: { ...value.backup, bytes: 999 } })).status).toBe(409);
  });
  it('never accepts a backup notification as a limits snapshot or a future outcome', async () => {
    expect((await send({ ...completion(), revision: 1 })).status).toBe(400);
    expect(
      (await send(completion({ occurredAt: new Date(Date.now() + 120000).toISOString() }))).status,
    ).toBe(400);
  });
  it('wakes the active durable job and shares one notification listener across subscribers', async () => {
    const value = completion();
    const operation = await enqueueServerOperation(database.db, fixture.context, serverId, {
      action: 'backup',
      idempotencyKey: randomUUID(),
    });
    await database.db
      .updateTable('server_operations')
      .set({ plan: JSON.stringify({ backupId: value.backup.uuid }), phase: 'backup' })
      .where('job_id', '=', operation.jobId)
      .execute();
    await database.db
      .updateTable('operation_jobs')
      .set({ next_attempt_at: new Date(Date.now() + 60000) })
      .where('id', '=', operation.jobId)
      .execute();
    const stream = createBackupEventStream(database.pool);
    const changed = vi.fn(),
      other = vi.fn(),
      lost = vi.fn();
    const release = await stream.subscribe(serverId, changed, lost);
    const releaseOther = await stream.subscribe(randomUUID(), other, lost);
    try {
      expect((await send(value)).status).toBe(200);
      const job = await database.db
        .selectFrom('operation_jobs')
        .select('next_attempt_at')
        .where('id', '=', operation.jobId)
        .executeTakeFirstOrThrow();
      expect(job.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());
      const outbox = await database.db
        .selectFrom('job_outbox')
        .select('last_dispatched_at')
        .where('job_id', '=', operation.jobId)
        .executeTakeFirstOrThrow();
      expect(outbox.last_dispatched_at).toBeNull();
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      expect(other).not.toHaveBeenCalled();
      expect(lost).not.toHaveBeenCalled();
    } finally {
      release();
      releaseOther();
    }
  });
});
