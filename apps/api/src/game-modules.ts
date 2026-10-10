import type { AuthContext } from '@nickhosting/core';
import { gameCatalog } from '@nickhosting/database';
import { ownerOnly } from '@nickhosting/server-management';
import type { Hono } from 'hono';
import { trustedGameModules } from '../../../packages/server-management/src/game-modules.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

/** Catalog policy uses the same compiled first-party registry as worker hooks.
 * Stored runtime/capability declarations do not establish compatibility. */
export async function availableGameCatalog(
  db: ServerRouteOptions['db'],
  context: AuthContext,
  env: Readonly<Record<string, string | undefined>> = {},
) {
  return trustedGameModules.catalog(db, context, await gameCatalog(db, context), env);
}
export function registerGameModuleRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'principal'>,
) {
  app.get('/v1/owner/game-modules', async (c) => {
    ownerOnly(await options.principal(c, true));
    return c.json(
      trustedGameModules.list().map((module) => ({ id: module.id, manifest: module.manifest })),
    );
  });
}
