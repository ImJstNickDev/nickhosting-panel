import { randomBytes } from 'node:crypto';
import { createIdentity, type IdentityMail } from '@nickhosting/auth';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { runDueSchedules } from '@nickhosting/server-management';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../../packages/auth/src/test-fixtures.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { createApp } from './app.js';

describe('schedule HTTP contracts with real authenticated sessions', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof createApp>;
  let client: AuthClient;
  let serverId: string;
  const origin = 'http://localhost:3999';
  const mails: IdentityMail[] = [];
  const at = new Date(Date.now() + 120_000);
  const input = {
    name: 'Backup',
    action: 'backup',
    timing: { kind: 'once', at: at.toISOString() },
    timeZone: 'Europe/Rome',
    enabled: true,
  };
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    authenticated = true,
    requestOrigin = origin,
  ) {
    const headers = authenticated ? client.headers() : new Headers();
    headers.set('origin', requestOrigin);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await app.request(`${origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (authenticated) client.absorb(response);
    return response;
  }
  beforeAll(async () => {
    database = await createTestDatabase();
    const f = await managementFixture(database.db);
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
    });
    const email = 'scheduler-owner@example.test',
      password = 'Isolated-schedules-password-987!';
    const claim = await request('/v1/setup/owner', 'POST', {
      token: bootstrapToken,
      email,
      password,
      name: 'Owner',
    });
    expect(claim.status).toBe(201);
    const mail = mails.find((entry) => entry.to === email);
    if (!mail) throw new Error('Missing isolated verification mail');
    const link = new URL(mail.url);
    expect((await request(`${link.pathname}${link.search}`)).status).toBe(302);
    const signIn = await request('/api/auth/sign-in/email', 'POST', { email, password });
    expect(signIn.status).toBe(200);
    serverId = await f.server();
  });
  afterAll(async () => {
    await database?.destroy();
  });

  it('enforces cookies, CSRF and strict input without accessing a provider', async () => {
    const url = `/v1/servers/${serverId}/schedules`;
    expect((await request(url, 'GET', undefined, false)).status).toBe(401);
    expect((await request(url, 'POST', input, true, 'https://untrusted.example')).status).toBe(403);
    expect((await request(url, 'POST', { ...input, action: 'wipe' })).status).toBe(400);
    expect((await request(url, 'POST', { ...input, supportOverride: true })).status).toBe(400);
    const consentUrl = `/v1/servers/${serverId}/automation-consent`;
    const consent = await request(consentUrl);
    expect(consent.status).toBe(200);
    expect(await consent.json()).toMatchObject({ allowed: false, gatewayConfigured: false });
    expect(
      (
        await request(
          consentUrl,
          'PUT',
          { allowed: true, expectedIntent: 'manually_stopped' },
          true,
          'https://untrusted.example',
        )
      ).status,
    ).toBe(403);
    expect(
      (await request(consentUrl, 'PUT', { allowed: true, expectedIntent: 'manually_stopped' }))
        .status,
    ).toBe(200);
    expect((await (await request(consentUrl)).json()).allowed).toBe(true);
  });

  it('creates, lists, updates, disables and deletes with current revisions and retained outcomes', async () => {
    const url = `/v1/servers/${serverId}/schedules`;
    const created = await request(url, 'POST', input);
    expect(created.status).toBe(201);
    const schedule = (await created.json()) as { id: string; revision: number };
    const listing = await request(url);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toEqual([
      expect.objectContaining({ id: schedule.id, revision: 1 }),
    ]);
    const updated = await request(`${url}/${schedule.id}`, 'PUT', {
      ...input,
      enabled: false,
      revision: 1,
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).revision).toBe(2);
    expect((await request(`${url}/${schedule.id}`, 'PUT', { ...input, revision: 1 })).status).toBe(
      409,
    );
    expect(await runDueSchedules(database.db, {}, { now: at })).toEqual({
      dispatched: 0,
      skipped: 0,
    });
    expect((await request(`${url}/${schedule.id}`, 'PUT', { ...input, revision: 2 })).status).toBe(
      200,
    );
    expect(await runDueSchedules(database.db, {}, { now: at })).toEqual({
      dispatched: 1,
      skipped: 0,
    });
    const history = await request(`${url}/${schedule.id}/outcomes?limit=1`);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      items: [{ action: 'backup', status: 'dispatched', jobState: 'queued', effectState: 'none' }],
      nextCursor: null,
    });
    expect((await request(`${url}/${schedule.id}`, 'DELETE', { revision: 3 })).status).toBe(204);
    expect(await (await request(url)).json()).toEqual([]);
    expect((await request(`${url}/${schedule.id}/outcomes`)).status).toBe(200);
  });

  it('rejects a revoked real session on subsequent schedule mutations', async () => {
    const authenticated = await client.identity.authenticate(client.headers());
    await database.db.deleteFrom('session').where('id', '=', authenticated.sessionId).execute();
    expect((await request(`/v1/servers/${serverId}/schedules`, 'POST', input)).status).toBe(401);
  });
});
