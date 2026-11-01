import { DomainError } from '@nickhosting/core';
import { gameCatalog, registerGame } from '@nickhosting/database';
import { ownerOnly } from '@nickhosting/server-management';
import type { Hono } from 'hono';
import { z } from 'zod';
import { satisfactoryManifest } from '../../../games/satisfactory/src/index.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerSatisfactoryRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal'>,
) {
  app.get('/v1/games/satisfactory/choices', async (c) => {
    const context = await options.principal(c);
    const game = (await gameCatalog(options.db, context)).find(
      (entry) => entry.id === 'satisfactory',
    );
    if (!game?.access.canCreate) throw new DomainError('forbidden');
    const mappings = await options.db
      .selectFrom('runtime_egg_mappings')
      .select(['id', 'runtime_id'])
      .where('game_id', '=', 'satisfactory')
      .where('enabled', '=', true)
      .execute();
    return c.json({
      choices: mappings.map((row) => ({ mappingId: row.id, name: row.runtime_id })),
    });
  });
  app.get('/v1/owner/satisfactory/manifest', async (c) => {
    ownerOnly(await options.principal(c, true));
    return c.json(satisfactoryManifest);
  });
  app.post('/v1/owner/satisfactory/register', async (c) => {
    const context = await options.principal(c, true);
    ownerOnly(context);
    const parsed = z
      .strictObject({
        state: z.enum(['development', 'private-testing', 'public', 'disabled-for-new-servers']),
        allowedUserIds: z.array(z.string().min(1)).max(10000).default([]),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new DomainError('validation_failed');
    await registerGame(options.db, context, satisfactoryManifest, {
      gameId: 'satisfactory',
      ...parsed.data,
    });
    return c.body(null, 204);
  });
}
