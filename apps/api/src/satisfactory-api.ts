import { DomainError } from '@nickhosting/core';
import { authorizeServer } from '@nickhosting/server-management';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  applySatisfactoryOptions,
  resolveSatisfactoryApi,
  satisfactoryApiConfigured,
  setSatisfactoryApiToken,
} from '../../../packages/server-management/src/satisfactory-api.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';
export function registerSatisfactoryApiRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'codec' | 'principal'>,
) {
  const base = '/v1/servers/:id/satisfactory/api';
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
    if (!options.codec) throw new DomainError('configuration_invalid');
    return options.codec;
  }
  app.get(base, async (c) => {
    c.header('cache-control', 'no-store');
    await access(await options.principal(c), c.req.param('id'));
    return c.json({ configured: await satisfactoryApiConfigured(options.db, c.req.param('id')) });
  });
  app.put(`${base}/token`, async (c) => {
    const context = await options.principal(c),
      id = c.req.param('id'),
      codec = await access(context, id, true);
    const input = z
      .strictObject({ token: z.string().min(1).max(8192) })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new DomainError('validation_failed');
    await setSatisfactoryApiToken(options.db, codec, context, id, input.data.token);
    return c.body(null, 204);
  });
  app.get(`${base}/state`, async (c) => {
    c.header('cache-control', 'no-store');
    const codec = await access(await options.principal(c), c.req.param('id'));
    return c.json(
      await (await resolveSatisfactoryApi(options.db, codec, c.req.param('id'))).state(
        c.req.raw.signal,
      ),
    );
  });
  app.get(`${base}/options`, async (c) => {
    c.header('cache-control', 'no-store');
    const codec = await access(await options.principal(c), c.req.param('id'));
    return c.json(
      await (await resolveSatisfactoryApi(options.db, codec, c.req.param('id'))).options(
        c.req.raw.signal,
      ),
    );
  });
  app.put(`${base}/options`, async (c) => {
    const context = await options.principal(c),
      id = c.req.param('id'),
      codec = await access(context, id, true);
    const input = z
      .strictObject({ options: z.record(z.string(), z.string()) })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new DomainError('validation_failed');
    await applySatisfactoryOptions(options.db, codec, context, id, input.data.options);
    return c.body(null, 204);
  });
}
