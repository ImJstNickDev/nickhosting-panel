import { randomBytes } from 'node:crypto';
import { createIdentity, type IdentityMail } from '@nickhosting/auth';
import { SecretCodec } from '@nickhosting/core';
import { saveBootstrapConfiguration } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import { validateConnection } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

describe('Hono public backend contracts', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof createApp>;
  const mails: IdentityMail[] = [];
  const token = randomBytes(32).toString('base64url');
  const password = 'Fixture-long-password-593!';
  const cookies = new Map<string, string>();
  const logs: unknown[] = [];
  const applicationKey = randomBytes(32).toString('base64url');
  const codec = new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ object: 'list', data: [] }));
  async function request(
    path: string,
    data?: unknown,
    options: { method?: string; authenticated?: boolean; headers?: Record<string, string> } = {},
  ) {
    const headers = new Headers({ origin: 'http://localhost:3999', ...options.headers });
    if (data !== undefined) headers.set('content-type', 'application/json');
    if (options.authenticated !== false)
      headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const response = await app.request(`http://localhost:3999${path}`, {
      method: options.method ?? (data === undefined ? 'GET' : 'POST'),
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (options.authenticated !== false)
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(';')[0] ?? '';
        const at = pair.indexOf('=');
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
    return response;
  }
  beforeAll(async () => {
    database = await createTestDatabase();
    const identity = createIdentity({
      pool: database.pool,
      baseURL: 'http://localhost:3999',
      authSecret: randomBytes(32).toString('base64url'),
      bootstrapToken: token,
      mail: async (message) => {
        mails.push(message);
      },
      completeSetup: async (tx, input, actor) => {
        await validateConnection(
          { baseURL: input.pterodactylBaseURL, applicationKey: input.pterodactylApplicationKey },
          fetcher,
        );
        await saveBootstrapConfiguration(tx, codec, input, actor);
      },
    });
    app = createApp({
      database,
      identity: async () => identity,
      codec,
      origins: ['http://localhost:3999', 'http://localhost:4000'],
      log: (event) => logs.push(event),
    });
  });
  afterAll(async () => {
    if (database) await database.destroy();
  });

  it('provides health/status and localized safe errors with mandatory CSRF checks', async () => {
    expect((await request('/healthz')).status).toBe(200);
    expect((await request('/v1/setup')).status).toBe(200);
    expect(
      (
        await request(
          '/v1/setup/owner',
          {},
          { headers: { origin: 'https://attacker.example.com' } },
        )
      ).status,
    ).toBe(403);
    const forbidden = await request('/v1/owner/settings', undefined, {
      headers: { 'accept-language': 'it' },
    });
    expect(forbidden.status).toBe(401);
    const error = await forbidden.json();
    expect(error.error.message).toBeTruthy();
    expect(error.error.code).toBe('unauthenticated');
    expect(forbidden.headers.get('cache-control')).toBe('no-store');
    expect((await request('/v1/setup/owner', { value: 'x'.repeat(70000) })).status).toBe(413);
  });
  it('permits browser invitation preflight only from configured frontend origins', async () => {
    const response = await request('/api/auth/sign-up/email', undefined, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:4000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-invitation-token,content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:4000');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'x-invitation-token',
    );
  });

  it('creates first Owner, verifies email, signs in and gates setup secrets behind identity', async () => {
    expect(
      (
        await request('/v1/setup/owner', {
          token,
          name: 'Owner',
          email: 'api-owner@example.com',
          password,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request('/v1/setup/complete', {
          instanceName: 'Fixture',
          pterodactylBaseURL: 'https://panel.example.com',
          pterodactylApplicationKey: applicationKey,
        })
      ).status,
    ).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(0);
    const mail = mails.find((m) => m.template === 'verify-email');
    if (!mail) throw new Error('Missing verification fixture');
    const url = new URL(mail.url);
    expect((await request(`${url.pathname}${url.search}`)).status).toBe(302);
    expect(
      (await request('/api/auth/sign-in/email', { email: 'api-owner@example.com', password }))
        .status,
    ).toBe(200);
    // Regression: settings legitimately edited between Owner claim and completion.
    expect(
      (await request('/v1/owner/settings', { defaultLocale: 'it' }, { method: 'PATCH' })).status,
    ).toBe(200);
    expect(
      (
        await request('/v1/setup/complete', {
          instanceName: 'Fixture',
          pterodactylBaseURL: 'https://panel.example.com',
          pterodactylApplicationKey: applicationKey,
        })
      ).status,
    ).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const settings = await (await request('/v1/owner/settings')).json();
    expect(settings.config.values.defaultLocale).toBe('it');
    expect(JSON.stringify(settings)).not.toContain(applicationKey);
    expect(JSON.stringify(logs)).not.toContain(applicationKey);
  });
  it('keeps raw auth protected from invite bypass and support identity', async () => {
    const result = await request(
      '/api/auth/sign-up/email',
      { name: 'Bypass', email: 'api-bypass@example.com', password },
      { authenticated: false },
    );
    expect(result.status).toBe(400);
    expect(
      (
        await database.pool.query('SELECT id FROM "user" WHERE email=$1', [
          'api-bypass@example.com',
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await request('/api/auth/get-session', undefined, {
          headers: { 'x-nh-support-token': 'invalid-support-token' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/v1/owner/settings', undefined, {
          headers: { 'x-nh-support-token': 'invalid-support-token' },
        })
      ).status,
    ).toBe(403);
  });
  it('submits actual durable jobs and checks protected status, payload validation and audit', async () => {
    const command = {
      type: 'foundation.record-activity',
      version: 1,
      payload: { source: 'user_request' },
    };
    const result = await request('/v1/jobs', { idempotencyKey: 'api-fixture', command });
    expect(result.status).toBe(202);
    const job = await result.json();
    expect((await request(`/v1/jobs/${job.id}`)).status).toBe(200);
    expect((await request(`/v1/jobs/${job.id}`, undefined, { authenticated: false })).status).toBe(
      401,
    );
    expect(
      (
        await request('/v1/jobs', {
          idempotencyKey: 'bad',
          command: { ...command, payload: { token: 'not-accepted' } },
        })
      ).status,
    ).toBe(400);
    expect((await request('/v1/owner/audit')).status).toBe(200);
  });
  it('correlates support requests with the temporary support identity', async () => {
    await database.pool.query(
      `INSERT INTO "user"(id,name,email) VALUES ('api-subject','Subject','api-subject@example.com')`,
    );
    const proof = await (await request('/v1/identity/step-up', { password })).json();
    const opened = await request('/v1/support', {
      stepUpToken: proof.token,
      subjectUserId: 'api-subject',
      reason: 'Fixture support request',
    });
    expect(opened.status).toBe(201);
    const support = await opened.json();
    const viewed = await request('/v1/me', undefined, {
      headers: { 'x-nh-support-token': support.token },
    });
    expect(viewed.status).toBe(200);
    const context = (await viewed.json()).identity;
    expect(context.subjectUserId).toBe('api-subject');
    expect(context.actorUserId).not.toBe('api-subject');
    const audit = await database.pool.query(
      "SELECT actor_user_id,subject_user_id,correlation_id FROM audit_events WHERE action='support.request'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      correlation_id: support.id,
      subject_user_id: 'api-subject',
      actor_user_id: context.actorUserId,
    });
    expect((await request('/v1/support/exit', { token: support.token })).status).toBe(204);
    expect(
      (await request('/v1/me', undefined, { headers: { 'x-nh-support-token': support.token } }))
        .status,
    ).toBe(403);
  });

  it('localizes OAuth callback errors and never returns attacker descriptions', async () => {
    const response = await request(
      '/api/auth/error?error=INVITATION_INVALID&error_description=private-fixture-value',
      undefined,
      { headers: { 'accept-language': 'it' } },
    );
    expect(response.status).toBe(400);
    const content = await response.json();
    expect(content.error.messageKey).toBe('errors.invitation_invalid');
    expect(JSON.stringify(content)).not.toContain('private-fixture-value');
    expect((await request('/api/auth/error?error=unknown-private-code')).status).toBe(400);
  });

  it('cannot bypass login limits using forged public or internal IP headers', async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const response = await request(
        '/api/auth/sign-in/email',
        { email: 'api-owner@example.com', password: 'Wrong-password-fixture' },
        {
          authenticated: false,
          headers: {
            'x-forwarded-for': `198.51.100.${i}`,
            'x-real-ip': `198.51.100.${i}`,
            'x-nh-client-ip': `198.51.100.${i}`,
          },
        },
      );
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
    expect(statuses).not.toContain(200);
  });
});
