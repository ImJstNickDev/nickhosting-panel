import { randomBytes, randomUUID } from 'node:crypto';
import { createIdentity, type IdentityMail } from '@nickhosting/auth';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../../packages/auth/src/test-fixtures.js';
import { createApp } from './app.js';

describe('Owner invitation recovery and editing HTTP contracts', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let identity: ReturnType<typeof createIdentity>;
  let app: ReturnType<typeof createApp>;
  let owner: AuthClient;
  let member: AuthClient;
  let operator: AuthClient;
  let memberId: string;
  const origin = 'http://localhost:3999';
  const password = 'Invitation-fixture-password-752!';
  const mails: IdentityMail[] = [];
  const codec = new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } });

  async function request(
    client: AuthClient | null,
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    extra: Record<string, string> = {},
  ) {
    const headers = client?.headers(extra) ?? new Headers({ origin, ...extra });
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await app.request(`${origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    client?.absorb(response);
    return response;
  }

  async function create(body: Record<string, unknown> = {}) {
    const response = await request(owner, '/v1/owner/invitations', body);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return (await response.json()) as {
      id: string;
      url: string;
      expiresAt: string;
      linkAvailable: boolean;
    };
  }

  async function verify(client: AuthClient, email: string) {
    const mail = mails.findLast((entry) => entry.to === email && entry.template === 'verify-email');
    if (!mail) throw new Error('Missing invitation fixture verification mail');
    expect((await app.request(mail.url)).status).toBe(302);
    const signedIn = await client.request('/sign-in/email', { email, password });
    expect(signedIn.status).toBe(200);
    return (await signedIn.json()).user.id as string;
  }

  async function register(client: AuthClient, invitationUrl: string, email: string) {
    const token = new URL(invitationUrl).pathname.split('/').at(-1);
    if (!token) throw new Error('Missing invitation fixture token');
    const response = await client.request(
      '/sign-up/email',
      {
        name: 'Invitation fixture member',
        email,
        password,
      },
      { 'x-invitation-token': token },
    );
    expect(response.status).toBe(200);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    const bootstrapToken = randomBytes(32).toString('base64url');
    identity = createIdentity({
      pool: database.pool,
      secretCodec: codec,
      baseURL: origin,
      authSecret: randomBytes(32).toString('base64url'),
      bootstrapToken,
      mail: async (mail) => {
        mails.push(mail);
      },
      completeSetup: async () => {},
    });
    app = createApp({
      database,
      identity: async () => identity,
      codec,
      origins: [origin],
      env: { NH_PUBLIC_URL: origin, NH_API_URL: origin },
      log: () => {},
    });
    owner = new AuthClient(identity);
    member = new AuthClient(identity);
    operator = new AuthClient(identity);
    await identity.claimOwner({
      token: bootstrapToken,
      name: 'Invitation fixture Owner',
      email: 'invitation-owner@example.test',
      password,
    });
    await verify(owner, 'invitation-owner@example.test');
    // Prepare identities through the existing real auth pipeline, independently
    // of the HTTP features under test below.
    for (const [client, email, role] of [
      [member, 'invitation-member@example.test', 'user'],
      [operator, 'invitation-operator@example.test', 'operator'],
    ] as const) {
      const invite = await identity.createInvitation(owner.headers(), { email, role });
      await register(client, invite.url, email);
      const userId = await verify(client, email);
      if (client === member) memberId = userId;
    }
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('round-trips the original URL, encrypts persistence and excludes secrets from list responses', async () => {
    const invite = await create({ maxUses: 5 });
    expect(invite.linkAvailable).toBe(true);
    const recovered = await request(owner, `/v1/owner/invitations/${invite.id}/link`);
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get('cache-control')).toBe('no-store');
    expect(await recovered.json()).toEqual({ url: invite.url });
    const listed = await request(owner, '/v1/owner/invitations');
    expect(listed.status).toBe(200);
    const rows = await listed.json();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: invite.id,
          linkAvailable: true,
          maxUses: 5,
          remainingUses: 5,
        }),
      ]),
    );
    for (const row of rows) {
      for (const secret of ['token', 'tokenHash', 'tokenCiphertext', 'url'])
        expect(row).not.toHaveProperty(secret);
    }
    const persisted = await database.pool.query('SELECT * FROM invitation WHERE id=$1', [
      invite.id,
    ]);
    expect(persisted.rows[0].tokenCiphertext).toBeTruthy();
    const token = new URL(invite.url).pathname.split('/').at(-1);
    expect(JSON.stringify(persisted.rows[0])).not.toContain(token);
  });

  it('allows only a regular Owner to recover or edit and rejects forged origins', async () => {
    const invite = await create();
    const path = `/v1/owner/invitations/${invite.id}`;
    const update = { maxUses: 2, expiresAt: invite.expiresAt };
    for (const client of [null, member, operator]) {
      const status = client === null ? 401 : 403;
      expect((await request(client, `${path}/link`)).status).toBe(status);
      expect((await request(client, path, update, 'PATCH')).status).toBe(status);
    }
    expect(
      (await request(owner, path, update, 'PATCH', { origin: 'https://other.example.test' }))
        .status,
    ).toBe(403);
    const grant = await identity.stepUp(owner.headers(), { password });
    const support = await identity.startSupport(owner.headers(), {
      stepUpToken: grant.token,
      subjectUserId: memberId,
      reason: 'Invitation permission regression',
    });
    const supportHeaders = { 'x-nh-support-token': support.token };
    expect((await request(owner, `${path}/link`, undefined, 'GET', supportHeaders)).status).toBe(
      403,
    );
    expect((await request(owner, path, update, 'PATCH', supportHeaders)).status).toBe(403);
    await identity.endSupport(owner.headers(), support.token);
  });

  it('edits expiry and maximum uses while preserving consumed uses and the exact URL', async () => {
    const invite = await create({ maxUses: 5 });
    const invited = new AuthClient(identity);
    await register(invited, invite.url, 'invitation-consumption@example.test');
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    const response = await request(
      owner,
      `/v1/owner/invitations/${invite.id}`,
      { expiresAt, maxUses: 8 },
      'PATCH',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: invite.id,
      email: null,
      role: 'user',
      expiresAt,
      maxUses: 8,
      remainingUses: 7,
      linkAvailable: true,
    });
    const persisted = await database.pool.query('SELECT * FROM invitation WHERE id=$1', [
      invite.id,
    ]);
    expect(persisted.rows[0].expiresAt.toISOString()).toBe(expiresAt);
    expect(persisted.rows[0].maxUses).toBe(8);
    expect(persisted.rows[0].remainingUses).toBe(7);
    const recovered = await request(owner, `/v1/owner/invitations/${invite.id}/link`);
    expect(await recovered.json()).toEqual({ url: invite.url });
  });

  it('rejects immutable fields, invalid limits, missing fields and reduction below consumed uses', async () => {
    const invite = await create({ maxUses: 3, email: 'fixed@example.test' });
    const path = `/v1/owner/invitations/${invite.id}`;
    const valid = { expiresAt: invite.expiresAt, maxUses: 3 };
    for (const invalid of [
      { ...valid, role: 'operator' },
      { ...valid, email: 'changed@example.test' },
      { ...valid, maxUses: 0 },
      { ...valid, maxUses: 101 },
      { ...valid, maxUses: 1.5 },
      { ...valid, maxUses: '3' },
      { ...valid, expiresAt: 'not-a-date' },
      { ...valid, expiresAt: '2020-01-01T00:00:00Z' },
      { maxUses: 3 },
      { expiresAt: invite.expiresAt },
    ]) {
      const response = await request(owner, path, invalid, 'PATCH');
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'validation_failed' } });
    }
    // Test-owned schema only: represent two consumed uses without extra costly signups.
    await database.pool.query('UPDATE invitation SET "remainingUses"=1 WHERE id=$1', [invite.id]);
    const rejected = await request(owner, path, { ...valid, maxUses: 1 }, 'PATCH');
    expect(rejected.status).toBe(400);
    const row = (await database.pool.query('SELECT * FROM invitation WHERE id=$1', [invite.id]))
      .rows[0];
    expect(row).toMatchObject({
      email: 'fixed@example.test',
      role: 'user',
      maxUses: 3,
      remainingUses: 1,
    });
  });

  it('restores expired and exhausted invitations through an edit without rotating the token', async () => {
    for (const state of ['expired', 'exhausted']) {
      const invite = await create({ maxUses: 2 });
      if (state === 'expired')
        await database.pool.query(
          'UPDATE invitation SET "expiresAt"=now()-interval \'1 day\' WHERE id=$1',
          [invite.id],
        );
      else
        await database.pool.query('UPDATE invitation SET "remainingUses"=0 WHERE id=$1', [
          invite.id,
        ]);
      const response = await request(
        owner,
        `/v1/owner/invitations/${invite.id}`,
        { expiresAt: invite.expiresAt, maxUses: 3 },
        'PATCH',
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ remainingUses: state === 'exhausted' ? 1 : 3 });
      const recovered = await request(owner, `/v1/owner/invitations/${invite.id}/link`);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({ url: invite.url });
    }
  });

  it('keeps revoked invitations listed but prevents recovery and further editing', async () => {
    const invite = await create();
    const path = `/v1/owner/invitations/${invite.id}`;
    expect((await request(owner, path, undefined, 'DELETE')).status).toBe(204);
    const recovered = await request(owner, `${path}/link`);
    expect(recovered.status).toBeGreaterThanOrEqual(400);
    expect(await recovered.json()).toMatchObject({ error: { code: 'invitation_revoked' } });
    const edited = await request(owner, path, { expiresAt: invite.expiresAt, maxUses: 2 }, 'PATCH');
    expect(edited.status).toBeGreaterThanOrEqual(400);
    expect(await edited.json()).toMatchObject({ error: { code: 'invitation_revoked' } });
    const listed = await (await request(owner, '/v1/owner/invitations')).json();
    expect(listed.find((row: { id: string }) => row.id === invite.id).revokedAt).toEqual(
      expect.any(String),
    );
  });

  it('returns 404 for unknown IDs and explicitly identifies unrecoverable legacy invitations', async () => {
    const unknown = `/v1/owner/invitations/${randomUUID()}`;
    expect((await request(owner, `${unknown}/link`)).status).toBe(404);
    expect(
      (
        await request(
          owner,
          unknown,
          { maxUses: 2, expiresAt: new Date(Date.now() + 86400000).toISOString() },
          'PATCH',
        )
      ).status,
    ).toBe(404);
    const invite = await create();
    await database.pool.query('UPDATE invitation SET "tokenCiphertext"=NULL WHERE id=$1', [
      invite.id,
    ]);
    const listed = await (await request(owner, '/v1/owner/invitations')).json();
    expect(listed.find((row: { id: string }) => row.id === invite.id).linkAvailable).toBe(false);
    const recovered = await request(owner, `/v1/owner/invitations/${invite.id}/link`);
    expect(recovered.status).toBeGreaterThanOrEqual(400);
    expect(await recovered.json()).toMatchObject({
      error: { code: 'invitation_link_unavailable' },
    });
    // Legacy hashes still authorize registration even though the URL cannot be recovered.
    const token = new URL(invite.url).pathname.split('/').at(-1) ?? '';
    expect(await identity.inspectInvitation(token)).toMatchObject({ valid: true });
  });
});
