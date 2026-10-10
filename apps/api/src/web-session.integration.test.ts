import { randomBytes } from 'node:crypto';
import { createIdentity, type IdentityMail } from '@nickhosting/auth';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../../packages/auth/src/test-fixtures.js';
import { createApp } from './app.js';

describe('WebPanel parent-bound HttpOnly assisted sessions', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let identity: ReturnType<typeof createIdentity>;
  let app: ReturnType<typeof createApp>;
  let owner: AuthClient, user: AuthClient;
  let userId: string;
  let supportCookie = '';
  const origin = 'http://localhost:3999';
  const password = 'Browser-fixture-password-591!';
  const mails: IdentityMail[] = [];
  async function request(
    client: AuthClient,
    path: string,
    value?: unknown,
    extra: Record<string, string> = {},
  ) {
    const headers = client.headers(extra);
    if (value !== undefined) headers.set('content-type', 'application/json');
    return app.request(`${origin}${path}`, {
      method: value === undefined ? 'GET' : 'POST',
      headers,
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  }
  function assistedHeaders(client = owner) {
    return { cookie: `${client.headers().get('cookie')}; ${supportCookie}` };
  }
  beforeAll(async () => {
    database = await createTestDatabase();
    const bootstrapToken = randomBytes(32).toString('base64url');
    identity = createIdentity({
      pool: database.pool,
      baseURL: origin,
      authSecret: randomBytes(32).toString('base64url'),
      bootstrapToken,
      mail: async (message) => {
        mails.push(message);
      },
      completeSetup: async () => {},
    });
    app = createApp({
      database,
      identity: async () => identity,
      origins: [origin],
      env: { NH_PUBLIC_URL: origin, NH_API_URL: origin },
      codec: new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } }),
    });
    owner = new AuthClient(identity);
    user = new AuthClient(identity);
    await identity.claimOwner({
      token: bootstrapToken,
      name: 'Owner fixture',
      email: 'owner@example.test',
      password,
    });
    const verify = async (client: AuthClient, email: string) => {
      const mail = mails.findLast(
        (entry) => entry.to === email && entry.template === 'verify-email',
      );
      if (!mail) throw new Error('Missing test mail');
      const url = new URL(mail.url);
      const verified = await app.request(url.toString());
      expect(verified.status).toBe(302);
      const signed = await client.request('/sign-in/email', { email, password });
      expect(signed.status).toBe(200);
      return (await signed.json()).user.id as string;
    };
    await verify(owner, 'owner@example.test');
    const invitation = await identity.createInvitation(owner.headers(), {
      email: 'member@example.test',
    });
    expect(
      (
        await user.request(
          '/sign-up/email',
          { name: 'Member fixture', email: 'member@example.test', password },
          { 'x-invitation-token': invitation.token },
        )
      ).status,
    ).toBe(200);
    userId = await verify(user, 'member@example.test');
  });
  afterAll(async () => {
    await database?.destroy();
  });
  it('returns safe readiness and distinct authenticated profile without secrets', async () => {
    const config = await app.request(`${origin}/v1/web/config`);
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({
      auth: { discord: false, email: false, passkey: true, totp: true },
    });
    const profile = await request(user, '/v1/web/session');
    expect(profile.status).toBe(200);
    const json = await profile.json();
    expect(json.subject.id).toBe(userId);
    expect(json.actor.id).toBe(userId);
    expect(JSON.stringify(json)).not.toContain(password);
  });
  it('exposes only Owner configuration schemas and resets saved overrides under the existing guards', async () => {
    expect((await request(user, '/v1/owner/settings/schema')).status).toBe(403);
    const schema = await request(owner, '/v1/owner/settings/schema');
    expect(schema.status).toBe(200);
    expect((await schema.json()).properties.sftpPublicHostname).toBeTruthy();
    const headers = owner.headers();
    headers.set('origin', origin);
    headers.set('content-type', 'application/json');
    expect(
      (
        await app.request(`${origin}/v1/owner/settings`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            instanceName: 'Changed instance',
            sftpPublicHostname: 'sftp.example.test',
            sftpPublicPort: 2022,
          }),
        })
      ).status,
    ).toBe(200);
    const reset = await app.request(`${origin}/v1/owner/settings/instanceName`, {
      method: 'DELETE',
      headers,
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({
      values: { instanceName: 'NickHosting' },
      sources: { instanceName: 'default' },
    });
    expect(
      (await app.request(`${origin}/v1/owner/settings/publicUrl`, { method: 'DELETE', headers }))
        .status,
    ).toBe(409);
    expect(
      (await app.request(`${origin}/v1/owner/settings/notASetting`, { method: 'DELETE', headers }))
        .status,
    ).toBe(400);
  });
  it('requires Origin and regular Owner step-up, never gives browsers a readable support token', async () => {
    const grant = await identity.stepUp(owner.headers(), { password });
    const input = {
      stepUpToken: grant.token,
      subjectUserId: userId,
      reason: 'Browser permission test',
    };
    expect((await request(user, '/v1/web/support', input)).status).toBe(403);
    expect(
      (await request(owner, '/v1/web/support', input, { origin: 'https://other.example.test' }))
        .status,
    ).toBe(403);
    const response = await request(owner, '/v1/web/support', input);
    expect(response.status).toBe(201);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('nh.support='));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Domain=');
    supportCookie = cookie?.split(';')[0] ?? '';
    expect(await response.json()).not.toHaveProperty('token');
  });
  it('uses cookie for API/download authority and forbids ordinary identity/admin changes', async () => {
    const response = await request(owner, '/v1/web/session', undefined, assistedHeaders());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.context).toMatchObject({ subjectUserId: userId, sessionType: 'support' });
    expect(json.actor.name).toBe('Owner fixture');
    expect(json.subject.name).toBe('Member fixture');
    expect((await request(owner, '/v1/owner/settings', undefined, assistedHeaders())).status).toBe(
      403,
    );
    expect(
      (await request(owner, '/api/auth/update-user', { name: 'Changed' }, assistedHeaders()))
        .status,
    ).toBe(403);
    expect((await request(user, '/v1/web/session')).status).toBe(200);
    expect((await request(user, '/v1/web/session', undefined, assistedHeaders(user))).status).toBe(
      403,
    );
    expect(
      (
        await request(owner, '/v1/web/session', undefined, {
          ...assistedHeaders(),
          'x-nh-support-token': 'different-token-which-cannot-authorize',
        })
      ).status,
    ).toBe(403);
  });
  it('Exit revokes the exact server token and clears the cookie without changing target sessions', async () => {
    const response = await request(owner, '/v1/web/support/exit', {}, assistedHeaders());
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie().join(';')).toContain('Max-Age=0');
    expect((await request(owner, '/v1/web/session', undefined, assistedHeaders())).status).toBe(
      403,
    );
    expect((await request(user, '/v1/web/session')).status).toBe(200);
    expect((await request(owner, '/v1/web/session')).status).toBe(200);
  });
  it('a revoked parent session cannot use an otherwise active support cookie', async () => {
    const grant = await identity.stepUp(owner.headers(), { password });
    const response = await request(owner, '/v1/web/support', {
      stepUpToken: grant.token,
      subjectUserId: userId,
      reason: 'Parent revocation test',
    });
    expect(response.status).toBe(201);
    supportCookie =
      response.headers
        .getSetCookie()
        .find((value) => value.startsWith('nh.support='))
        ?.split(';')[0] ?? '';
    expect((await owner.request('/sign-out', {})).status).toBe(200);
    expect((await request(owner, '/v1/web/session', undefined, assistedHeaders())).status).toBe(
      401,
    );
    const exit = await request(owner, '/v1/web/support/exit', {}, assistedHeaders());
    expect(exit.status).toBe(204);
    expect(exit.headers.getSetCookie().join(';')).toContain('Max-Age=0');
    expect((await request(user, '/v1/web/session')).status).toBe(200);
  });
});
