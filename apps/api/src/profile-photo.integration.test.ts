import { createHash, randomBytes } from 'node:crypto';
import { createIdentity, type IdentityMail } from '@nickhosting/auth';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../../packages/auth/src/test-fixtures.js';
import { createApp } from './app.js';
import { profilePhotoMaxBytes } from './profile-photo-image.js';

describe('authenticated local profile photos', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let identity: ReturnType<typeof createIdentity>;
  let app: ReturnType<typeof createApp>;
  let owner: AuthClient, user: AuthClient;
  let ownerId: string, userId: string;
  let avatarUrl: string, ownerAvatarUrl: string;
  const origin = 'http://localhost:3999';
  const password = 'Profile-fixture-password-591!';
  const mails: IdentityMail[] = [];
  const codec = new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } });
  const photo = (color: number) => {
    const image = new PNG({ width: 256, height: 256 });
    image.data.fill(color);
    return PNG.sync.write(image);
  };
  const makeApp = () =>
    createApp({
      database,
      identity: async () => identity,
      origins: [origin],
      codec,
    });
  async function request(
    client: AuthClient | null,
    method: string,
    path: string,
    body?: Buffer,
    extra: Record<string, string> = {},
  ) {
    const headers = client?.headers(extra) ?? new Headers({ origin, ...extra });
    if (body && !headers.has('content-type')) headers.set('content-type', 'image/png');
    return app.request(`${origin}${path}`, {
      method,
      headers,
      body: body ? new Uint8Array(body) : undefined,
    });
  }
  async function savedPhoto() {
    return database.db
      .selectFrom('user_profile_photos')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }
  beforeAll(async () => {
    database = await createTestDatabase();
    const bootstrapToken = randomBytes(32).toString('base64url');
    identity = createIdentity({
      secretCodec: codec,
      pool: database.pool,
      baseURL: origin,
      authSecret: randomBytes(32).toString('base64url'),
      bootstrapToken,
      mail: async (message) => {
        mails.push(message);
      },
      completeSetup: async () => {},
    });
    app = makeApp();
    owner = new AuthClient(identity);
    user = new AuthClient(identity);
    await identity.claimOwner({
      token: bootstrapToken,
      name: 'Photo Owner',
      email: 'photo-owner@example.test',
      password,
    });
    async function verify(client: AuthClient, email: string) {
      const mail = mails.findLast(
        (entry) => entry.to === email && entry.template === 'verify-email',
      );
      if (!mail) throw new Error('Missing test verification mail');
      expect((await app.request(mail.url)).status).toBe(302);
      const signed = await client.request('/sign-in/email', { email, password });
      expect(signed.status).toBe(200);
      return (await signed.json()).user.id as string;
    }
    ownerId = await verify(owner, 'photo-owner@example.test');
    const invitation = await identity.createInvitation(owner.headers(), {
      email: 'photo-user@example.test',
    });
    expect(
      (
        await user.request(
          '/sign-up/email',
          { name: 'Photo User', email: 'photo-user@example.test', password },
          { 'x-invitation-token': invitation.token },
        )
      ).status,
    ).toBe(200);
    userId = await verify(user, 'photo-user@example.test');
    await database.db
      .updateTable('user')
      .set({ image: 'https://identity-provider.example.test/image.png' })
      .where('id', '=', userId)
      .execute();
  });
  afterAll(async () => {
    await database?.destroy();
  });

  it('returns null for the local default without exposing the identity-provider image', async () => {
    const response = await request(user, 'GET', '/v1/web/session');
    expect(response.status).toBe(200);
    const session = await response.json();
    expect(session.actor.avatarUrl).toBeNull();
    expect(session.subject.avatarUrl).toBeNull();
    expect(session.subject).not.toHaveProperty('image');
    expect(session.subject).not.toHaveProperty('content');
    expect(session.subject).not.toHaveProperty('revision');
  });

  it('requires a session and same-origin authority before consuming upload bodies', async () => {
    expect((await request(null, 'PUT', '/v1/web/profile-photo', photo(20))).status).toBe(401);
    expect((await request(null, 'DELETE', '/v1/web/profile-photo')).status).toBe(401);
    expect(
      (
        await request(user, 'PUT', '/v1/web/profile-photo', photo(20), {
          origin: 'https://foreign.example.test',
        })
      ).status,
    ).toBe(403);
    const missingOrigin = user.headers();
    missingOrigin.delete('origin');
    expect(
      (
        await app.request(`${origin}/v1/web/profile-photo`, {
          method: 'DELETE',
          headers: missingOrigin,
        })
      ).status,
    ).toBe(403);
    expect(await savedPhoto()).toBeUndefined();
  });

  it('rejects invalid media and bounds actual bytes even with a false Content-Length', async () => {
    for (const [body, extra, status] of [
      [photo(20), { 'content-type': 'application/json' }, 400],
      [Buffer.from('<svg/>'), { 'content-type': 'image/png' }, 400],
      [photo(20).subarray(0, 30), {}, 400],
      [Buffer.alloc(profilePhotoMaxBytes + 1), {}, 413],
      [Buffer.alloc(profilePhotoMaxBytes + 1), { 'content-length': '1' }, 413],
      [photo(20), { 'content-length': String(profilePhotoMaxBytes + 1) }, 413],
    ] as const) {
      const response = await request(user, 'PUT', '/v1/web/profile-photo', body, extra);
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe('validation_failed');
    }
    expect(await savedPhoto()).toBeUndefined();
    expect(
      await database.db
        .selectFrom('audit_events')
        .select('id')
        .where('action', 'like', 'profile.photo.%')
        .execute(),
    ).toHaveLength(0);
  });

  it('stores sanitized pixels and safe session URLs durably with an attributed audit', async () => {
    const noisy = new PNG({ width: 256, height: 256 });
    noisy.data = randomBytes(noisy.data.length);
    const uploadedPixels = PNG.sync.write(noisy);
    expect(uploadedPixels.length).toBeGreaterThan(65_536);
    const uploaded = await request(user, 'PUT', '/v1/web/profile-photo', uploadedPixels);
    expect(uploaded.status).toBe(200);
    avatarUrl = (await uploaded.json()).avatarUrl;
    const saved = await savedPhoto();
    expect(saved?.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(avatarUrl).toBe(
      `/v1/web/profile-photo/${encodeURIComponent(userId)}?v=${saved?.revision}`,
    );
    expect(saved?.revision).toBe(
      createHash('sha256')
        .update(saved?.content ?? '')
        .digest('hex'),
    );
    expect(saved?.updated_at).toBeInstanceOf(Date);
    app = makeApp();
    const session = await (await request(user, 'GET', '/v1/web/session')).json();
    expect(session.subject.avatarUrl).toBe(avatarUrl);
    const served = await request(user, 'GET', avatarUrl);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('cache-control')).toBe('private, no-store');
    const bytes = Buffer.from(await served.arrayBuffer());
    expect(bytes).toEqual(saved?.content);
    expect(PNG.sync.read(bytes).data).toEqual(noisy.data);
    expect(
      await database.db
        .selectFrom('user')
        .select('image')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ image: 'https://identity-provider.example.test/image.png' });
    expect(
      await database.db
        .selectFrom('audit_events')
        .select(['actor_user_id', 'subject_user_id', 'action', 'metadata'])
        .where('action', '=', 'profile.photo.updated')
        .execute(),
    ).toEqual([
      {
        actor_user_id: userId,
        subject_user_id: userId,
        action: 'profile.photo.updated',
        metadata: {},
      },
    ]);
    const ownerUploaded = await request(owner, 'PUT', '/v1/web/profile-photo', photo(80));
    expect(ownerUploaded.status).toBe(200);
    ownerAvatarUrl = (await ownerUploaded.json()).avatarUrl;
  });

  it('does not reveal photos to anonymous, foreign or stale-revision requests', async () => {
    expect((await request(null, 'GET', avatarUrl)).status).toBe(401);
    expect((await request(owner, 'GET', avatarUrl)).status).toBe(404);
    expect((await request(user, 'GET', ownerAvatarUrl)).status).toBe(404);
    expect((await request(user, 'GET', `/v1/web/profile-photo/${userId}`)).status).toBe(404);
    expect(
      (await request(user, 'GET', `/v1/web/profile-photo/${userId}?v=${'0'.repeat(64)}`)).status,
    ).toBe(404);
    expect(
      (await request(user, 'GET', `/v1/web/profile-photo/unknown?v=${'0'.repeat(64)}`)).status,
    ).toBe(404);
  });

  it('allows assisted actor/subject photos but forbids assisted modification', async () => {
    const stepUp = await identity.stepUp(owner.headers(), { password });
    const support = await identity.startSupport(owner.headers(), {
      stepUpToken: stepUp.token,
      subjectUserId: userId,
      reason: 'Profile photo permission fixture',
    });
    const headers = { 'x-nh-support-token': support.token };
    const session = await (
      await request(owner, 'GET', '/v1/web/session', undefined, headers)
    ).json();
    expect(session.actor).toMatchObject({ id: ownerId, avatarUrl: ownerAvatarUrl });
    expect(session.subject).toMatchObject({ id: userId, avatarUrl });
    expect((await request(owner, 'GET', avatarUrl, undefined, headers)).status).toBe(200);
    expect((await request(owner, 'GET', ownerAvatarUrl, undefined, headers)).status).toBe(200);
    expect((await request(owner, 'PUT', '/v1/web/profile-photo', photo(120), headers)).status).toBe(
      403,
    );
    expect(
      (
        await request(owner, 'DELETE', '/v1/web/profile-photo', undefined, {
          cookie: `${owner.headers().get('cookie')}; nh.support=${support.token}`,
        })
      ).status,
    ).toBe(403);
    expect((await request(user, 'GET', avatarUrl, undefined, headers)).status).toBe(403);
    await identity.endSupport(owner.headers(), support.token);
  });

  it('rolls back replacement and deletion when their required audit cannot be recorded', async () => {
    const before = await savedPhoto();
    await database.pool.query(
      "ALTER TABLE audit_events ADD CONSTRAINT fixture_reject_photo_audit CHECK (action NOT LIKE 'profile.photo.%') NOT VALID",
    );
    try {
      expect((await request(user, 'PUT', '/v1/web/profile-photo', photo(160))).status).toBe(500);
      expect(await savedPhoto()).toEqual(before);
      expect((await request(user, 'DELETE', '/v1/web/profile-photo')).status).toBe(500);
      expect(await savedPhoto()).toEqual(before);
    } finally {
      await database.pool.query(
        'ALTER TABLE audit_events DROP CONSTRAINT fixture_reject_photo_audit',
      );
    }
  });

  it('replaces only the authenticated account photo and invalidates its old URL', async () => {
    const previousUrl = avatarUrl;
    const response = await request(user, 'PUT', '/v1/web/profile-photo', photo(200));
    expect(response.status).toBe(200);
    avatarUrl = (await response.json()).avatarUrl;
    expect(avatarUrl).not.toBe(previousUrl);
    expect((await request(user, 'GET', previousUrl)).status).toBe(404);
    expect((await request(user, 'GET', avatarUrl)).status).toBe(200);
    expect((await request(owner, 'GET', ownerAvatarUrl)).status).toBe(200);
    expect(
      await database.db.selectFrom('user_profile_photos').select('user_id').execute(),
    ).toHaveLength(2);
  });

  it('removes the stored photo idempotently and restores null without changing linked identity', async () => {
    expect((await request(user, 'DELETE', '/v1/web/profile-photo')).status).toBe(204);
    expect(await savedPhoto()).toBeUndefined();
    expect((await request(user, 'GET', avatarUrl)).status).toBe(404);
    const session = await (await request(user, 'GET', '/v1/web/session')).json();
    expect(session.subject.avatarUrl).toBeNull();
    expect((await request(user, 'DELETE', '/v1/web/profile-photo')).status).toBe(204);
    expect((await request(owner, 'GET', ownerAvatarUrl)).status).toBe(200);
    expect(
      await database.db
        .selectFrom('audit_events')
        .select('actor_user_id')
        .where('action', '=', 'profile.photo.removed')
        .execute(),
    ).toEqual([{ actor_user_id: userId }, { actor_user_id: userId }]);
  });

  it('rechecks actual session authority on every image request', async () => {
    expect((await owner.request('/sign-out', {})).status).toBe(200);
    expect((await request(owner, 'GET', ownerAvatarUrl)).status).toBe(401);
  });
});
