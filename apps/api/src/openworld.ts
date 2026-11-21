import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import {
  listOpenworldReleases,
  openworldReleaseCatalog,
} from '../../../packages/server-management/src/openworld-catalog.js';
import { openworldCreationChoices } from '../../../packages/server-management/src/openworld-module.js';
import { ownerOnly } from '../../../packages/server-management/src/registry.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerOpenworldRoutes(
  app: Hono<{ Variables: Variables }>,
  { db, codec, env, principal }: Pick<ServerRouteOptions, 'db' | 'env' | 'codec' | 'principal'>,
) {
  const versions = '/v1/owner/integrations/openworld/versions';
  app.get(versions, async (c) => {
    ownerOnly(await principal(c, true));
    if (!codec) throw new DomainError('integration_unavailable');
    return c.json(await openworldReleaseCatalog(db, codec, env, 'owner'));
  });
  app.post(`${versions}/sync`, async (c) => {
    ownerOnly(await principal(c, true));
    if (!codec) throw new DomainError('integration_unavailable');
    return c.json(await openworldReleaseCatalog(db, codec, env, 'sync'));
  });
  app.get('/v1/games/openworld/choices', async (c) => {
    const mappings = await openworldCreationChoices(db, await principal(c), env);
    if (!codec) throw new DomainError('integration_unavailable');
    const releases = mappings.length ? await listOpenworldReleases(db, codec, env) : [];
    return c.json({ mappings, versions: releases.map(({ version }) => version) });
  });
}
