import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  openworldScreenshot,
  openworldScreenshots,
  screenshotName,
  screenshotRevision,
  screenshotRevisionExists,
} from '../../../games/openworld/src/screenshots.js';
import { attributedOpenworldScreenshots } from '../../../packages/server-management/src/openworld-capture-index.js';
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
    const account = z.uuid().optional().safeParse(c.req.query('account'));
    if (!account.success) throw new DomainError('validation_failed');
    const filter = account.data?.toLowerCase();
    return c.json(
      await channel.read(
        who,
        c.req.param('id'),
        'screenshots',
        async (origin, token, signal, scope) => {
          const { files } = await openworldScreenshots(origin, token, signal, fetcher);
          if (!scope.canInspectPlayers) return { files };
          return attributedOpenworldScreenshots(
            options.db,
            scope.serverId,
            scope.binding,
            files,
            filter,
          );
        },
        filter ? 'required' : 'include',
      ),
    );
  });
  let activeImages = 0;
  app.get(`${base}/image`, async (c) => {
    c.header('cache-control', 'private, no-store');
    const who = await options.principal(c);
    const name = screenshotName.safeParse(c.req.query('name'));
    if (!name.success) throw new DomainError('validation_failed');
    const params = c.req.query();
    const revision =
      params.bytes !== undefined || params.mtimeMs !== undefined
        ? screenshotRevision.safeParse(params)
        : undefined;
    if (revision && !revision.success) throw new DomainError('validation_failed');
    const image = await channel.read(
      who,
      c.req.param('id'),
      'screenshots',
      async (origin, token, signal) => {
        if (activeImages >= 8) throw new DomainError('rate_limited');
        activeImages++;
        try {
          const bytes = await openworldScreenshot(origin, token, signal, name.data, fetcher);
          if (revision?.success) {
            if (bytes.byteLength !== revision.data.bytes) throw new DomainError('not_found');
            const index = await openworldScreenshots(origin, token, signal, fetcher);
            if (!screenshotRevisionExists(index.files, revision.data))
              throw new DomainError('not_found');
          }
          return bytes;
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
