import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import { openworldActionSchema } from '../../../games/openworld/src/player-actions.js';
import { resolveOpenworldDashboardTarget } from '../../../packages/server-management/src/openworld-dashboard.js';
import { createOpenworldPlayerActions } from '../../../packages/server-management/src/openworld-player-actions.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerOpenworldPlayerActionRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal'> &
    Partial<Pick<ServerRouteOptions, 'management'>>,
  service = createOpenworldPlayerActions({
    db: options.db,
    target: async (id) => {
      if (!options.management) throw new DomainError('integration_unavailable');
      return resolveOpenworldDashboardTarget(options.db, (await options.management()).adapter, id);
    },
  }),
) {
  const base = '/v1/servers/:id/openworld/players';
  app.get(`${base}/destinations`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(await service.destinations(await options.principal(c), c.req.param('id')));
  });
  app.post(`${base}/actions`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const who = await options.principal(c);
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      throw new DomainError('validation_failed');
    const data = openworldActionSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!data.success) throw new DomainError('validation_failed');
    return c.json(await service.perform(who, c.req.param('id'), data.data), 202);
  });
}
