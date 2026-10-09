import { DomainError } from '@nickhosting/core';
import {
  deletePlatformProject,
  getPlatformConnections,
  getPlatformJob,
  getPlatformProject,
  getPlatformQuota,
  getPlatformServer,
  getPlatformSleepPolicy,
  getPlatformTransfers,
  getPlatformUser,
  listPlatformActivity,
  listPlatformAudit,
  listPlatformGames,
  listPlatformMetrics,
  listPlatformProjects,
  listPlatformServers,
  listPlatformUsers,
  lookupProjectCollaborator,
  retryPlatformJob,
  updatePlatformProject,
  updatePlatformServer,
} from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

type C = Context<{ Variables: Variables }>;
async function body(c: C): Promise<unknown> {
  if (!c.req.header('content-type')?.startsWith('application/json'))
    throw new DomainError('validation_failed');
  try {
    return await c.req.json();
  } catch {
    throw new DomainError('validation_failed');
  }
}
/** Additive browser contracts. Existing M1–M4 arrays/clients remain unchanged. */
export function registerPlatformRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Omit<ServerRouteOptions, 'acquireUploadSlot'>,
) {
  const { db, env, principal, management } = options;
  app.get('/v1/platform/servers', async (c) =>
    c.json(await listPlatformServers(db, await principal(c), c.req.query())),
  );
  app.get('/v1/platform/servers/:id', async (c) =>
    c.json(await getPlatformServer(db, await principal(c), c.req.param('id'))),
  );
  app.patch('/v1/platform/servers/:id', async (c) =>
    c.json(
      await updatePlatformServer(db, await principal(c), c.req.param('id'), await body(c), env),
    ),
  );
  app.get('/v1/platform/servers/:id/connections', async (c) =>
    c.json(await getPlatformConnections(db, await principal(c), c.req.param('id'), env)),
  );
  app.get('/v1/platform/servers/:id/transfers', async (c) =>
    c.json(await getPlatformTransfers(db, await principal(c), c.req.param('id'), env)),
  );
  app.get('/v1/platform/servers/:id/sleep-policy', async (c) =>
    c.json(await getPlatformSleepPolicy(db, await principal(c), c.req.param('id'))),
  );
  app.get('/v1/platform/servers/:id/metrics', async (c) =>
    c.json(await listPlatformMetrics(db, await principal(c), c.req.param('id'), c.req.query())),
  );
  app.get('/v1/platform/projects', async (c) =>
    c.json(await listPlatformProjects(db, await principal(c), c.req.query())),
  );
  app.get('/v1/platform/projects/:id', async (c) =>
    c.json(await getPlatformProject(db, await principal(c), c.req.param('id'))),
  );
  app.patch('/v1/platform/projects/:id', async (c) =>
    c.json(
      await updatePlatformProject(db, await principal(c), c.req.param('id'), await body(c), env),
    ),
  );
  app.delete('/v1/platform/projects/:id', async (c) =>
    c.json(
      await deletePlatformProject(db, await principal(c), c.req.param('id'), await body(c), env),
    ),
  );
  app.post('/v1/platform/projects/:id/collaborator', async (c) =>
    c.json(
      await lookupProjectCollaborator(db, await principal(c), c.req.param('id'), await body(c)),
    ),
  );
  app.get('/v1/platform/quotas', async (c) =>
    c.json(await getPlatformQuota(db, await principal(c), undefined, env)),
  );
  app.get('/v1/platform/activity', async (c) =>
    c.json(await listPlatformActivity(db, await principal(c), c.req.query())),
  );
  app.get('/v1/platform/jobs/:id', async (c) =>
    c.json(await getPlatformJob(db, await principal(c), c.req.param('id'))),
  );
  app.post('/v1/platform/jobs/:id/retry', async (c) => {
    const context = await principal(c),
      input = await body(c);
    await getPlatformJob(db, context, c.req.param('id'));
    await (await management()).refreshObservations();
    return c.json(await retryPlatformJob(db, context, c.req.param('id'), input, env), 202);
  });
  app.get('/v1/platform/owner/users', async (c) =>
    c.json(await listPlatformUsers(db, await principal(c, true), c.req.query())),
  );
  app.get('/v1/platform/owner/users/:id', async (c) =>
    c.json(await getPlatformUser(db, await principal(c, true), c.req.param('id'), env)),
  );
  app.get('/v1/platform/owner/audit', async (c) =>
    c.json(await listPlatformAudit(db, await principal(c, true), c.req.query())),
  );
  app.get('/v1/platform/owner/games', async (c) =>
    c.json(await listPlatformGames(db, await principal(c, true))),
  );
}
