import type { AuthContext, SecretCodec } from '@nickhosting/core';
import { DomainError } from '@nickhosting/core';
import { type createDatabase, getSecret, getSettings } from '@nickhosting/database';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Variables } from './app.js';

type C = Context<{ Variables: Variables }>;
const cookieName = 'nh.support';

/** An HttpOnly browser transport for the existing parent-session-bound token.
 * Header clients retain their contract; disagreement never changes authority. */
export function supportToken(c: C): string | undefined {
  const header = c.req.header('x-nh-support-token');
  const cookie = getCookie(c, cookieName);
  if (header && cookie && header !== cookie) throw new DomainError('support_invalid');
  return header ?? cookie;
}

export function registerWebSessionRoutes(
  app: Hono<{ Variables: Variables }>,
  options: {
    db: ReturnType<typeof createDatabase>['db'];
    env: Readonly<Record<string, string | undefined>>;
    codec: SecretCodec;
    principal: (c: C, regularOnly?: boolean) => Promise<AuthContext>;
    body: (c: Context) => Promise<unknown>;
  },
) {
  const { db, env, codec, principal, body } = options;
  app.get('/v1/web/config', async (c) => {
    const { values } = await getSettings(db, env);
    const discordSecret = await getSecret(db, codec, 'discordClientSecret', env);
    return c.json({
      instanceName: values.instanceName,
      defaultLocale: values.defaultLocale,
      supportSessionPresent: Boolean(getCookie(c, cookieName)),
      auth: {
        email: Boolean(values.smtpHost && values.smtpFrom),
        discord: Boolean(values.discordClientId && discordSecret),
        passkey: true,
        totp: true,
      },
    });
  });
  app.get('/v1/web/session', async (c) => {
    const context = await principal(c);
    const users = await db
      .selectFrom('user')
      .select(['id', 'name', 'email', 'emailVerified', 'locale', 'role', 'twoFactorEnabled'])
      .where('id', 'in', [context.actorUserId, context.subjectUserId])
      .execute();
    const actor = users.find((user) => user.id === context.actorUserId);
    const subject = users.find((user) => user.id === context.subjectUserId);
    if (!actor || !subject) throw new DomainError('unauthenticated');
    return c.json({ context, actor, subject });
  });
  app.post('/v1/web/support', async (c) => {
    await principal(c, true);
    const result = await c.get('identity').startSupport(c.get('authHeaders'), await body(c));
    const { values } = await getSettings(db, env);
    const secure = values.publicUrl?.startsWith('https:') === true;
    setCookie(c, cookieName, result.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
      secure,
      expires: result.expiresAt,
    });
    return c.json(
      { id: result.id, expiresAt: result.expiresAt, idleTtlSeconds: result.idleTtlSeconds },
      201,
    );
  });
  app.post('/v1/web/support/exit', async (c) => {
    const token = supportToken(c);
    // A stale/expired support cookie must never trap the ordinary Owner. The
    // original parent session is still required for the durable revocation.
    if (token) {
      try {
        await c.get('identity').endSupport(c.get('authHeaders'), token);
      } catch (error) {
        // These credentials no longer authorize the assisted session. Clearing
        // this browser's stale cookie does not claim a database revocation or
        // change another parent session's grant. Storage failures remain errors.
        if (
          !(error instanceof DomainError) ||
          !['unauthenticated', 'forbidden', 'support_invalid'].includes(error.code)
        )
          throw error;
      }
    }
    deleteCookie(c, cookieName, { path: '/' });
    return c.body(null, 204);
  });
}
