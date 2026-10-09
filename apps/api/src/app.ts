import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Identity } from '@nickhosting/auth';
import {
  type AuthContext,
  assertPermission,
  DomainError,
  type SecretCodec,
  safeError,
} from '@nickhosting/core';
import {
  type createDatabase,
  gameCatalog,
  getSettings,
  recordAudit,
  registerGame,
  secretNames,
  secretStatus,
  storeSecret,
  updateSettings,
} from '@nickhosting/database';
import { localizeAuthError, localizeError, resolveLocale } from '@nickhosting/i18n';
import { enqueueCommand, getJobStatus } from '@nickhosting/jobs';
import type { ManagementRuntime } from '@nickhosting/server-management';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { registerServerRoutes } from './servers.js';

type Store = ReturnType<typeof createDatabase>;
interface Options {
  database: Store;
  identity: () => Promise<Identity>;
  codec: SecretCodec;
  origins: readonly string[] | (() => Promise<readonly string[]>);
  env?: Readonly<Record<string, string | undefined>>;
  defaultLocale?: () => Promise<'en' | 'it'>;
  log?: (event: Record<string, unknown>) => void;
  management?: () => Promise<ManagementRuntime>;
}
export type Variables = {
  identity: Identity;
  requestId: string;
  authHeaders: Headers;
  locale?: 'en' | 'it';
};

async function body(c: Context): Promise<unknown> {
  if (!c.req.header('content-type')?.startsWith('application/json'))
    throw new DomainError('validation_failed');
  try {
    return await c.req.json();
  } catch {
    throw new DomainError('validation_failed');
  }
}
function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new DomainError('validation_failed');
  return parsed.data;
}

