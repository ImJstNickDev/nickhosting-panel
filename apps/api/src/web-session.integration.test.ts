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
      secretCodec: new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } }),
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
  it('lists persisted sessions without freshness or tokens and revokes only owned identities', async () => {
    const device = new AuthClient(identity);
    const login = await device.request('/sign-in/email', {
      email: 'member@example.test',
      password,
    });
    expect(login.status).toBe(200);
    const session = await identity.auth.api.getSession({ headers: device.headers() });
    const ownerSession = await identity.auth.api.getSession({ headers: owner.headers() });
    if (!session || !ownerSession) throw new Error('Missing fixture sessions');
    await database.db
      .updateTable('session')
      .set({ createdAt: new Date(Date.now() - 600_000) })
      .where('id', '=', session.session.id)
      .execute();
    const read = await request(device, '/v1/web/account/sessions');
    expect(read.status).toBe(200);
    const rows = await read.json();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.find((row: { current: boolean }) => row.current)?.id).toBe(session.session.id);
    expect(rows.every((row: object) => !('token' in row) && !('userId' in row))).toBe(true);
    expect(rows.some((row: { id: string }) => row.id === ownerSession.session.id)).toBe(false);
    expect((await app.request(`${origin}/v1/web/account/sessions`)).status).toBe(401);
    const remove = (id: string, headers = device.headers()) =>
      app.request(`${origin}/v1/web/account/sessions/${id}`, { method: 'DELETE', headers });
    expect((await remove(ownerSession.session.id)).status).toBe(404);
    expect((await remove('missing-session')).status).toBe(404);
    expect(
      (await remove(session.session.id, device.headers({ origin: 'https://other.example.test' })))
        .status,
    ).toBe(403);
    // An expired browser is absent from the list even if its durable row remains.
    const expired = new AuthClient(identity);
    await expired.request('/sign-in/email', { email: 'member@example.test', password });
    const expiredSession = await identity.auth.api.getSession({ headers: expired.headers() });
    if (!expiredSession) throw new Error('Missing expired fixture');
    await database.db
      .updateTable('session')
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where('id', '=', expiredSession.session.id)
      .execute();
    const active = await (await request(device, '/v1/web/account/sessions')).json();
    expect(active.some((row: { id: string }) => row.id === expiredSession.session.id)).toBe(false);
    expect((await remove(session.session.id)).status).toBe(204);
    expect((await request(device, '/v1/web/account/sessions')).status).toBe(401);
    expect((await request(user, '/v1/web/account/sessions')).status).toBe(200);
    expect(
      (
        await database.db
          .selectFrom('audit_events')
          .select('action')
          .where('actor_user_id', '=', userId)
          .where('action', '=', 'identity.session_revoked')
          .execute()
      ).length,
    ).toBeGreaterThan(0);
  });
  it('exposes only Owner configuration schemas and resets saved overrides under the existing guards', async () => {
    expect((await request(user, '/v1/owner/settings/schema')).status).toBe(403);
    const schema = await request(owner, '/v1/owner/settings/schema');
    expect(schema.status).toBe(200);
    const definition = await schema.json();
    expect(definition.properties.sftpPublicHostname).toBeTruthy();
    expect(definition.properties.gameIdleTimeouts).toMatchObject({
      type: 'object',
      propertyNames: { pattern: '^[a-z][a-z0-9-]{0,63}$' },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runtimeTimeouts: {
            additionalProperties: {
              anyOf: [
                { type: 'number', const: -1 },
                { type: 'integer', minimum: 1, maximum: 604800 },
              ],
            },
          },
        },
      },
    });
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
            minecraftSourceConcurrent: 3,
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
    const legacyReset = await app.request(`${origin}/v1/owner/settings/minecraftSourceConcurrent`, {
      method: 'DELETE',
      headers,
    });
    expect(legacyReset.status).toBe(200);
    expect(await legacyReset.json()).toMatchObject({
      values: { contentSourceConcurrent: 4 },
      sources: { contentSourceConcurrent: 'default' },
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
    expect(
      (await request(owner, '/v1/web/account/sessions', undefined, assistedHeaders())).status,
    ).toBe(403);
    expect(
      (
        await app.request(`${origin}/v1/web/account/sessions/untrusted-id`, {
          method: 'DELETE',
          headers: owner.headers(assistedHeaders()),
        })
      ).status,
    ).toBe(403);
    const recovery = `/v1/owner/users/${userId}/recovery-link`;
    expect((await request(owner, recovery, undefined, assistedHeaders())).status).toBe(403);
    expect((await request(owner, recovery, {}, assistedHeaders())).status).toBe(403);
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
  it('binds recoverable password links to regular Owner proof, target, purpose and expiry', async () => {
    const signed = await owner.request('/sign-in/email', { email: 'owner@example.test', password });
    const ownerId: string = (await signed.json()).user.id;
    await database.pool.query('DELETE FROM identity_throttle WHERE key=$1', [`step-up:${ownerId}`]);
    const path = `/v1/owner/users/${userId}/recovery-link`;
    const proof = async () => {
      const response = await request(owner, '/v1/identity/step-up', {
        password,
        purpose: 'recovery-link',
        subjectUserId: userId,
      });
      expect(response.status).toBe(200);
      return (await response.json()).token as string;
    };
    expect((await request(user, path)).status).toBe(403);
    expect(await (await request(owner, path)).json()).toEqual({ available: true, expiresAt: null });
    expect(await (await request(owner, `/v1/owner/users/${ownerId}/recovery-link`)).json()).toEqual(
      { available: false, expiresAt: null },
    );
    const support = await identity.stepUp(owner.headers(), { password });
    expect(
      (await request(owner, path, { mode: 'create', stepUpToken: support.token })).status,
    ).toBe(403);
    const stepUpToken = await proof();
    const body = { mode: 'create', stepUpToken };
    expect(
      (await request(owner, path, body, { origin: 'https://other.example.test' })).status,
    ).toBe(403);
    expect(
      (
        await request(owner, '/v1/web/support', {
          stepUpToken,
          subjectUserId: userId,
          reason: 'Different action',
        })
      ).status,
    ).toBe(403);
    expect((await request(owner, `/v1/owner/users/${ownerId}/recovery-link`, body)).status).toBe(
      403,
    );
    const before = Date.now();
    const created = await request(owner, path, body);
    expect(created.status).toBe(200);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const { url, expiresAt } = await created.json();
    expect(Date.parse(expiresAt)).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(Date.parse(expiresAt)).toBeLessThanOrEqual(Date.now() + 86_400_000);
    expect((await request(owner, path, body)).status).toBe(403);
    expect(await (await request(owner, path)).json()).toEqual({ available: true, expiresAt });
    const token = new URL(url).searchParams.get('token');
    if (!token) throw new Error('Missing reset token');
    const stored = await database.pool.query(
      'SELECT * FROM verification WHERE owner_recovery_account_id IS NOT NULL',
    );
    expect(stored.rowCount).toBe(1);
    expect(JSON.stringify(stored.rows)).not.toContain(token);
    const reveal = { mode: 'reveal', stepUpToken: await proof() };
    const newExpiry = new Date(Date.now() + 3600_000).toISOString();
    expect(await (await request(owner, path, { ...reveal, expiresAt: newExpiry })).json()).toEqual({
      url,
      expiresAt: newExpiry,
    });
    const action = { token, newPassword: `${password}-updated` };
    expect((await request(user, '/api/auth/reset-password', action)).status).toBe(200);
    expect((await request(user, '/api/auth/reset-password', action)).status).toBe(400);
    expect((await request(user, '/v1/web/session')).status).toBe(401);
    expect(await (await request(owner, path)).json()).toEqual({ available: true, expiresAt: null });
    const fresh = await proof();
    expect((await request(owner, path, { mode: 'reveal', stepUpToken: fresh })).status).toBe(404);
    const regenerated = await request(owner, path, { mode: 'create', stepUpToken: fresh });
    const newUrl = (await regenerated.json()).url;
    expect(newUrl).not.toBe(url);
    await database.pool.query(
      `UPDATE verification SET "expiresAt"=now() - interval '1 second' WHERE owner_recovery_account_id IS NOT NULL`,
    );
    expect(
      (
        await request(user, '/api/auth/reset-password', {
          ...action,
          token: new URL(newUrl).searchParams.get('token'),
        })
      ).status,
    ).toBe(400);
    expect(await (await request(owner, path)).json()).toEqual({ available: true, expiresAt: null });
    const finalGrant = await proof();
    const active = await (
      await request(owner, path, { mode: 'create', stepUpToken: finalGrant })
    ).json();
    expect(
      (
        await user.request('/sign-in/email', {
          email: 'member@example.test',
          password: action.newPassword,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await user.request('/change-password', {
          currentPassword: action.newPassword,
          newPassword: password,
        })
      ).status,
    ).toBe(200);
    expect(await (await request(owner, path)).json()).toEqual({ available: true, expiresAt: null });
    expect(
      (
        await request(user, '/api/auth/reset-password', {
          ...action,
          token: new URL(active.url).searchParams.get('token'),
        })
      ).status,
    ).toBe(400);
    const audit = (
      await database.pool.query(
        "SELECT * FROM audit_events WHERE action LIKE 'identity.recovery_link_%'",
      )
    ).rows;
    expect(audit.length).toBe(4);
    expect(JSON.stringify(audit)).not.toContain(token);
  });
});
