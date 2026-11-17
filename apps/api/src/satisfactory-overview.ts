import { DomainError } from '@nickhosting/core';
import { authorizeServer } from '@nickhosting/server-management';
import type { Hono } from 'hono';
import { satisfactoryGameStateSchema } from '../../../games/satisfactory/src/api.js';
import { readOfflineSnapshots } from '../../../games/satisfactory/src/offline-snapshots.js';
import {
  resolveSatisfactoryApi,
  satisfactoryApiConfigured,
} from '../../../packages/server-management/src/satisfactory-api.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerSatisfactoryOverviewRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'codec' | 'principal'>,
) {
  app.get('/v1/servers/:id/satisfactory/api/overview', async (c) => {
    c.header('cache-control', 'no-store');
    const id = c.req.param('id');
    const server = await authorizeServer(options.db, await options.principal(c), id, 'server:read');
    const mapping = await options.db
      .selectFrom('runtime_egg_mappings')
      .select('game_id')
      .where('id', '=', server.mapping_id)
      .executeTakeFirst();
    if (mapping?.game_id !== 'satisfactory') throw new DomainError('not_found');
    const codec = options.codec;
    if (!codec) throw new DomainError('configuration_invalid');
    const configured = await satisfactoryApiConfigured(options.db, id);
    if (configured && server.runtime_state === 'running') {
      const state = await (await resolveSatisfactoryApi(options.db, codec, id)).state(
        c.req.raw.signal,
      );
      return c.json({ configured, state, observedAt: new Date().toISOString(), source: 'live' });
    }
    const name = `gateway.satisfactory.observations.${id}`;
    const stored = await options.db
      .selectFrom('encrypted_secrets')
      .select('envelope')
      .where('name', '=', name)
      .executeTakeFirst();
    const observation = readOfflineSnapshots(
      stored ? JSON.parse(codec.decrypt(stored.envelope, name)) : {},
    ).QueryServerState;
    const data = observation?.body.data as { serverGameState?: unknown } | undefined;
    const parsed = satisfactoryGameStateSchema.safeParse(data?.serverGameState);
    const valid =
      observation &&
      observation.observedAt >= 0 &&
      observation.observedAt <= Date.now() + 5000 &&
      parsed.success;
    return c.json({
      configured,
      state: valid ? parsed.data : null,
      observedAt: valid ? new Date(observation.observedAt).toISOString() : null,
      source: valid ? 'snapshot' : 'unavailable',
    });
  });
}
