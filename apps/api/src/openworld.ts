import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import { listOpenworldReleases } from '../../../packages/server-management/src/openworld-catalog.js';
import { openworldCreationChoices } from '../../../packages/server-management/src/openworld-module.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerOpenworldRoutes(
  app: Hono<{ Variables: Variables }>,
  { db, codec, env, principal }: Pick<ServerRouteOptions, 'db' | 'env' | 'codec' | 'principal'>,
) {
  app.get('/v1/games/openworld/choices', async (c) => {
    const mappings = await openworldCreationChoices(db, await principal(c), env);
    if (!codec) throw new DomainError('integration_unavailable');
    const releases = mappings.length ? await listOpenworldReleases(db, codec, env) : [];
    return c.json({ mappings, versions: releases.map(({ version }) => version) });
  });
}
