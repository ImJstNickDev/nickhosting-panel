import { type AuthContext, authSessionId, DomainError, type SecretCodec } from '@nickhosting/core';
import { relativePath } from '@nickhosting/pterodactyl-adapter';
import { parse } from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';
import { ViewerFormatError } from './viewer-cache.js';
import { openLogViewer } from './viewer-log.js';
import { type OpenLogSnapshot, ViewerLogSessions } from './viewer-log-sessions.js';
import type { FileViewerService } from './viewer-service.js';

type C = Context<{ Variables: Variables }>;
const pageSchema = z.strictObject({
  offset: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).default(-1),
  limit: z.number().int().min(1).max(500).default(200),
  query: z.string().max(256).default(''),
  level: z.enum(['all', 'error', 'warning', 'info']).default('all'),
});
const openSchema = z.strictObject({ path: z.string().min(1).max(4096) });
const ownerKey = (context: AuthContext, serverId: string) =>
  JSON.stringify([
    context[authSessionId],
    context.actorUserId,
    context.subjectUserId,
    context.support?.id,
    context.sessionType,
    serverId,
  ]);
const messages: Record<string, string> = {
  viewer_log_encoding: 'games.satisfactory.viewers.log.encoding',
  viewer_log_line_too_large: 'games.satisfactory.viewers.log.lineTooLarge',
  viewer_log_budget: 'games.satisfactory.viewers.log.budget',
  viewer_file_too_large: 'games.satisfactory.viewers.log.tooLarge',
  viewer_cache_busy: 'viewer.formatUnavailable',
  viewer_revision_changed: 'games.satisfactory.viewers.log.changed',
};
/** Log navigation shares the viewer disk cache and authorization boundary. */
export function registerLogViewerRoutes(
  app: Hono<{ Variables: Variables }>,
  options: ServerRouteOptions & { codec: SecretCodec },
  viewer: () => Promise<FileViewerService>,
) {
  const sessions = new ViewerLogSessions();
  const guard = (work: (c: C) => Promise<Response>) => async (c: C) => {
    c.header('Cache-Control', 'no-store');
    try {
      return await work(c);
    } catch (error) {
      if (error instanceof ViewerFormatError)
        return c.json(
          {
            error: {
              code: error.code,
              messageKey: messages[error.code] ?? 'viewer.formatUnavailable',
            },
          },
          422,
        );
      throw error;
    }
  };
  const access = async (c: C, id?: string) => {
    const context = await options.principal(c),
      runtime = await options.management();
    const serverId = c.req.param('id') ?? '';
    const owner = ownerKey(context, serverId);
    // Opaque handles never grant authority and do not reveal other users' sessions.
    const info = id ? sessions.inspect(owner, id) : undefined;
    try {
      const server = await runtime.fileReadAccess(
        context,
        serverId,
        async (_identifier, _db, _actor, server) => server,
      );
      const binding = runtime.uploadBatchBinding(server);
      if (info && info.binding !== binding) throw new DomainError('forbidden');
      return { context, runtime, serverId, owner, binding, path: info?.path };
    } catch (error) {
      if (id) await sessions.release(owner, id);
      throw error;
    }
  };
  const snapshot = async (
    a: Awaited<ReturnType<typeof access>>,
    path: string,
  ): Promise<OpenLogSnapshot> => {
    const opened = await (await viewer()).open(
      a.context,
      a.runtime,
      a.serverId,
      path,
      new AbortController().signal,
    );
    return {
      revision: opened.key,
      signal: opened.signal,
      close: opened.close,
      create: () =>
        openLogViewer(opened.source, {
          cache: opened.cache,
          key: JSON.stringify([a.owner, opened.key]),
          signal: opened.signal,
          restat: opened.restat,
        }),
    };
  };
  const base = '/v1/servers/:id/files/viewer/log/session';
  app.post(
    base,
    guard(async (c) => {
      const body = parse(openSchema, await c.req.json());
      const path = relativePath(body.path).slice(1);
      const a = await access(c);
      return c.json(
        await sessions.open(a.owner, path, a.binding, await snapshot(a, path), c.req.raw.signal),
      );
    }),
  );
  app.post(
    `${base}/:sessionId/page`,
    guard(async (c) => {
      const body = parse(pageSchema, await c.req.json());
      const id = c.req.param('sessionId') ?? '',
        a = await access(c, id);
      return c.json(await sessions.query(a.owner, id, body, c.req.raw.signal));
    }),
  );
  app.post(
    `${base}/:sessionId/refresh`,
    guard(async (c) => {
      const id = c.req.param('sessionId') ?? '',
        a = await access(c, id);
      return c.json(await sessions.refresh(a.owner, id, () => snapshot(a, a.path ?? '')));
    }),
  );
  app.post(
    `${base}/:sessionId/renew`,
    guard(async (c) => {
      const id = c.req.param('sessionId') ?? '',
        a = await access(c, id);
      sessions.renew(a.owner, id);
      return c.body(null, 204);
    }),
  );
  app.delete(
    `${base}/:sessionId`,
    guard(async (c) => {
      // No bytes are returned; verified identity may release its own lease even
      // after file permission was removed. Revocation also removes it proactively.
      const context = await options.principal(c);
      await sessions.release(
        ownerKey(context, c.req.param('id') ?? ''),
        c.req.param('sessionId') ?? '',
      );
      return c.body(null, 204);
    }),
  );
  return sessions;
}
