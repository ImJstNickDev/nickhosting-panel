import { DomainError } from '@nickhosting/core';
import { authorizeServer, enqueueServerOperation } from '@nickhosting/server-management';
import type { Hono } from 'hono';
import { z } from 'zod';
import { satisfactoryModSelectionSchema } from '../../../games/satisfactory/src/mods.js';
import {
  satisfactoryModSearchSchema,
  satisfactoryModVersions,
  searchSatisfactoryMods,
} from '../../../games/satisfactory/src/mods-catalog.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerSatisfactoryModRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal' | 'env'>,
) {
  const base = '/v1/servers/:id/satisfactory/mods';
  async function access(
    context: Awaited<ReturnType<typeof options.principal>>,
    id: string,
    manage = false,
  ) {
    const server = await authorizeServer(
      options.db,
      context,
      id,
      manage ? 'server:manage' : 'server:read',
    );
    const mapping = await options.db
      .selectFrom('runtime_egg_mappings')
      .select('game_id')
      .where('id', '=', server.mapping_id)
      .executeTakeFirst();
    if (mapping?.game_id !== 'satisfactory') throw new DomainError('not_found');
    return server;
  }
  app.get(base, async (c) => {
    c.header('cache-control', 'no-store');
    await access(await options.principal(c), c.req.param('id'));
    const row = await options.db
      .selectFrom('satisfactory_mod_states')
      .select(['selection', 'lock', 'updated_at'])
      .where('server_id', '=', c.req.param('id'))
      .executeTakeFirst();
    return c.json(row ?? { selection: [], lock: { version: 1, mods: {} }, updated_at: null });
  });
  app.get(`${base}/catalog`, async (c) => {
    await access(await options.principal(c), c.req.param('id'));
    const input = z
      .object({
        query: satisfactoryModSearchSchema.default(''),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .safeParse(c.req.query());
    if (!input.success) throw new DomainError('validation_failed');
    try {
      return c.json(await searchSatisfactoryMods(input.data));
    } catch {
      throw new DomainError('integration_unavailable');
    }
  });
  app.get(`${base}/versions/:reference`, async (c) => {
    await access(await options.principal(c), c.req.param('id'));
    try {
      return c.json(await satisfactoryModVersions(c.req.param('reference')));
    } catch {
      throw new DomainError('integration_unavailable');
    }
  });
  app.post(`${base}/apply`, async (c) => {
    const context = await options.principal(c),
      id = c.req.param('id');
    await access(context, id, true);
    const input = z
      .strictObject({
        selection: satisfactoryModSelectionSchema,
        idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new DomainError('validation_failed');
    return c.json(
      await enqueueServerOperation(
        options.db,
        context,
        id,
        {
          action: 'satisfactory-content',
          idempotencyKey: input.data.idempotencyKey,
          command: { kind: 'mods', selection: input.data.selection },
        },
        options.env,
      ),
      202,
    );
  });
}
