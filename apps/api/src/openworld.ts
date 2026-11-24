import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import {
  listOpenworldReleases,
  openworldReleaseCatalog,
} from '../../../packages/server-management/src/openworld-catalog.js';
import {
  openworldGatewayEvidence,
  openworldReleasesWithFailures,
  recordOpenworldReleaseCheck,
} from '../../../packages/server-management/src/openworld-release-checks.js';
import {
  openworldNoticeSchema,
  openworldUpdateSettings,
  setOpenworldUpdateNotice,
} from '../../../packages/server-management/src/openworld-update-settings.js';
import { ownerOnly, parse } from '../../../packages/server-management/src/registry.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerOpenworldRoutes(
  app: Hono<{ Variables: Variables }>,
  { db, codec, env, principal }: Pick<ServerRouteOptions, 'db' | 'env' | 'codec' | 'principal'>,
) {
  const versions = '/v1/owner/integrations/openworld/versions';
  const settings = '/v1/owner/integrations/openworld/update-settings';
  async function catalog(mode: 'owner' | 'sync') {
    if (!codec) throw new DomainError('integration_unavailable');
    const result = await openworldReleaseCatalog(db, codec, env, mode);
    return { ...result, releases: await openworldReleasesWithFailures(db, result.releases) };
  }
  app.get(versions, async (c) => {
    ownerOnly(await principal(c, true));
    return c.json(await catalog('owner'));
  });
  app.post(`${versions}/sync`, async (c) => {
    ownerOnly(await principal(c, true));
    return c.json(await catalog('sync'));
  });
  app.post(`${versions}/:version/gateway-check`, async (c) => {
    const who = await principal(c, true);
    ownerOnly(who);
    const evidence = parse(openworldGatewayEvidence, await c.req.json().catch(() => null));
    if (!codec) throw new DomainError('integration_unavailable');
    const catalog = await openworldReleaseCatalog(db, codec, env, 'owner');
    const release = catalog.releases.find(({ version }) => version === c.req.param('version'));
    if (!release) throw new DomainError('not_found');
    return c.json(await recordOpenworldReleaseCheck(db, who, release, evidence));
  });
  app.get(settings, async (c) => {
    ownerOnly(await principal(c, true));
    return c.json(await openworldUpdateSettings(db, env));
  });
  app.put(settings, async (c) => {
    const who = await principal(c, true);
    ownerOnly(who);
    const input = parse(openworldNoticeSchema, await c.req.json().catch(() => null));
    return c.json(await setOpenworldUpdateNotice(db, who, env, input.noticeSeconds));
  });
  app.get('/v1/games/openworld/choices', async (c) => {
    const who = await principal(c);
    const { openworldCreationChoices } = await import(
      '../../../packages/server-management/src/openworld-module.js'
    );
    const mappings = await openworldCreationChoices(db, who, env);
    if (!codec) throw new DomainError('integration_unavailable');
    const releases = mappings.length ? await listOpenworldReleases(db, codec, env) : [];
    return c.json({ mappings, versions: releases.map(({ version }) => version) });
  });
}
