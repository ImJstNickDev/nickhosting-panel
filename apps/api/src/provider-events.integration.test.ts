import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ProviderChange } from '@nickhosting/pterodactyl-adapter';
import { linkProviderFeedServer, registerProviderFeed } from '@nickhosting/server-management';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { createApp } from './app.js';
import { PROVIDER_EVENTS_PATH } from './provider-events.js';

describe('real Hono provider event receiver', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof createApp>;
  let event: ProviderChange;
  let serverId: string;
  const identity = vi.fn(async (): Promise<never> => {
    throw new Error('Webhook must not authenticate a browser session');
  });
  const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
  const secret = randomBytes(32).toString('hex');
  const providerUrl = 'https://provider.example.test';
  const publicUrl = 'https://app.example.test';
  beforeAll(async () => {
    database = await createTestDatabase();
    const fixture = await managementFixture(database.db);
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
  function change(patch: Partial<ProviderChange> = {}): ProviderChange {
    return { ...event, eventId: randomUUID(), revision: 2, type: 'limits.updated', ...patch };
  }
  it('accepts a signed machine event without cookies/Origin and durably deduplicates retries', async () => {
    const value = change();
    expect((await send(value)).status).toBe(200);
    expect((await send(value)).status).toBe(200);
    const projection = await database.db
      .selectFrom('provider_server_projections')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    expect(projection.revision).toBe('2');
    expect(identity).not.toHaveBeenCalled();
  });
  it('rejects missing signatures even with browser cookies and a permitted Origin', async () => {
    const response = await send(change(), {
      'x-nickhosting-signature': '',
      origin: publicUrl,
      cookie: 'better-auth.session_token=forged',
    });
    expect(response.status).toBe(403);
  });
  it('rejects altered bodies, mismatched event headers and stale timestamps', async () => {
    const value = change();
    const { headers } = signed(value);
    const altered = await app.request(`${publicUrl}${PROVIDER_EVENTS_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...value, revision: 3 }),
    });
    expect(altered.status).toBe(403);
    expect((await send(value, { 'x-nickhosting-event-id': randomUUID() })).status).toBe(400);
    expect(
      (
        await send(value, {
          'x-nickhosting-timestamp': String(Math.floor(Date.now() / 1000) - 120),
        })
      ).status,
    ).toBe(403);
  });
  it('rejects a current provider URL mismatch without updating the projection', async () => {
    await database.db
      .updateTable('platform_settings')
      .set({ value: { publicUrl, pterodactylBaseUrl: 'https://replacement.example.test' } })
      .where('key', '=', 'platform')
      .execute();
    try {
      expect((await send(change())).status).toBe(403);
    } finally {
      await database.db
        .updateTable('platform_settings')
        .set({ value: { publicUrl, pterodactylBaseUrl: providerUrl } })
        .where('key', '=', 'platform')
        .execute();
    }
  });
  it('rejects an unknown link and cannot import another server', async () => {
    const response = await send(
      change({ server: { ...event.server, providerUuid: randomUUID() } }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      await database.db.selectFrom('provider_server_projections').select('server_id').execute(),
    ).toHaveLength(1);
  });
  it('rejects missing JSON type and excessive bodies before processing', async () => {
    expect(
      (await app.request(`${publicUrl}${PROVIDER_EVENTS_PATH}`, { method: 'POST', body: '{}' }))
        .status,
    ).toBe(400);
    expect(
      (
        await app.request(`${publicUrl}${PROVIDER_EVENTS_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: ' '.repeat(65537),
        })
      ).status,
    ).toBe(413);
  });
  it('does not exempt ordinary mutation routes from Origin checks', async () => {
    const response = await app.request(`${publicUrl}/v1/owner/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });
});
