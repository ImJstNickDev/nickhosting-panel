import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import {
  openworldScreenshot,
  openworldScreenshots,
  screenshotName,
} from '../../../games/openworld/src/screenshots.js';
import { resolveOpenworldDashboardTarget } from '../../../packages/server-management/src/openworld-dashboard.js';
import { createOpenworldPlayerChannel } from '../../../packages/server-management/src/openworld-player-channel.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerOpenworldScreenshotRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal'> &
    Partial<Pick<ServerRouteOptions, 'management'>>,
  channel = createOpenworldPlayerChannel({
    db: options.db,
    target: async (id) => {
      if (!options.management) throw new DomainError('integration_unavailable');
      return resolveOpenworldDashboardTarget(options.db, (await options.management()).adapter, id);
    },
  }),
  fetcher = fetch,
) {
  const base = '/v1/servers/:id/openworld/screenshots';
  app.get(base, async (c) => {
    c.header('cache-control', 'private, no-store');
    const who = await options.principal(c);
    return c.json(
      await channel.read(who, c.req.param('id'), 'screenshots', (origin, token, signal) =>
        openworldScreenshots(origin, token, signal, fetcher),
      ),
    );
  });
  let activeImages = 0;
  app.get(`${base}/image`, async (c) => {
    c.header('cache-control', 'private, no-store');
    const who = await options.principal(c);
    const name = screenshotName.safeParse(c.req.query('name'));
    if (!name.success) throw new DomainError('validation_failed');
    const image = await channel.read(
      who,
      c.req.param('id'),
      'screenshots',
      async (origin, token, signal) => {
        if (activeImages >= 8) throw new DomainError('rate_limited');
        activeImages++;
        try {
          return await openworldScreenshot(origin, token, signal, name.data, fetcher);
        } finally {
          activeImages--;
        }
      },
    );
    c.header('content-type', 'image/png');
    c.header('x-content-type-options', 'nosniff');
    c.header('content-security-policy', "default-src 'none'; sandbox");
    return c.body(image);
  });
}
