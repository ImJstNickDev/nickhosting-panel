import { DomainError } from '@nickhosting/core';
import {
  deletePlatformProject,
  deleteServerSubuser,
  getGameAutoWakePolicy,
  getGameContentPolicy,
  getGameDomainPolicy,
  getGameSleepPolicy,
  getPlatformConnections,
  getPlatformJob,
  getPlatformProject,
  getPlatformQuota,
  getPlatformServer,
  getPlatformSleepPolicy,
  getPlatformTransfers,
  getPlatformUser,
  getServerAutoWakePolicy,
  listPlatformActivity,
  listPlatformAudit,
  listPlatformGames,
  listPlatformMetrics,
  listPlatformProjects,
  listPlatformServers,
  listPlatformUsers,
  listServerSubusers,
  lookupProjectCollaborator,
  lookupServerCollaborator,
  reconcileServerUserSftpCredentials,
  retryPlatformJob,
  setGameAutoWakePolicy,
  setGameContentPolicy,
  setGameDomainPolicy,
  setGameSleepPolicy,
  setServerAutoWakePolicy,
  setServerSubuser,
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
  app.get('/v1/owner/storage-policy', async (c) => {
    const context = await principal(c, true);
    return c.json(await (await management()).storagePolicy.status(context));
  });
  app.post('/v1/owner/storage-policy/preview', async (c) => {
    const context = await principal(c, true);
    return c.json(await (await management()).storagePolicy.preview(context, await body(c)), 201);
  });
  app.get('/v1/owner/storage-policy/:id', async (c) => {
    const context = await principal(c, true);
    return c.json(await (await management()).storagePolicy.get(context, c.req.param('id')));
  });
  app.post('/v1/owner/storage-policy/:id/apply', async (c) => {
    const context = await principal(c, true);
    return c.json(
      await (await management()).storagePolicy.apply(context, c.req.param('id'), await body(c)),
      202,
    );
  });
  app.post('/v1/owner/storage-policy/:id/retry', async (c) => {
    const context = await principal(c, true);
    return c.json(await (await management()).storagePolicy.retry(context, c.req.param('id')), 202);
  });
  app.post('/v1/owner/storage-policy/:id/refresh', async (c) => {
    const context = await principal(c, true);
    return c.json(await (await management()).storagePolicy.refresh(context, c.req.param('id')));
  });
  app.get('/v1/owner/integrations/:gameId/auto-wake-policy', async (c) =>
    c.json(await getGameAutoWakePolicy(db, await principal(c, true), c.req.param('gameId'), env)),
  );
  app.put('/v1/owner/integrations/:gameId/auto-wake-policy', async (c) =>
    c.json(
      await setGameAutoWakePolicy(
        db,
        await principal(c, true),
        c.req.param('gameId'),
        await body(c),
        env,
      ),
    ),
  );
  app.get('/v1/platform/servers/:id/auto-wake-policy', async (c) =>
    c.json(await getServerAutoWakePolicy(db, await principal(c), c.req.param('id'), env)),
  );
  app.put('/v1/platform/servers/:id/auto-wake-policy', async (c) =>
    c.json(
      await setServerAutoWakePolicy(db, await principal(c), c.req.param('id'), await body(c), env),
    ),
  );
  app.get('/v1/owner/integrations/:gameId/sleep-policy', async (c) =>
    c.json(await getGameSleepPolicy(db, await principal(c, true), c.req.param('gameId'), env)),
  );
  app.get('/v1/owner/integrations/:gameId/domain-policy', async (c) =>
    c.json(await getGameDomainPolicy(db, await principal(c, true), c.req.param('gameId'), env)),
  );
  app.put('/v1/owner/integrations/:gameId/domain-policy', async (c) =>
    c.json(
      await setGameDomainPolicy(
        db,
        await principal(c, true),
        c.req.param('gameId'),
        await body(c),
        env,
      ),
    ),
  );
  app.get('/v1/owner/integrations/:gameId/content-policy', async (c) =>
    c.json(await getGameContentPolicy(db, await principal(c, true), c.req.param('gameId'), env)),
  );
  app.put('/v1/owner/integrations/:gameId/content-policy', async (c) =>
    c.json(
      await setGameContentPolicy(
        db,
        await principal(c, true),
        c.req.param('gameId'),
        await body(c),
        env,
      ),
    ),
  );
  app.put('/v1/owner/integrations/:gameId/sleep-policy', async (c) =>
    c.json(
      await setGameSleepPolicy(
        db,
        await principal(c, true),
        c.req.param('gameId'),
        await body(c),
        env,
      ),
    ),
  );
  app.get('/v1/platform/servers', async (c) => {
    const ownerIds = c.req.queries('ownerIds');
    return c.json(
      await listPlatformServers(
        db,
        await principal(c),
        {
          ...c.req.query(),
          ...(ownerIds === undefined ? {} : { ownerIds }),
        },
        env,
      ),
    );
  });
  app.get('/v1/platform/servers/:id', async (c) =>
    c.json(await getPlatformServer(db, await principal(c), c.req.param('id'), env)),
  );
  async function reconcileCredentials(serverIds: string[]) {
    if (!serverIds.length) return;
    const subjects = await db
      .selectFrom('external_sftp_credentials')
      .select(['server_id', 'actor_id'])
      .where('server_id', 'in', serverIds)
      .where('state', '!=', 'revoked')
      .distinct()
      .execute();
    if (!subjects.length) return;
    const service = await management();
    for (const subject of subjects)
      await reconcileServerUserSftpCredentials(
        db,
        subject.server_id,
        subject.actor_id,
        service.externalOptions,
      );
  }
  app.patch('/v1/platform/servers/:id', async (c) => {
    const input = await body(c);
    const result = await updatePlatformServer(
      db,
      await principal(c),
      c.req.param('id'),
      input,
      env,
    );
    if (input && typeof input === 'object' && 'projectId' in input)
      await reconcileCredentials([c.req.param('id')]);
    return c.json(result);
  });
  app.get('/v1/platform/servers/:id/subusers', async (c) =>
    c.json(await listServerSubusers(db, await principal(c), c.req.param('id'))),
  );
  app.post('/v1/platform/servers/:id/subusers/lookup', async (c) =>
    c.json(
      await lookupServerCollaborator(db, await principal(c), c.req.param('id'), await body(c)),
    ),
  );
  app.put('/v1/platform/servers/:id/subusers/:userId', async (c) => {
    const result = await setServerSubuser(
      db,
      await principal(c),
      c.req.param('id'),
      c.req.param('userId'),
      await body(c),
      env,
    );
    await reconcileServerUserSftpCredentials(
      db,
      c.req.param('id'),
      c.req.param('userId'),
      (await management()).externalOptions,
    );
    return c.json(result);
  });
  app.delete('/v1/platform/servers/:id/subusers/:userId', async (c) => {
    const result = await deleteServerSubuser(
      db,
      await principal(c),
      c.req.param('id'),
      c.req.param('userId'),
      env,
    );
    await reconcileServerUserSftpCredentials(
      db,
      c.req.param('id'),
      c.req.param('userId'),
      (await management()).externalOptions,
    );
    return c.json(result);
  });
  app.get('/v1/platform/servers/:id/connections', async (c) =>
    c.json(await getPlatformConnections(db, await principal(c), c.req.param('id'), env)),
  );
  app.get('/v1/platform/servers/:id/transfers', async (c) =>
    c.json(await getPlatformTransfers(db, await principal(c), c.req.param('id'), env)),
  );
  app.get('/v1/platform/servers/:id/sleep-policy', async (c) =>
    c.json(await getPlatformSleepPolicy(db, await principal(c), c.req.param('id'), env)),
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
  app.delete('/v1/platform/projects/:id', async (c) => {
    const result = await deletePlatformProject(
      db,
      await principal(c),
      c.req.param('id'),
      await body(c),
      env,
      reconcileCredentials,
    );
    return c.json(result);
  });
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