export function createApp(options: Options) {
  const app = new Hono<{ Variables: Variables }>();
  const { db, pool } = options.database;
  const env = options.env ?? {};
  const origins = async () =>
    typeof options.origins === 'function' ? await options.origins() : options.origins;
  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID());
    const headers = new Headers(c.req.raw.headers);
    for (const key of [
      'x-nh-client-ip',
      'x-forwarded-for',
      'forwarded',
      'x-real-ip',
      'cf-connecting-ip',
      'x-client-ip',
    ])
      headers.delete(key);
    try {
      const address = getConnInfo(c).remote.address;
      if (address && isIP(address)) headers.set('x-nh-client-ip', address);
    } catch {
      /* In-process clients use Better Auth's conservative shared bucket. */
    }
    c.set('authHeaders', headers);
    c.header('X-Request-ID', c.get('requestId'));
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    await next();
  });
  app.use(
    '*',
    cors({
      origin: async (origin) => ((await origins()).includes(origin) ? origin : undefined),
      credentials: true,
      allowHeaders: ['Content-Type', 'X-NH-Support-Token', 'X-Invitation-Token'],
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    }),
  );
  app.use(
    '*',
    bodyLimit({
      maxSize: 65_536,
      onError: () => {
        throw new DomainError('validation_failed', 413);
      },
    }),
  );
  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (!origin || !(await origins()).includes(origin)) throw new DomainError('forbidden');
    }
    await next();
  });
  app.onError(async (error, c) => {
    const pgCode = typeof error === 'object' && error && 'code' in error ? error.code : undefined;
    const failure = pgCode === '23505' ? new DomainError('conflict') : error;
    const normalized = safeError(failure);
    options.log?.({
      event: 'request.failed',
      requestId: c.get('requestId'),
      code: normalized.code,
      status: normalized.status,
    });
    const locale = resolveLocale(
      c.get('locale'),
      c.req.header('accept-language'),
      await options.defaultLocale?.().catch(() => 'en' as const),
    );
    return c.json(
      { error: localizeError(failure, locale), requestId: c.get('requestId') },
      normalized.status as ContentfulStatusCode,
    );
  });
  app.notFound(() => {
    throw new DomainError('not_found');
  });
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', async (c) => {
    try {
      await pool.query('SELECT 1');
      return c.json({ status: 'ready' });
    } catch {
      throw new DomainError('integration_unavailable');
    }
  });
  app.use('/api/*', async (c, next) => {
    const identity = await options.identity();
    c.set('identity', identity);
    const session = await identity.auth.api.getSession({ headers: c.get('authHeaders') });
    if (session) c.set('locale', session.user.locale === 'it' ? 'it' : 'en');
    await next();
  });
  app.use('/v1/*', async (c, next) => {
    const identity = await options.identity();
    c.set('identity', identity);
    const session = await identity.auth.api.getSession({ headers: c.get('authHeaders') });
    if (session) c.set('locale', session.user.locale === 'it' ? 'it' : 'en');
    await next();
  });

  const noSupport = (c: Context) => {
    if (c.req.header('x-nh-support-token')) throw new DomainError('forbidden');
  };
  const principal = async (
    c: Context<{ Variables: Variables }>,
    regularOnly = false,
  ): Promise<AuthContext> => {
    if (regularOnly) noSupport(c);
    const { context, locale } = await c
      .get('identity')
      .authenticate(c.get('authHeaders'), c.req.header('x-nh-support-token'));
    c.set('locale', locale);
    if (context.sessionType === 'support')
      await recordAudit(db, context, 'support.request', {
        method: c.req.method,
        route: c.req.routePath,
      });
    return context;
  };
  app.get('/api/auth/error', async (c) =>
    c.json(
      {
        error: localizeAuthError(
          c.req.query('error') ?? 'UNKNOWN',
          resolveLocale(
            c.get('locale'),
            c.req.header('accept-language'),
            await options.defaultLocale?.().catch(() => 'en' as const),
          ),
        ),
        requestId: c.get('requestId'),
      },
      400,
    ),
  );
  app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
    noSupport(c);
    const response = await c
      .get('identity')
      .handler(new Request(c.req.raw, { headers: c.get('authHeaders') }));
    if (response.ok || (response.status >= 300 && response.status < 400)) return response;
    const payload = (await response
      .clone()
      .json()
      .catch(() => ({}))) as { code?: string };
    const locale = resolveLocale(
      c.get('locale'),
      c.req.header('accept-language'),
      await options.defaultLocale?.().catch(() => 'en' as const),
    );
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    headers.set('cache-control', 'no-store');
    return new Response(
      JSON.stringify({
        error: localizeAuthError(payload.code ?? 'UNKNOWN', locale),
        requestId: c.get('requestId'),
      }),
      { status: response.status, headers },
    );
  });
  app.get('/v1/setup', async (c) => c.json(await c.get('identity').bootstrapStatus()));
  app.post('/v1/setup/owner', async (c) => {
    noSupport(c);
    return c.json(await c.get('identity').claimOwner(await body(c)), 201);
  });
  app.post('/v1/setup/complete', async (c) => {
    noSupport(c);
    return c.json(await c.get('identity').completeSetup(c.get('authHeaders'), await body(c)));
  });
  app.get('/v1/invitations/:token', async (c) =>
    c.json(await c.get('identity').inspectInvitation(c.req.param('token'))),
  );
  app.get('/v1/me', async (c) => c.json({ identity: await principal(c) }));
  app.post('/v1/identity/link-email', async (c) => {
    noSupport(c);
    return c.json(await c.get('identity').addEmailPassword(c.get('authHeaders'), await body(c)));
  });
  app.post('/v1/identity/confirm-email', async (c) => {
    noSupport(c);
    return c.json(
      await c.get('identity').confirmEmailPassword(c.get('authHeaders'), await body(c)),
    );
  });
  app.post('/v1/identity/step-up', async (c) => {
    noSupport(c);
    return c.json(await c.get('identity').stepUp(c.get('authHeaders'), await body(c)));
  });
  app.post('/v1/support', async (c) => {
    noSupport(c);
    return c.json(await c.get('identity').startSupport(c.get('authHeaders'), await body(c)), 201);
  });
  app.post('/v1/support/exit', async (c) => {
    const input = validate(
      z.object({ token: z.string().min(20).max(256) }).strict(),
      await body(c),
    );
    await c.get('identity').endSupport(c.get('authHeaders'), input.token);
    return c.body(null, 204);
  });
  app.get('/v1/owner/invitations', async (c) => {
    noSupport(c);
    return c.json(await c.get('identity').listInvitations(c.get('authHeaders')));
  });
  app.post('/v1/owner/invitations', async (c) => {
    noSupport(c);
    return c.json(
      await c.get('identity').createInvitation(c.get('authHeaders'), await body(c)),
      201,
    );
  });
  app.delete('/v1/owner/invitations/:id', async (c) => {
    noSupport(c);
    await c.get('identity').revokeInvitation(c.get('authHeaders'), c.req.param('id'));
    return c.body(null, 204);
  });
  app.patch('/v1/owner/roles', async (c) => {
    noSupport(c);
    await c.get('identity').setRole(c.get('authHeaders'), await body(c));
    return c.body(null, 204);
  });
  app.get('/v1/owner/audit', async (c) => {
    noSupport(c);
    return c.json(await c.get('identity').listAudit(c.get('authHeaders')));
  });
  app.get('/v1/owner/settings', async (c) => {
    const context = await principal(c, true);
    assertPermission(context, 'settings:read');
    return c.json({ config: await getSettings(db, env), secrets: await secretStatus(db, env) });
  });
  app.patch('/v1/owner/settings', async (c) =>
    c.json(await updateSettings(db, await principal(c, true), await body(c), env)),
  );
  app.put('/v1/owner/secrets/:name', async (c) => {
    const name = validate(z.enum(secretNames), c.req.param('name'));
    const input = validate(
      z.object({ value: z.string().min(1).max(4096) }).strict(),
      await body(c),
    );
    await storeSecret(db, await principal(c, true), options.codec, name, input.value, env);
    return c.body(null, 204);
  });
  app.put('/v1/owner/games', async (c) => {
    const input = validate(
      z.object({ manifest: z.unknown(), rollout: z.unknown() }).strict(),
      await body(c),
    );
    await registerGame(db, await principal(c, true), input.manifest, input.rollout);
    return c.body(null, 204);
  });
  app.get('/v1/games', async (c) => c.json(await gameCatalog(db, await principal(c))));
  app.post('/v1/jobs', async (c) => {
    const context = await principal(c);
    const input = validate(
      z.object({ idempotencyKey: z.string().min(1).max(128), command: z.unknown() }).strict(),
      await body(c),
    );
    return c.json(
      await enqueueCommand(db, { context, resourceOwnerId: context.subjectUserId, ...input }),
      202,
    );
  });
  app.get('/v1/jobs/:id', async (c) =>
    c.json(await getJobStatus(db, c.req.param('id'), await principal(c))),
  );
  registerServerRoutes(app, {
    db,
    env,
    principal,
    management:
      options.management ??
      (async () => {
        throw new DomainError('integration_unavailable');
      }),
  });
  return app;
}
