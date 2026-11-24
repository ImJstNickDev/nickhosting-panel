import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import { createOpenworldUpdates } from '../../../packages/server-management/src/openworld-updates.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerOpenworldUpdateRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'codec' | 'env' | 'principal'>,
) {
  const service = createOpenworldUpdates(options.db, options.codec, options.env);
  const path = '/v1/servers/:id/openworld/update';
  app.use(`${path}*`, async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.get(path, async (c) =>
    c.json(await service.options(await options.principal(c), c.req.param('id'))),
  );
  app.get(`${path}/current`, async (c) =>
    c.json(await service.current(await options.principal(c), c.req.param('id'))),
  );
  app.post(path, async (c) => {
    const who = await options.principal(c);
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      throw new DomainError('validation_failed');
    return c.json(
      await service.submit(who, c.req.param('id'), await c.req.json().catch(() => undefined)),
      202,
    );
  });
  app.post(`${path}/:updateId/cancel`, async (c) =>
    c.json(
      await service.cancel(await options.principal(c), c.req.param('id'), c.req.param('updateId')),
    ),
  );
}
