import { createHash } from 'node:crypto';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type createDatabase, recordAudit } from '@nickhosting/database';
import type { Context, Hono } from 'hono';
import type { Variables } from './app.js';
import { normalizeProfilePhoto, profilePhotoMaxBytes } from './profile-photo-image.js';

type C = Context<{ Variables: Variables }>;

export function profilePhotoUrl(userId: string, revision: string | null): string | null {
  return revision === null
    ? null
    : `/v1/web/profile-photo/${encodeURIComponent(userId)}?v=${revision}`;
}

async function readPhoto(c: C): Promise<Buffer> {
  if (c.req.header('content-type') !== 'image/png') throw new DomainError('validation_failed');
  const declared = c.req.header('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > profilePhotoMaxBytes))
    throw new DomainError('validation_failed', 413);
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new DomainError('validation_failed');
  const bytes = Buffer.alloc(profilePhotoMaxBytes);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > profilePhotoMaxBytes)
        throw new DomainError('validation_failed', 413);
      bytes.set(value, size);
      size += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof DomainError) throw error;
    throw new DomainError('validation_failed');
  } finally {
    reader.releaseLock();
  }
  return bytes.subarray(0, size);
}

export function registerProfilePhotoRoutes(
  app: Hono<{ Variables: Variables }>,
  options: {
    db: ReturnType<typeof createDatabase>['db'];
    principal: (c: C, regularOnly?: boolean) => Promise<AuthContext>;
  },
) {
  const { db, principal } = options;
  const regularSelf = async (c: C) => {
    const context = await principal(c, true);
    if (context.sessionType !== 'regular' || context.actorUserId !== context.subjectUserId)
      throw new DomainError('forbidden');
    return context;
  };
  app.put('/v1/web/profile-photo', async (c) => {
    const context = await regularSelf(c);
    const content = normalizeProfilePhoto(await readPhoto(c));
    const revision = createHash('sha256').update(content).digest('hex');
    await db.transaction().execute(async (tx) => {
      await tx
        .insertInto('user_profile_photos')
        .values({ user_id: context.actorUserId, content, revision })
        .onConflict((conflict) =>
          conflict.column('user_id').doUpdateSet({ content, revision, updated_at: new Date() }),
        )
        .execute();
      await recordAudit(tx, context, 'profile.photo.updated');
    });
    return c.json({ avatarUrl: profilePhotoUrl(context.actorUserId, revision) });
  });
  app.delete('/v1/web/profile-photo', async (c) => {
    const context = await regularSelf(c);
    await db.transaction().execute(async (tx) => {
      await tx
        .deleteFrom('user_profile_photos')
        .where('user_id', '=', context.actorUserId)
        .execute();
      await recordAudit(tx, context, 'profile.photo.removed');
    });
    return c.body(null, 204);
  });
  app.get('/v1/web/profile-photo/:userId', async (c) => {
    const context = await principal(c);
    const userId = c.req.param('userId');
    const revision = c.req.query('v');
    if (
      (userId !== context.actorUserId && userId !== context.subjectUserId) ||
      !revision ||
      !/^[0-9a-f]{64}$/.test(revision)
    )
      throw new DomainError('not_found');
    const photo = await db
      .selectFrom('user_profile_photos')
      .select('content')
      .where('user_id', '=', userId)
      .where('revision', '=', revision)
      .executeTakeFirst();
    if (!photo) throw new DomainError('not_found');
    c.header('Content-Type', 'image/png');
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(photo.content));
  });
}
