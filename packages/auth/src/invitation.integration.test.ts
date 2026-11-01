import { randomBytes, randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IdentityMail } from './contracts.js';
import { opaqueToken } from './crypto.js';
import { createIdentity } from './index.js';
import { AuthClient } from './test-fixtures.js';

describe('durable invitation management on isolated PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let identity: ReturnType<typeof createIdentity>;
  let owner: AuthClient;
  const password = 'Invitation-fixture-password-813!';
  const secretCodec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
  const mails: IdentityMail[] = [];
  const future = () => new Date(Date.now() + 3_600_000).toISOString();

  async function verifyAndSignIn(client: AuthClient, email: string) {
    const mail = mails.findLast((message) => message.to === email);
    if (!mail) throw new Error('Expected verification fixture');
    expect((await client.request(`/verify-email${new URL(mail.url).search}`)).status).toBe(302);
    expect((await client.request('/sign-in/email', { email, password })).status).toBe(200);
  }
  async function invitation(overrides: Record<string, unknown> = {}) {
    return identity.createInvitation(owner.headers(), { expiresAt: future(), ...overrides });
  }
  async function signup(invite: string) {
    const client = new AuthClient(identity);
    const email = `${randomUUID()}@example.com`;
    const response = await client.request(
      '/sign-up/email',
      { email, password, name: 'Invited user' },
      { 'x-invitation-token': invite },
    );
    return { client, email, response };
  }
  async function summary(id: string) {
    return (await identity.listInvitations(owner.headers())).find((row) => row.id === id);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    const bootstrapToken = opaqueToken();
    identity = createIdentity({
      pool: database.pool,
      baseURL: 'http://localhost:3999',
      publicURL: 'https://app.example.com',
      authSecret: opaqueToken(),
      secretCodec,
      bootstrapToken,
      mail: async (message) => {
        mails.push(message);
      },
      completeSetup: async () => {},
    });
    owner = new AuthClient(identity);
    await identity.claimOwner({
      token: bootstrapToken,
      name: 'Owner',
      email: 'invitation-owner@example.com',
      password,
    });
    await verifyAndSignIn(owner, 'invitation-owner@example.com');
  });

  afterAll(async () => {
    if (database) await database.destroy();
  });

  it('recovers the original URL from ciphertext and exposes only safe metadata in lists and audit', async () => {
    const invite = await invitation({ maxUses: 3, email: 'recipient@example.com' });
    expect(invite.linkAvailable).toBe(true);
    const stored = (await database.pool.query('SELECT * FROM invitation WHERE id=$1', [invite.id]))
      .rows[0];
    expect(stored.tokenCiphertext).toMatchObject({ version: 1, keyId: 'test' });
    expect(JSON.stringify(stored)).not.toContain(invite.token);
    expect(secretCodec.decrypt(stored.tokenCiphertext, `invitation:${invite.id}`)).toBe(
      invite.token,
    );
    expect(await identity.getInvitationLink(owner.headers(), invite.id)).toEqual({
      url: invite.url,
    });
    expect(invite.url).toBe(`https://app.example.com/invite/${invite.token}`);
    const listed = await summary(invite.id);
    expect(listed).toMatchObject({ email: 'recipient@example.com', linkAvailable: true });
    expect(Object.keys(listed ?? {}).sort()).toEqual(
      [
        'id',
        'email',
        'role',
        'remainingUses',
        'maxUses',
        'expiresAt',
        'revokedAt',
        'createdAt',
        'linkAvailable',
      ].sort(),
    );
    const updated = await identity.updateInvitation(owner.headers(), invite.id, {
      expiresAt: future(),
      maxUses: 4,
    });
    expect(Object.keys(updated).sort()).toEqual(Object.keys(listed ?? {}).sort());
    const audit = (await identity.listAudit(owner.headers())).filter(
      (event) => event.metadata.invitationId === invite.id,
    );
    expect(audit.map((event) => event.action)).toEqual([
      'invitation.updated',
      'invitation.link_revealed',
      'invitation.created',
    ]);
    for (const secret of [invite.token, invite.url, stored.tokenHash, stored.tokenCiphertext.iv])
      expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it('keeps legacy hash-only invites redeemable and editable, but explicitly reports unavailable links', async () => {
    const invite = await invitation();
    await database.pool.query('UPDATE invitation SET "tokenCiphertext"=NULL WHERE id=$1', [
      invite.id,
    ]);
    expect(await summary(invite.id)).toMatchObject({ linkAvailable: false });
    await expect(identity.getInvitationLink(owner.headers(), invite.id)).rejects.toMatchObject({
      code: 'invitation_link_unavailable',
    });
    expect(
      await identity.updateInvitation(owner.headers(), invite.id, {
        expiresAt: future(),
        maxUses: 2,
      }),
    ).toMatchObject({ linkAvailable: false, maxUses: 2, remainingUses: 2 });
    expect((await signup(invite.token)).response.status).toBe(200);
  });

  it('rejects altered envelopes, ciphertext row swaps, and tokens that do not match their stored hash', async () => {
    const first = await invitation();
    const second = await invitation();
    const envelope = (
      await database.pool.query('SELECT "tokenCiphertext" FROM invitation WHERE id=$1', [first.id])
    ).rows[0].tokenCiphertext;
    await database.pool.query('UPDATE invitation SET "tokenCiphertext"=$2 WHERE id=$1', [
      second.id,
      envelope,
    ]);
    await expect(identity.getInvitationLink(owner.headers(), second.id)).rejects.toMatchObject({
      code: 'secret_invalid',
    });
    await database.pool.query('UPDATE invitation SET "tokenCiphertext"=$2 WHERE id=$1', [
      first.id,
      { ...envelope, tag: randomBytes(16).toString('base64') },
    ]);
    await expect(identity.getInvitationLink(owner.headers(), first.id)).rejects.toMatchObject({
      code: 'secret_invalid',
    });
    await database.pool.query('UPDATE invitation SET "tokenCiphertext"=$2 WHERE id=$1', [
      first.id,
      secretCodec.encrypt(opaqueToken(), `invitation:${first.id}`),
    ]);
    await expect(identity.getInvitationLink(owner.headers(), first.id)).rejects.toMatchObject({
      code: 'secret_invalid',
    });
    expect(
      (await identity.listAudit(owner.headers())).filter(
        (event) =>
          [first.id, second.id].includes(event.metadata.invitationId) &&
          event.action === 'invitation.link_revealed',
      ),
    ).toHaveLength(0);
  });

  it('requires an authenticated verified Owner to reveal and edit links', async () => {
    const invite = await invitation({ maxUses: 2 });
    const member = await signup(invite.token);
    expect(member.response.status).toBe(200);
    await verifyAndSignIn(member.client, member.email);
    for (const headers of [new Headers(), member.client.headers()]) {
      const code = headers.has('cookie') ? 'forbidden' : 'unauthenticated';
      await expect(identity.getInvitationLink(headers, invite.id)).rejects.toMatchObject({ code });
      await expect(
        identity.updateInvitation(headers, invite.id, { maxUses: 2, expiresAt: future() }),
      ).rejects.toMatchObject({ code });
    }
    const memberId = (await identity.authenticate(member.client.headers())).context.actorUserId;
    await identity.setRole(owner.headers(), { userId: memberId, role: 'operator' });
    await expect(
      identity.getInvitationLink(member.client.headers(), invite.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      identity.updateInvitation(member.client.headers(), invite.id, {
        maxUses: 3,
        expiresAt: future(),
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects unknown IDs and invalid updates, keeping recipient and role immutable', async () => {
    const invite = await invitation({ email: 'fixed@example.com', role: 'operator' });
    const valid = { expiresAt: future(), maxUses: 2 };
    const invalid = [
      {},
      { ...valid, maxUses: 0 },
      { ...valid, maxUses: 101 },
      { ...valid, maxUses: 1.5 },
      { ...valid, maxUses: '2' },
      { ...valid, expiresAt: new Date().toISOString() },
      { ...valid, expiresAt: new Date(Date.now() + 366 * 86_400_000).toISOString() },
      { ...valid, expiresAt: 'not-a-date' },
      { ...valid, expiresAt: new Date() },
      { ...valid, expiresAt: 12 },
      { ...valid, role: 'user' },
      { ...valid, email: 'changed@example.com' },
      { ...valid, remainingUses: 100 },
    ];
    for (const input of invalid)
      await expect(
        identity.updateInvitation(owner.headers(), invite.id, input),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(identity.getInvitationLink(owner.headers(), randomUUID())).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      identity.updateInvitation(owner.headers(), randomUUID(), valid),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await summary(invite.id)).toMatchObject({
      email: 'fixed@example.com',
      role: 'operator',
      maxUses: 1,
      remainingUses: 1,
    });
  });

  it('preserves consumed uses, rejects reductions below usage, and reactivates exhausted links', async () => {
    const invite = await invitation({ maxUses: 2 });
    expect((await signup(invite.token)).response.status).toBe(200);
    expect((await signup(invite.token)).response.status).toBe(200);
    await expect(identity.getInvitationLink(owner.headers(), invite.id)).rejects.toMatchObject({
      code: 'invitation_exhausted',
    });
    expect(await summary(invite.id)).toMatchObject({ linkAvailable: true });
    await expect(
      identity.updateInvitation(owner.headers(), invite.id, { expiresAt: future(), maxUses: 1 }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(
      await identity.updateInvitation(owner.headers(), invite.id, {
        expiresAt: future(),
        maxUses: 2,
      }),
    ).toMatchObject({ remainingUses: 0, maxUses: 2 });
    expect(
      await identity.updateInvitation(owner.headers(), invite.id, {
        expiresAt: future(),
        maxUses: 4,
      }),
    ).toMatchObject({ remainingUses: 2, maxUses: 4 });
    expect(await identity.getInvitationLink(owner.headers(), invite.id)).toEqual({
      url: invite.url,
    });
    expect((await signup(invite.token)).response.status).toBe(200);
    expect(await summary(invite.id)).toMatchObject({ remainingUses: 1, maxUses: 4 });
  });

  it('retains expired ciphertext for renewal, clears revoked ciphertext, and never reactivates revoked invites', async () => {
    const invite = await invitation();
    await database.pool.query(
      'UPDATE invitation SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1',
      [invite.id],
    );
    await expect(identity.getInvitationLink(owner.headers(), invite.id)).rejects.toMatchObject({
      code: 'invitation_expired',
    });
    expect(await summary(invite.id)).toMatchObject({ linkAvailable: true });
    await identity.updateInvitation(owner.headers(), invite.id, {
      expiresAt: future(),
      maxUses: 1,
    });
    expect(await identity.getInvitationLink(owner.headers(), invite.id)).toEqual({
      url: invite.url,
    });
    await identity.revokeInvitation(owner.headers(), invite.id);
    expect(await summary(invite.id)).toMatchObject({ linkAvailable: false });
    await expect(identity.getInvitationLink(owner.headers(), invite.id)).rejects.toMatchObject({
      code: 'invitation_revoked',
    });
    await expect(
      identity.updateInvitation(owner.headers(), invite.id, { expiresAt: future(), maxUses: 2 }),
    ).rejects.toMatchObject({ code: 'invitation_revoked' });
    expect((await signup(invite.token)).response.status).toBe(400);
  });

  it('preserves each redemption while an Owner concurrently changes the limit', async () => {
    const invite = await invitation({ maxUses: 3 });
    const [first, second, third] = await Promise.all([
      signup(invite.token),
      signup(invite.token),
      signup(invite.token),
      identity.updateInvitation(owner.headers(), invite.id, { expiresAt: future(), maxUses: 4 }),
    ]);
    for (const result of [first, second, third]) expect(result.response.status).toBe(200);
    expect(await summary(invite.id)).toMatchObject({ maxUses: 4, remainingUses: 1 });
  });

  it.each(['redemption', 'revocation'])(
    'rechecks state after waiting for an in-flight %s to commit',
    async (operation) => {
      const invite = await invitation({ maxUses: 3 });
      const blocker = await database.pool.connect();
      let edit: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid;
        expect(pid).toBeDefined();
        // Hold the same row update used by the real redemption/revocation paths
        // open until the edit is blocked. This makes stale-read races repeatable.
        await blocker.query(
          operation === 'redemption'
            ? 'UPDATE invitation SET "remainingUses"="remainingUses"-1 WHERE id=$1'
            : 'UPDATE invitation SET "revokedAt"=now(),"tokenCiphertext"=NULL WHERE id=$1',
          [invite.id],
        );
        edit = identity.updateInvitation(owner.headers(), invite.id, {
          expiresAt: future(),
          maxUses: 4,
        });
        // Install a rejection handler before releasing the blocker.
        const outcome = edit.then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        await vi.waitFor(async () => {
          const waiting = await database.pool.query<{ blocked: boolean }>(
            'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',
            [pid],
          );
          expect(waiting.rows[0]?.blocked).toBe(true);
        });
        await blocker.query('COMMIT');
        if (operation === 'redemption') {
          expect(await outcome).toMatchObject({
            value: { remainingUses: 3, maxUses: 4 },
            error: undefined,
          });
        } else {
          expect(await outcome).toMatchObject({ error: { code: 'invitation_revoked' } });
          expect(await summary(invite.id)).toMatchObject({ maxUses: 3, linkAvailable: false });
        }
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await edit?.catch(() => {});
      }
    },
  );

  it('serializes concurrent edits and revocation without resurrecting the invitation', async () => {
    const invite = await invitation();
    const [revoked, updated] = await Promise.allSettled([
      identity.revokeInvitation(owner.headers(), invite.id),
      identity.updateInvitation(owner.headers(), invite.id, { expiresAt: future(), maxUses: 5 }),
    ]);
    expect(revoked.status).toBe('fulfilled');
    if (updated.status === 'rejected')
      expect(updated.reason).toMatchObject({ code: 'invitation_revoked' });
    const stored = await summary(invite.id);
    expect(stored?.revokedAt).toBeInstanceOf(Date);
    expect(stored?.linkAvailable).toBe(false);
    await expect(identity.inspectInvitation(invite.token)).rejects.toMatchObject({
      code: 'invitation_revoked',
    });
  });
});
