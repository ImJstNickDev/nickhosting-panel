import { type AuthContext, DomainError } from '@nickhosting/core';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import type { Hono } from 'hono';
import {
  type OpenworldSeed,
  readOpenworldSeed,
} from '../../../games/openworld/src/seed-inspector.js';
import { resolveOpenworldDashboardTarget } from '../../../packages/server-management/src/openworld-dashboard.js';
import {
  assertCurrentOpenworldScope,
  createOpenworldNativeConnection,
  type OpenworldNativeOptions,
  readOpenworldScope,
  sharedReads,
} from '../../../packages/server-management/src/openworld-telemetry.js';
import type { Variables } from './app.js';
import { publishedInspectorLink } from './openworld-dashboard-sso.js';
import type { ServerRouteOptions } from './servers.js';

export function createOpenworldInspector(options: OpenworldNativeOptions) {
  const { db, fetcher = fetch, now = Date.now } = options;
  const native = createOpenworldNativeConnection(options);
  const samples = sharedReads<OpenworldSeed>(32, now, 1000);
  return async (who: AuthContext, id: string) => {
    const reader = { who, resource: 'seed' as const };
    const scope = await readOpenworldScope(db, id, reader);
    if (scope.reason) throw new DomainError('game_not_ready');
    const data = await samples.get(scope.liveKey, 30000, () =>
      native(scope, (origin, _token, signal) => readOpenworldSeed(origin, signal, fetcher)),
    );
    const link = await publishedInspectorLink(db, who, id);
    assertCurrentOpenworldScope(scope, await readOpenworldScope(db, id, reader));
    return { ...data, ...link };
  };
}

export function registerOpenworldInspectorRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal'> &
    Partial<Pick<ServerRouteOptions, 'management'>>,
  read = createOpenworldInspector({
    db: options.db,
    target: async (id) => {
      if (!options.management) throw new DomainError('integration_unavailable');
      return resolveOpenworldDashboardTarget(options.db, (await options.management()).adapter, id);
    },
  }),
) {
  app.get('/v1/servers/:id/openworld/seed', async (c) => {
    c.header('cache-control', 'private, no-store');
    const who = await options.principal(c);
    try {
      return c.json(await read(who, c.req.param('id')));
    } catch (e) {
      if (e instanceof PterodactylError && e.reason === 'rate_limited') {
        c.header('Retry-After', String(Math.ceil((e.retryAfterMs ?? 60000) / 1000)));
        throw new DomainError('rate_limited');
      }
      throw e;
    }
  });
}
