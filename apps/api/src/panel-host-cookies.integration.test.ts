import { randomBytes, randomUUID } from 'node:crypto';
import { createIdentity } from '@nickhosting/auth';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuthClient, totp } from '../../../packages/auth/src/test-fixtures.js';
import { createApp } from './app.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

it('uses host-bound HTTPS session, OAuth, passkey, MFA and support cookies and rejects legacy or duplicate panel credentials', async () => {
  const origin = 'https://panel.hosting.example';
  const bootstrapToken = randomBytes(32).toString('base64url');
  const codec = new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } });
  const identity = createIdentity({
    pool: database.pool,
    authSecret: randomBytes(32).toString('base64url'),
    secretCodec: codec,
    baseURL: origin,
    publicURL: origin,
    bootstrapToken,
    mail: async () => {},
    completeSetup: async () => {},
    discord: { clientId: 'fixture', clientSecret: 'fixture' },
  });
  const app = createApp({ database, identity: async () => identity, origins: [origin], codec });
  const email = 'owner@hosting.example';
  const password = 'Fixture-host-cookie-login-2026!';
  const ownerId = (
    await identity.claimOwner({ token: bootstrapToken, name: 'Owner', email, password })
  ).userId;
  await database.db
    .updateTable('user')
    .set({ emailVerified: true })
    .where('id', '=', ownerId)
    .execute();
  const owner = new AuthClient(identity, origin);
  const login = await owner.request('/sign-in/email', { email, password });
  expect(login.status).toBe(200);
  function hostCookie(response: Response, prefix: string) {
    const header = response.headers.getSetCookie().find((x) => x.startsWith(prefix));
    expect(header).toBeTruthy();
    expect(header).toMatch(/; Secure(?:;|$)/i);
    expect(header).toMatch(/; Path=\/(?:;|$)/i);
    expect(header).not.toMatch(/; Domain=/i);
    return header?.split(';')[0] ?? '';
  }
  const session = hostCookie(login, '__Host-nh-auth.session_token=');
  const value = session.slice(session.indexOf('=') + 1);
  const legacy = `__Secure-better-auth.session_token=${value}`;
  const me = (cookie: string) => app.request(`${origin}/v1/me`, { headers: { cookie, origin } });
  expect((await me(legacy)).status).toBe(401);
  expect((await me(`${session}; ${session}`)).status).toBe(401);
  expect((await me(`${legacy}; nh.support=from-sibling; ${session}`)).status).toBe(200);
  expect(
    await identity.auth.api.getSession({ headers: new Headers({ cookie: legacy }) }),
  ).toBeNull();

  const social = await owner.request('/sign-in/social', { provider: 'discord', callbackURL: '/' });
  expect(social.status).toBe(200);
  hostCookie(social, '__Host-nh-auth.state=');
  const challenge = await owner.request('/passkey/generate-authenticate-options');
  expect(challenge.status).toBe(200);
  hostCookie(challenge, '__Host-nh-auth.');

  const member = randomUUID();
  await sql`INSERT INTO "user"(id,name,email,"emailVerified") VALUES (${member},'Member','member@hosting.example',true)`.execute(
    database.db,
  );
  const step = await identity.stepUp(owner.headers(), { password });
  const grant = await app.request(`${origin}/v1/web/support`, {
    method: 'POST',
    headers: owner.headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      stepUpToken: step.token,
      subjectUserId: member,
      reason: 'Isolated cookie fixture',
    }),
  });
  expect(grant.status).toBe(201);
  const support = hostCookie(grant, '__Host-nh-support=');
  const assisted = await me(`${session}; ${support}`);
  expect(await assisted.json()).toMatchObject({
    identity: { subjectUserId: member, sessionType: 'support' },
  });
  expect((await me(`${session}; ${support}; ${support}`)).status).toBe(401);

  const enrollment = await owner.request('/two-factor/enable', { password });
  expect(enrollment.status).toBe(200);
  const data = (await enrollment.json()) as { totpURI: string };
  const secret = new URL(data.totpURI).searchParams.get('secret') ?? '';
  expect((await owner.request('/two-factor/verify-totp', { code: totp(secret) })).status).toBe(200);
  const mfa = new AuthClient(identity, origin);
  const stepOne = await mfa.request('/sign-in/email', { email, password });
  hostCookie(stepOne, '__Host-nh-auth.two_factor=');
  const stepTwo = await mfa.request('/two-factor/verify-totp', {
    code: totp(secret),
    trustDevice: true,
  });
  expect(stepTwo.status).toBe(200);
  hostCookie(stepTwo, '__Host-nh-auth.session_token=');
  hostCookie(stepTwo, '__Host-nh-auth.trust_device=');
});
