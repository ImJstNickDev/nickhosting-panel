import { randomBytes } from 'node:crypto';
import { assertAuthContext } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IdentityMail, IdentityOptions } from './contracts.js';
import { tokenHash } from './crypto.js';
import { createIdentity } from './index.js';
import { AuthClient, SoftwareAuthenticator, totp } from './test-fixtures.js';

describe('real PostgreSQL identity boundaries', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let identity: ReturnType<typeof createIdentity>;
  let identityOptions: IdentityOptions;
  let owner: AuthClient;
  let ownerId: string;
  const mails: IdentityMail[] = [];
  const bootstrapToken = randomBytes(32).toString('base64url');
  const password = 'A-valid-fixture-password-813!';
  const profiles = new Map<string, { id: string; email: string | null; verified: boolean }>();

  async function verifyEmail(address: string, client: AuthClient) {
    const mail = mails.findLast(
      (message) => message.to === address && message.template === 'verify-email',
    );
    expect(mail).toBeDefined();
    if (!mail) throw new Error('Expected fixture email');
    const url = new URL(mail.url);
    const response = await client.request(`/verify-email${url.search}`);
    expect(response.status).toBe(302);
  }
  async function invitation(overrides: Record<string, unknown> = {}) {
    return identity.createInvitation(owner.headers(), {
      expiresAt: new Date(Date.now() + 3600_000),
      ...overrides,
    });
  }
  async function signup(address: string, invite?: string) {
    const client = new AuthClient(identity);
    const response = await client.request(
      '/sign-up/email',
      { email: address, password, name: 'Fixture User' },
      invite ? { 'x-invitation-token': invite } : undefined,
    );
    return { client, response };
  }
  async function registered(address: string) {
    const invite = await invitation();
    const result = await signup(address, invite.token);
    expect(result.response.status).toBe(200);
    await verifyEmail(address, result.client);
    const response = await result.client.request('/sign-in/email', { email: address, password });
    expect(response.status).toBe(200);
    return result.client;
  }
  async function oauth(
    client: AuthClient,
    code: string,
    invite?: string,
    linking = false,
    additionalData?: object,
  ) {
    const start = await client.request(
      linking ? '/link-social' : '/sign-in/social',
      { provider: 'discord', callbackURL: '/', additionalData },
      invite ? { 'x-invitation-token': invite } : undefined,
    );
    expect(start.status).toBe(200);
    const body = (await start.json()) as { url: string };
    const state = new URL(body.url).searchParams.get('state');
    expect(state).toBeTruthy();
    if (!state) throw new Error('Expected fixture OAuth state');
    return client.request(
      `/callback/discord?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    );
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://discord.com/api/oauth2/token') {
        const code = new URLSearchParams(String(init?.body)).get('code');
        return Response.json({
          access_token: code,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'identify email',
        });
      }
      if (
        decodeURI(url) === 'https://discord.com/api/users/@me' ||
        url === 'https://discord.com/api/users/%40me'
      ) {
        const authorization = new Headers(init?.headers).get('authorization') ?? '';
        const profile = profiles.get(authorization.replace('Bearer ', ''));
        return Response.json({
          ...profile,
          username: 'fixture-discord',
          global_name: 'Fixture Discord',
          discriminator: '0',
          avatar: null,
        });
      }
      throw new Error(
        `Unexpected external request: ${new URL(url).hostname}${new URL(url).pathname}`,
      );
    });
    identityOptions = {
      pool: database.pool,
      baseURL: 'http://localhost:3999',
      authSecret: randomBytes(32).toString('base64url'),
      bootstrapToken,
      mail: async (message) => {
        mails.push(message);
      },
      discord: { clientId: 'fixture-client', clientSecret: randomBytes(32).toString('base64url') },
      completeSetup: async (tx, input, actor) => {
        // This fixture replaces the external Pterodactyl connection, never production logic.
        await tx.query('SELECT $1::text, $2::text', [input.instanceName, actor]);
      },
    };
    identity = createIdentity(identityOptions);
    owner = new AuthClient(identity);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    if (database) await database.destroy();
  });

  it('migrations seed no identity; Owner bootstrap is protected and exactly one concurrent claim wins', async () => {
    expect((await database.pool.query('SELECT * FROM "user"')).rowCount).toBe(0);
    expect(await identity.bootstrapStatus()).toEqual({ ownerClaimed: false, completed: false });
    await expect(
      identity.claimOwner({
        token: randomBytes(32).toString('base64url'),
        email: 'wrong@example.com',
        name: 'Wrong',
        password,
      }),
    ).rejects.toMatchObject({ code: 'setup_token_invalid' });
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) =>
        identity.claimOwner({
          token: bootstrapToken,
          email: `owner${index}@example.com`,
          name: 'Owner',
          password,
        }),
      ),
    );
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      attempts
        .filter((result) => result.status === 'rejected')
        .map((result) => (result as PromiseRejectedResult).reason.code),
    ).toEqual(['setup_completed', 'setup_completed', 'setup_completed']);
    const user = (
      await database.pool.query<{ id: string; email: string }>(
        'SELECT id,email FROM "user" WHERE role=\'owner\'',
      )
    ).rows[0];
    if (!user) throw new Error('Expected fixture Owner');
    ownerId = user.id;
    await verifyEmail(user.email, owner);
    expect((await owner.request('/sign-in/email', { email: user.email, password })).status).toBe(
      200,
    );
    expect((await identity.authenticate(owner.headers())).context.role).toBe('owner');
    await identity.completeSetup(owner.headers(), {
      instanceName: 'Fixture',
      pterodactylBaseURL: 'https://panel.example.com',
      pterodactylApplicationKey: randomBytes(32).toString('base64url'),
    });
    expect(await identity.bootstrapStatus()).toEqual({ ownerClaimed: true, completed: true });
    await expect(
      identity.completeSetup(owner.headers(), {
        instanceName: 'Second',
        pterodactylBaseURL: 'https://panel.example.com',
        pterodactylApplicationKey: randomBytes(32).toString('base64url'),
      }),
    ).rejects.toMatchObject({ code: 'setup_completed' });
  });

  it('rejects direct credential signup without an invitation and ignores client role escalation', async () => {
    expect((await signup('bypass@example.com')).response.status).toBe(400);
    expect(
      (await database.pool.query('SELECT id FROM "user" WHERE email=$1', ['bypass@example.com']))
        .rowCount,
    ).toBe(0);
    const invite = await invitation();
    const client = new AuthClient(identity);
    const response = await client.request(
      '/sign-up/email',
      { email: 'role@example.com', name: 'Role', password, role: 'owner' },
      { 'x-invitation-token': invite.token },
    );
    expect(response.status).toBe(200);
    expect(
      (await database.pool.query('SELECT role FROM "user" WHERE email=$1', ['role@example.com']))
        .rows[0]?.role,
    ).toBe('user');
    expect(
      (await client.request('/sign-in/email', { email: 'role@example.com', password })).status,
    ).toBe(403);
  });

  it('validates revoked, expired, invalid, email-bound and exhausted invitations', async () => {
    await expect(
      identity.inspectInvitation(randomBytes(32).toString('base64url')),
    ).rejects.toMatchObject({ code: 'invitation_invalid' });
    const revoked = await invitation();
    await identity.revokeInvitation(owner.headers(), revoked.id);
    await expect(identity.inspectInvitation(revoked.token)).rejects.toMatchObject({
      code: 'invitation_revoked',
    });
    expect((await signup('revoked@example.com', revoked.token)).response.status).toBe(400);
    const expired = await invitation();
    await database.pool.query(
      'UPDATE invitation SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1',
      [expired.id],
    );
    await expect(identity.inspectInvitation(expired.token)).rejects.toMatchObject({
      code: 'invitation_expired',
    });
    expect((await signup('expired@example.com', expired.token)).response.status).toBe(400);
    const bound = await invitation({ email: 'bound@example.com' });
    expect((await signup('mismatch@example.com', bound.token)).response.status).toBe(400);
    expect((await signup('bound@example.com', bound.token)).response.status).toBe(200);
    await expect(identity.inspectInvitation(bound.token)).rejects.toMatchObject({
      code: 'invitation_exhausted',
    });
    expect((await signup('reuse@example.com', bound.token)).response.status).toBe(400);
  });

  it('consumes invitations atomically under concurrent credential signups', async () => {
    const invite = await invitation();
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) => signup(`race${index}@example.com`, invite.token)),
    );
    expect(responses.filter(({ response }) => response.status === 200)).toHaveLength(1);
    expect(
      (await database.pool.query('SELECT "remainingUses" FROM invitation WHERE id=$1', [invite.id]))
        .rows[0]?.remainingUses,
    ).toBe(0);
    expect(
      (await database.pool.query('SELECT id FROM "user" WHERE email LIKE \'race%@example.com\''))
        .rowCount,
    ).toBe(1);
    expect(
      (await identity.listInvitations(owner.headers())).every((row) => !('tokenHash' in row)),
    ).toBe(true);
  });

  it('OAuth cannot create an account with absent/spoofed invite; server OAuth state permits a real invitation', async () => {
    profiles.set('discord-no-invite', {
      id: '123456789012345678',
      email: 'oauth-bypass@example.com',
      verified: true,
    });
    const attacker = new AuthClient(identity);
    const invite = await invitation();
    await oauth(attacker, 'discord-no-invite', undefined, false, {
      serverContext: { invitationHash: tokenHash(invite.token) },
      invitationHash: tokenHash(invite.token),
    });
    expect(
      (
        await database.pool.query('SELECT id FROM "user" WHERE email=$1', [
          'oauth-bypass@example.com',
        ])
      ).rowCount,
    ).toBe(0);
    profiles.set('discord-valid', {
      id: '223456789012345678',
      email: 'discord@example.com',
      verified: true,
    });
    const client = new AuthClient(identity);
    const response = await oauth(client, 'discord-valid', invite.token);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect((await identity.authenticate(client.headers())).context.role).toBe('user');
    await expect(identity.inspectInvitation(invite.token)).rejects.toMatchObject({
      code: 'invitation_exhausted',
    });
    const again = new AuthClient(identity);
    await oauth(again, 'discord-valid');
    expect((await identity.authenticate(again.headers())).context.actorUserId).toBe(
      (await identity.authenticate(client.headers())).context.actorUserId,
    );
  });

  it('explicitly links email → Discord, prevents matching-email implicit linking and cross-user collisions', async () => {
    const client = await registered('link@example.com');
    const userId = (await identity.authenticate(client.headers())).context.actorUserId;
    profiles.set('discord-link', {
      id: '323456789012345678',
      email: 'link@example.com',
      verified: true,
    });
    const implicit = new AuthClient(identity);
    await oauth(implicit, 'discord-link');
    await expect(identity.authenticate(implicit.headers())).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(
      (
        await database.pool.query(
          'SELECT id FROM account WHERE "providerId"=\'discord\' AND "userId"=$1',
          [userId],
        )
      ).rowCount,
    ).toBe(0);
    await oauth(client, 'discord-link', undefined, true);
    const socialLogin = new AuthClient(identity);
    await oauth(socialLogin, 'discord-link');
    expect((await identity.authenticate(socialLogin.headers())).context.actorUserId).toBe(userId);
    const collision = await registered('collision@example.com');
    await oauth(collision, 'discord-link', undefined, true);
    const account = await database.pool.query(
      'SELECT "userId" FROM account WHERE "providerId"=\'discord\' AND "accountId"=$1',
      ['323456789012345678'],
    );
    expect(account.rows[0]?.userId).toBe(userId);
  });

  it('supports no-email Discord signup and verified, session-bound reverse credential linking', async () => {
    profiles.set('discord-no-email', { id: '423456789012345678', email: null, verified: false });
    const invite = await invitation();
    const client = new AuthClient(identity);
    await oauth(client, 'discord-no-email', invite.token);
    const userId = (await identity.authenticate(client.headers())).context.actorUserId;
    expect(mails.some((message) => message.to.endsWith('.invalid'))).toBe(false);
    await identity.addEmailPassword(client.headers(), { email: 'reverse@example.com', password });
    const mail = mails.findLast(
      (message) => message.to === 'reverse@example.com' && message.template === 'link-email',
    );
    if (!mail) throw new Error('Expected fixture email');
    const claim = new URL(mail.url).searchParams.get('token');
    await expect(
      identity.confirmEmailPassword(owner.headers(), { token: claim }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await identity.confirmEmailPassword(client.headers(), { token: claim });
    await expect(
      identity.confirmEmailPassword(client.headers(), { token: claim }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const credentialLogin = new AuthClient(identity);
    expect(
      (await credentialLogin.request('/sign-in/email', { email: 'reverse@example.com', password }))
        .status,
    ).toBe(200);
    expect((await identity.authenticate(credentialLogin.headers())).context.actorUserId).toBe(
      userId,
    );
    const socialLogin = new AuthClient(identity);
    await oauth(socialLogin, 'discord-no-email');
    expect((await identity.authenticate(socialLogin.headers())).context.actorUserId).toBe(userId);
  });

  it('TOTP enrollment challenges password login and recovery codes are single-use', async () => {
    const client = await registered('totp@example.com');
    const enable = await client.request('/two-factor/enable', { password });
    expect(enable.status).toBe(200);
    const data = (await enable.json()) as { totpURI: string; backupCodes: string[] };
    const secret = new URL(data.totpURI).searchParams.get('secret');
    if (!secret) throw new Error('Expected fixture TOTP secret');
    expect((await client.request('/two-factor/verify-totp', { code: totp(secret) })).status).toBe(
      200,
    );
    const login = new AuthClient(identity);
    const challenge = await login.request('/sign-in/email', {
      email: 'totp@example.com',
      password,
    });
    expect(await challenge.json()).toMatchObject({ twoFactorRedirect: true });
    await expect(identity.authenticate(login.headers())).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(
      (await login.request('/two-factor/verify-backup-code', { code: data.backupCodes[0] })).status,
    ).toBe(200);
    expect((await identity.authenticate(login.headers())).context.role).toBe('user');
    expect(
      (await login.request('/two-factor/verify-backup-code', { code: data.backupCodes[0] })).status,
    ).toBe(401);
  });

  it('registers a signed WebAuthn fixture, verifies passkey login and revokes its session', async () => {
    const client = await registered('passkey@example.com');
    const device = new SoftwareAuthenticator();
    const options = await client.request('/passkey/generate-register-options');
    expect(options.status).toBe(200);
    const registration = (await options.json()) as { challenge: string };
    const enrolled = await client.request('/passkey/verify-registration', {
      response: device.registration(registration.challenge),
      name: 'Fixture authenticator',
    });
    expect(enrolled.status).toBe(200);
    const login = new AuthClient(identity);
    const request = await login.request('/passkey/generate-authenticate-options');
    const authentication = (await request.json()) as { challenge: string };
    const response = await login.request('/passkey/verify-authentication', {
      response: device.assertion(authentication.challenge),
    });
    expect(response.status).toBe(200);
    const session = await identity.authenticate(login.headers());
    expect(session.context.actorUserId).toBe(
      (await identity.authenticate(client.headers())).context.actorUserId,
    );
    const sessions = await login.request('/list-sessions');
    const rows = (await sessions.json()) as { id: string; token: string }[];
    const current = rows.find((row) => row.id === session.sessionId);
    if (!current) throw new Error('Expected fixture session');
    expect((await login.request('/revoke-session', { token: current.token })).status).toBe(200);
    await expect(identity.authenticate(login.headers())).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('isolates support authority, consumes step-up once, audits both identities and enforces idle/absolute expiry', async () => {
    const target = await registered('support@example.com');
    const targetId = (await identity.authenticate(target.headers())).context.actorUserId;
    await expect(
      identity.startSupport(owner.headers(), {
        stepUpToken: randomBytes(32).toString('base64url'),
        subjectUserId: targetId,
        reason: 'Fixture support',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(identity.stepUp(target.headers(), { password })).rejects.toMatchObject({
      code: 'forbidden',
    });
    const grant = await identity.stepUp(owner.headers(), { password });
    const support = await identity.startSupport(owner.headers(), {
      stepUpToken: grant.token,
      subjectUserId: targetId,
      reason: 'Fixture support',
    });
    const context = (await identity.authenticate(owner.headers(), support.token)).context;
    expect(context).toMatchObject({
      actorUserId: ownerId,
      subjectUserId: targetId,
      ownerElevation: true,
      sessionType: 'support',
    });
    expect((await identity.authenticate(target.headers())).context).toMatchObject({
      role: 'user',
      ownerElevation: false,
      sessionType: 'regular',
    });
    await expect(identity.authenticate(target.headers(), support.token)).rejects.toMatchObject({
      code: 'support_invalid',
    });
    await expect(
      identity.startSupport(owner.headers(), {
        stepUpToken: grant.token,
        subjectUserId: targetId,
        reason: 'Fixture support',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await database.pool.query(
      "UPDATE support_sessions SET last_activity_at=now()-interval '6 minutes' WHERE id=$1",
      [support.id],
    );
    await expect(identity.authenticate(owner.headers(), support.token)).rejects.toMatchObject({
      code: 'support_expired',
    });
    await identity.endSupport(owner.headers(), support.token);
    const events = await identity.listAudit(owner.headers());
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_user_id: ownerId,
          subject_user_id: targetId,
          action: 'support.started',
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain(support.token);
    expect(JSON.stringify(events)).not.toContain(password);
  });

  it('password reset requires mailed proof and revokes sessions; roles cannot replace the Owner', async () => {
    const client = await registered('reset@example.com');
    const userId = (await identity.authenticate(client.headers())).context.actorUserId;
    expect(
      (
        await client.request('/request-password-reset', {
          email: 'reset@example.com',
          redirectTo: '/reset',
        })
      ).status,
    ).toBe(200);
    const mail = mails.findLast(
      (message) => message.to === 'reset@example.com' && message.template === 'reset-password',
    );
    if (!mail) throw new Error('Expected fixture email');
    const url = new URL(mail.url);
    const resetToken = url.pathname.split('/').at(-1);
    expect(
      (
        await client.request('/reset-password', {
          newPassword: `${password}-new`,
          token: resetToken,
        })
      ).status,
    ).toBe(200);
    await expect(identity.authenticate(client.headers())).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await identity.setRole(owner.headers(), { userId, role: 'operator' });
    await expect(
      identity.setRole(owner.headers(), { userId: ownerId, role: 'operator' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      (await database.pool.query('SELECT role FROM "user" WHERE id=$1', [ownerId])).rows[0]?.role,
    ).toBe('owner');
  });

  it('rolls invitation consumption back if credential insertion fails after user creation', async () => {
    const invite = await invitation();
    await database.pool.query(`CREATE FUNCTION fixture_reject_account() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM "user" WHERE id=NEW."userId" AND email='rollback@example.com') THEN
          RAISE EXCEPTION 'fixture rollback';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fixture_reject BEFORE INSERT ON account FOR EACH ROW EXECUTE FUNCTION fixture_reject_account()`);
    try {
      await expect(signup('rollback@example.com', invite.token)).rejects.toThrow(
        'fixture rollback',
      );
      expect(
        (
          await database.pool.query('SELECT "remainingUses" FROM invitation WHERE id=$1', [
            invite.id,
          ])
        ).rows[0]?.remainingUses,
      ).toBe(1);
      expect(
        (
          await database.pool.query('SELECT id FROM "user" WHERE email=$1', [
            'rollback@example.com',
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await database.pool.query(
        'DROP TRIGGER fixture_reject ON account; DROP FUNCTION fixture_reject_account()',
      );
    }
  });

  it('races Discord callbacks against one invitation and stores OAuth tokens encrypted', async () => {
    const invite = await invitation();
    const clients = Array.from({ length: 4 }, () => new AuthClient(identity));
    for (let index = 0; index < clients.length; index++)
      profiles.set(`oauth-race-${index}`, {
        id: `52345678901234567${index}`,
        email: `oauth-race-${index}@example.com`,
        verified: true,
      });
    await Promise.all(
      clients.map((client, index) => oauth(client, `oauth-race-${index}`, invite.token)),
    );
    const sessions = await Promise.allSettled(
      clients.map((client) => identity.authenticate(client.headers())),
    );
    expect(sessions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await database.pool.query('SELECT "remainingUses" FROM invitation WHERE id=$1', [invite.id]))
        .rows[0]?.remainingUses,
    ).toBe(0);
    const stored = await database.pool.query<{ accessToken: string }>(
      'SELECT "accessToken" FROM account WHERE "providerId"=\'discord\'',
    );
    expect(
      stored.rows.every(
        (row) =>
          !row.accessToken.startsWith('discord-') && !row.accessToken.startsWith('oauth-race-'),
      ),
    ).toBe(true);
  });

  it('reverse linking cannot take over another email or bypass verification through Better Auth set-password', async () => {
    profiles.set('reverse-collision', { id: '623456789012345678', email: null, verified: false });
    const client = new AuthClient(identity);
    const invite = await invitation();
    await oauth(client, 'reverse-collision', invite.token);
    const userId = (await identity.authenticate(client.headers())).context.actorUserId;
    expect((await client.request('/set-password', { newPassword: password })).status).toBe(404);
    await identity.addEmailPassword(client.headers(), { email: 'link@example.com', password });
    const mail = mails.findLast(
      (message) => message.to === 'link@example.com' && message.template === 'link-email',
    );
    if (!mail) throw new Error('Expected fixture link email');
    const value = new URL(mail.url).searchParams.get('token');
    await expect(
      identity.confirmEmailPassword(client.headers(), { token: value }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      (await database.pool.query('SELECT email FROM "user" WHERE id=$1', [userId])).rows[0]?.email,
    ).toBe('623456789012345678@discord.placeholder.invalid');
    expect(
      (
        await database.pool.query(
          'SELECT id FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'',
          [userId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('requires verified Discord email ownership for an email-bound invitation', async () => {
    const client = new AuthClient(identity);
    const invite = await invitation({ email: 'oauth-bound@example.com' });
    profiles.set('oauth-unverified-bound', {
      id: '723456789012345678',
      email: 'oauth-bound@example.com',
      verified: false,
    });
    await oauth(client, 'oauth-unverified-bound', invite.token);
    await expect(identity.authenticate(client.headers())).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(
      (
        await database.pool.query('SELECT id FROM "user" WHERE email=$1', [
          'oauth-bound@example.com',
        ])
      ).rowCount,
    ).toBe(0);
    expect((await identity.inspectInvitation(invite.token)).valid).toBe(true);
    profiles.set('oauth-verified-bound', {
      id: '723456789012345678',
      email: 'oauth-bound@example.com',
      verified: true,
    });
    await oauth(client, 'oauth-verified-bound', invite.token);
    expect((await identity.authenticate(client.headers())).context.role).toBe('user');
  });

  it('rejects signed passkey registration and authentication without user verification', async () => {
    const client = await registered('passkey-uv@example.com');
    const userId = (await identity.authenticate(client.headers())).context.actorUserId;
    const device = new SoftwareAuthenticator();
    let response = await client.request('/passkey/generate-register-options');
    let options = (await response.json()) as { challenge: string };
    expect(
      (
        await client.request('/passkey/verify-registration', {
          response: device.registration(options.challenge, false),
        })
      ).status,
    ).toBe(401);
    expect(
      (await database.pool.query('SELECT id FROM passkey WHERE "userId"=$1', [userId])).rowCount,
    ).toBe(0);
    response = await client.request('/passkey/generate-register-options');
    options = (await response.json()) as { challenge: string };
    expect(
      (
        await client.request('/passkey/verify-registration', {
          response: device.registration(options.challenge),
        })
      ).status,
    ).toBe(200);
    const login = new AuthClient(identity);
    response = await login.request('/passkey/generate-authenticate-options');
    options = (await response.json()) as { challenge: string };
    expect(
      (
        await login.request('/passkey/verify-authentication', {
          response: device.assertion(options.challenge, false),
        })
      ).status,
    ).toBe(401);
    await expect(identity.authenticate(login.headers())).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    response = await login.request('/passkey/generate-authenticate-options');
    options = (await response.json()) as { challenge: string };
    expect(
      (
        await login.request('/passkey/verify-authentication', {
          response: device.assertion(options.challenge),
        })
      ).status,
    ).toBe(200);
    expect((await identity.authenticate(login.headers())).context.actorUserId).toBe(userId);
  });

  it('uses the configured default invitation lifetime while allowing bounded explicit expiry', async () => {
    const configured = createIdentity({ ...identityOptions, registrationInviteTtlSeconds: 7200 });
    const before = Date.now();
    const invite = await configured.createInvitation(owner.headers(), {});
    expect(invite.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7200_000);
    expect(invite.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 7200_000);
    const explicit = new Date(Date.now() + 40 * 86400_000);
    expect(
      (await configured.createInvitation(owner.headers(), { expiresAt: explicit })).expiresAt,
    ).toEqual(explicit);
    await expect(
      configured.createInvitation(owner.headers(), {
        expiresAt: new Date(Date.now() + 366 * 86400_000),
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('does not let browser proxy headers rotate the internal auth rate-limit bucket', async () => {
    const client = new AuthClient(identity);
    const statuses: number[] = [];
    for (let index = 0; index < 4; index++) {
      const response = await client.request(
        '/sign-in/email',
        { email: 'nonexistent-limit@example.com', password },
        { 'x-forwarded-for': `192.0.2.${100 + index}`, 'x-real-ip': `192.0.2.${110 + index}` },
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  it('uses the configured account locale and the support subject locale without changing Owner preferences', async () => {
    const configured = createIdentity({ ...identityOptions, defaultLocale: 'it' });
    const invite = await invitation();
    const client = new AuthClient(configured);
    expect(
      (
        await client.request(
          '/sign-up/email',
          { email: 'locale@example.com', name: 'Locale Fixture', password },
          { 'x-invitation-token': invite.token },
        )
      ).status,
    ).toBe(200);
    const mail = mails.findLast((message) => message.to === 'locale@example.com');
    expect(mail?.locale).toBe('it');
    await verifyEmail('locale@example.com', client);
    expect(
      (await client.request('/sign-in/email', { email: 'locale@example.com', password })).status,
    ).toBe(200);
    const principal = await configured.authenticate(client.headers());
    expect(principal.locale).toBe('it');
    expect((await identity.authenticate(owner.headers())).locale).toBe('en');
    const grant = await identity.stepUp(owner.headers(), { password });
    const support = await identity.startSupport(owner.headers(), {
      stepUpToken: grant.token,
      subjectUserId: principal.context.subjectUserId,
      reason: 'Locale support fixture',
    });
    expect((await identity.authenticate(owner.headers(), support.token)).locale).toBe('it');
    expect((await identity.authenticate(owner.headers())).locale).toBe('en');
    await identity.endSupport(owner.headers(), support.token);
  });

  it('supports configured support TTLs beyond defaults without exceeding hard limits', async () => {
    const configured = createIdentity({
      ...identityOptions,
      supportIdleTtlSeconds: 600,
      supportAbsoluteTtlSeconds: 1800,
    });
    const target = (
      await database.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [
        'support@example.com',
      ])
    ).rows[0];
    if (!target) throw new Error('Expected fixture target');
    const grant = await configured.stepUp(owner.headers(), { password });
    const support = await configured.startSupport(owner.headers(), {
      stepUpToken: grant.token,
      subjectUserId: target.id,
      reason: 'Configured support TTL fixture',
    });
    await database.pool.query(
      "UPDATE support_sessions SET started_at=now()-interval '1000 seconds',expires_at=now()+interval '800 seconds' WHERE id=$1",
      [support.id],
    );
    const result = await configured.authenticate(owner.headers(), support.token);
    expect(result.context.support).toMatchObject({ idleTtlSeconds: 600, absoluteTtlSeconds: 1800 });
    expect(() => assertAuthContext(result.context)).not.toThrow();
    await configured.endSupport(owner.headers(), support.token);
    // Keep the subsequent failed-attempt limit test independent.
    await database.pool.query('DELETE FROM identity_throttle WHERE key=$1', [`step-up:${ownerId}`]);
  });

  it('verifies passkeys from the separate configured browser origin', async () => {
    await registered('split-origin@example.com');
    const publicURL = 'https://app.example.com';
    const configured = createIdentity({ ...identityOptions, publicURL });
    const client = new AuthClient(configured, publicURL);
    expect(
      (await client.request('/sign-in/email', { email: 'split-origin@example.com', password }))
        .status,
    ).toBe(200);
    const device = new SoftwareAuthenticator(publicURL);
    const response = await client.request('/passkey/generate-register-options');
    expect(response.status).toBe(200);
    const options = (await response.json()) as { challenge: string; rp: { id: string } };
    expect(options.rp.id).toBe('app.example.com');
    expect(
      (
        await client.request('/passkey/verify-registration', {
          response: device.registration(options.challenge),
        })
      ).status,
    ).toBe(200);
    const login = new AuthClient(configured, publicURL);
    const request = await login.request('/passkey/generate-authenticate-options');
    const challenge = (await request.json()) as { challenge: string };
    expect(
      (
        await login.request('/passkey/verify-authentication', {
          response: device.assertion(challenge.challenge),
        })
      ).status,
    ).toBe(200);
    expect((await configured.authenticate(login.headers())).context.role).toBe('user');
  });

  it('retains a claimed Owner after mail failure and recovers through resend verification', async () => {
    const isolated = await createTestDatabase();
    let failMail = true;
    const setupToken = randomBytes(32).toString('base64url');
    const recovering = createIdentity({
      ...identityOptions,
      pool: isolated.pool,
      bootstrapToken: setupToken,
      defaultLocale: 'it',
      mail: async (message) => {
        if (failMail) throw new Error('Fixture mail unavailable');
        mails.push(message);
      },
    });
    try {
      await expect(
        recovering.claimOwner({
          token: setupToken,
          email: 'mail-recovery@example.com',
          password,
          name: 'Owner',
        }),
      ).rejects.toThrow('Fixture mail unavailable');
      expect(await recovering.bootstrapStatus()).toEqual({ ownerClaimed: true, completed: false });
      expect(
        (await isolated.pool.query('SELECT id FROM "user" WHERE role=\'owner\'')).rowCount,
      ).toBe(1);
      failMail = false;
      const client = new AuthClient(recovering);
      expect(
        (
          await client.request('/send-verification-email', {
            email: 'mail-recovery@example.com',
            callbackURL: '/',
          })
        ).status,
      ).toBe(200);
      await verifyEmail('mail-recovery@example.com', client);
      expect(
        (await client.request('/sign-in/email', { email: 'mail-recovery@example.com', password }))
          .status,
      ).toBe(200);
      expect((await recovering.authenticate(client.headers())).context.role).toBe('owner');
      expect((await recovering.authenticate(client.headers())).locale).toBe('it');
      await expect(
        recovering.claimOwner({
          token: setupToken,
          email: 'mail-recovery-second@example.com',
          password,
          name: 'Another',
        }),
      ).rejects.toMatchObject({ code: 'setup_completed' });
    } finally {
      await isolated.destroy();
    }
  });

  it('requires Owner password plus enrolled second factor for every privileged support grant', async () => {
    const enable = await owner.request('/two-factor/enable', { password });
    expect(enable.status).toBe(200);
    const data = (await enable.json()) as { totpURI: string; backupCodes: string[] };
    const secret = new URL(data.totpURI).searchParams.get('secret');
    if (!secret) throw new Error('Expected fixture TOTP secret');
    expect((await owner.request('/two-factor/verify-totp', { code: totp(secret) })).status).toBe(
      200,
    );
    await expect(identity.stepUp(owner.headers(), { password })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      identity.stepUp(owner.headers(), {
        password: 'A-deliberately-wrong-password',
        totpCode: totp(secret),
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const grant = await identity.stepUp(owner.headers(), {
      password,
      recoveryCode: data.backupCodes[0],
    });
    expect(grant.token.length).toBeGreaterThan(40);
    const target = (
      await database.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [
        'support@example.com',
      ])
    ).rows[0];
    if (!target) throw new Error('Expected fixture support target');
    const support = await identity.startSupport(owner.headers(), {
      stepUpToken: grant.token,
      subjectUserId: target.id,
      reason: 'Explicit Owner fixture check',
    });
    await database.pool.query(
      "UPDATE support_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
      [support.id],
    );
    await expect(identity.authenticate(owner.headers(), support.token)).rejects.toMatchObject({
      code: 'support_expired',
    });
    await expect(
      identity.stepUp(owner.headers(), { password, recoveryCode: data.backupCodes[0] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(identity.stepUp(owner.headers(), { password })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      identity.stepUp(owner.headers(), { password, totpCode: totp(secret) }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    // Clear only this fixture throttle window, then test legitimate grant/session revocation.
    await database.pool.query('DELETE FROM identity_throttle WHERE key=$1', [`step-up:${ownerId}`]);
    const fresh = await identity.stepUp(owner.headers(), { password, totpCode: totp(secret) });
    const parentBound = await identity.startSupport(owner.headers(), {
      stepUpToken: fresh.token,
      subjectUserId: target.id,
      reason: 'Parent revocation fixture',
    });
    expect((await owner.request('/sign-out', {})).status).toBe(200);
    await expect(identity.authenticate(owner.headers(), parentBound.token)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(
      (await database.pool.query('SELECT id FROM support_sessions WHERE id=$1', [parentBound.id]))
        .rowCount,
    ).toBe(0);
  });
});
