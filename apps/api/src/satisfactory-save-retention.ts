import { DomainError } from '@nickhosting/core';
import { authorizeServer } from '@nickhosting/server-management';
import type { Hono } from 'hono';
import {
  readSatisfactorySaveRetention,
  updateSatisfactorySaveRetention,
} from '../../../packages/server-management/src/satisfactory-save-retention.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerSatisfactorySaveRetentionRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal'> & {
    env?: Readonly<Record<string, string | undefined>>;
  },
) {
  const path = '/v1/servers/:id/satisfactory/api/worlds/retention';
  app.get(path, async (c) => {
    c.header('cache-control', 'no-store');
    const id = c.req.param('id');
    const server = await authorizeServer(options.db, await options.principal(c), id, 'server:read');
    const mapping = await options.db
      .selectFrom('runtime_egg_mappings')
      .select('game_id')
      .where('id', '=', server.mapping_id)
      .executeTakeFirst();
    if (mapping?.game_id !== 'satisfactory') throw new DomainError('not_found');
    return c.json(await readSatisfactorySaveRetention(options.db, id, options.env));
  });
  app.put(path, async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(
      await updateSatisfactorySaveRetention(
        options.db,
        await options.principal(c),
        c.req.param('id'),
        await c.req.json().catch(() => null),
        options.env,
      ),
    );
  });
}
