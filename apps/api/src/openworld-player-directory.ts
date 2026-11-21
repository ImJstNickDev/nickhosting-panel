import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import { createOpenworldPlayerDirectory } from '../../../packages/server-management/src/openworld-player-directory.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

const pagination = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  q: z.string().trim().max(150).default(''),
});

export function registerOpenworldPlayerDirectoryRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal'> &
    Partial<Pick<ServerRouteOptions, 'management'>>,
  directory = createOpenworldPlayerDirectory(options.db, async (who, id, work) => {
    if (!options.management) throw new DomainError('integration_unavailable');
    const runtime = await options.management();
    return runtime.fileReadScope(
      who,
      id,
      work,
      AbortSignal.timeout(30000),
      'game.openworld.players.inspect',
    );
  }),
) {
  const base = '/v1/servers/:id/openworld/players/saved';
  app.get(base, async (c) => {
    c.header('cache-control', 'private, no-store');
    const who = await options.principal(c);
    const parsed = pagination.safeParse(c.req.query());
    if (!parsed.success) throw new DomainError('validation_failed');
    return c.json(await directory.list(who, c.req.param('id'), parsed.data.q, parsed.data.page));
  });
  app.get(`${base}/:uuid`, async (c) => {
    c.header('cache-control', 'private, no-store');
    return c.json(
      await directory.detail(await options.principal(c), c.req.param('id'), c.req.param('uuid')),
    );
  });
}
