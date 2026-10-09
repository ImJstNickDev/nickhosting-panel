import { randomBytes, randomUUID } from 'node:crypto';
import { createIdentity, type IdentityMail } from '@nickhosting/auth';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ManagementRuntime } from '@nickhosting/server-management';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../../packages/auth/src/test-fixtures.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { createApp } from './app.js';

describe('Owner health HTTP evidence boundaries', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof createApp>;
  let client: AuthClient;
  let serverId: string;
  const origin = 'http://localhost:3999';
  const mails: IdentityMail[] = [];
  const gatewayId = randomUUID(),
    token = randomBytes(32).toString('base64url');
  async function request(
    path: string,
    body?: unknown,
    authenticated = true,
    extra: Record<string, string> = {},
  ) {
    const headers = authenticated ? client.headers(extra) : new Headers({ origin, ...extra });
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await app.request(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (authenticated) client.absorb(response);
    return response;
  }
  beforeAll(async () => {
    database = await createTestDatabase();
    const f = await managementFixture(database.db);
    f.adapter.listUsers = async () => [
      {
        id: 99,
        uuid: randomUUID(),
        username: 'fixture-user',
        external_id: 'private-external-id',
        root_admin: false,
      },
    ];
    await f.db.deleteFrom('user').where('id', '=', f.owner.actorUserId).execute();
    const bootstrapToken = randomBytes(32).toString('base64url');
    const identity = createIdentity({
      pool: database.pool,
      baseURL: origin,
      authSecret: randomBytes(32).toString('base64url'),
      bootstrapToken,
      mail: async (mail) => {
        mails.push(mail);
      },
      completeSetup: async () => {},
    });
    client = new AuthClient(identity);
    app = createApp({
      database,
      identity: async () => identity,
      codec: new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } }),
      origins: [origin],
      env: {
        NH_GATEWAY_ENABLED: 'true',
        NH_GATEWAY_ID: gatewayId,
        NH_GATEWAY_PHYSICAL_HOST_ID: f.hostId,
        NH_GATEWAY_CONTROL_TOKEN: token,
      },
      management: async () => ({ adapter: f.adapter }) as ManagementRuntime,
    });
    const email = 'health-owner@example.test',
      password = 'Isolated-health-password-987!';
    expect(
      (await request('/v1/setup/owner', { token: bootstrapToken, email, password, name: 'Owner' }))
        .status,
    ).toBe(201);
    const mail = mails.find((entry) => entry.to === email);
    if (!mail) throw new Error('Missing isolated verification mail');
    const link = new URL(mail.url);
    expect((await request(`${link.pathname}${link.search}`)).status).toBe(302);
    expect((await request('/api/auth/sign-in/email', { email, password })).status).toBe(200);
    serverId = await f.server();
  });
  afterAll(async () => {
    await database?.destroy();
  });

  it('requires an ordinary Owner session even on a cached response', async () => {
    expect((await request('/v1/owner/health', undefined, false)).status).toBe(401);
    const response = await request('/v1/owner/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const value = await response.json();
    expect(value.database.status).toBe('healthy');
    expect(value.redis.status).toBe('unconfigured');
    expect(value.gateway.listenerReadiness.status).toBe('unknown');
    expect(JSON.stringify(value)).not.toContain(token);
    expect(
      (
        await request('/v1/owner/health', undefined, true, {
          'x-nh-support-token': 'fixture-support',
        })
      ).status,
    ).toBe(403);
    const authenticated = await client.identity.authenticate(client.headers());
    await database.db
      .updateTable('user')
      .set({ role: 'user' })
      .where('id', '=', authenticated.context.actorUserId)
      .execute();
    expect((await request('/v1/owner/health')).status).toBe(403);
    await database.db
      .updateTable('user')
      .set({ role: 'owner' })
      .where('id', '=', authenticated.context.actorUserId)
      .execute();
  });

  it('records only successful authenticated Gateway control-plane contact', async () => {
    const path = `/internal/gateway/${gatewayId}/configuration`;
    expect((await request(path, undefined, false)).status).toBe(401);
    expect(
      await database.db
        .selectFrom('service_heartbeats')
        .selectAll()
        .where('service', '=', 'gateway')
        .execute(),
    ).toEqual([]);
    expect(
      (
        await request(`/internal/gateway/${gatewayId}/missing`, undefined, false, {
          authorization: `Bearer ${token}`,
        })
      ).status,
    ).toBe(404);
    expect(
      await database.db
        .selectFrom('service_heartbeats')
        .selectAll()
        .where('service', '=', 'gateway')
        .execute(),
    ).toEqual([]);
    expect(
      (await request(path, undefined, false, { authorization: `Bearer ${token}` })).status,
    ).toBe(200);
    const rows = await database.db
      .selectFrom('service_heartbeats')
      .selectAll()
      .where('service', '=', 'gateway')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ instance_id: gatewayId, state: 'contact' });
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('discovers only managed allocation claims and safe provider user identifiers', async () => {
    const allocations = await request(`/v1/owner/servers/${serverId}/allocations`);
    expect(allocations.status).toBe(200);
    expect(await allocations.json()).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        role: 'game',
        backend_address: '10.0.0.2',
        protocols: ['tcp', 'udp'],
      }),
    ]);
    expect((await request(`/v1/owner/servers/${randomUUID()}/allocations`)).status).toBe(404);
    const users = await request('/v1/owner/provider-users');
    expect(users.status).toBe(200);
    expect(await users.json()).toEqual([
      { id: 99, uuid: expect.any(String), username: 'fixture-user' },
    ]);
    const authenticated = await client.identity.authenticate(client.headers());
    await database.db
      .updateTable('user')
      .set({ role: 'user' })
      .where('id', '=', authenticated.context.actorUserId)
      .execute();
    expect((await request(`/v1/owner/servers/${serverId}/allocations`)).status).toBe(403);
    expect((await request('/v1/owner/provider-users')).status).toBe(403);
    await database.db
      .updateTable('user')
      .set({ role: 'owner' })
      .where('id', '=', authenticated.context.actorUserId)
      .execute();
  });
});
