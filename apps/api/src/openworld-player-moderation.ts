import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import { moderationRequest } from '../../../games/openworld/src/player-moderation.js';
import { resolveOpenworldDashboardTarget } from '../../../packages/server-management/src/openworld-dashboard.js';
import { createOpenworldPlayerModeration } from '../../../packages/server-management/src/openworld-player-moderation.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerOpenworldPlayerModerationRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal'> &
    Partial<Pick<ServerRouteOptions, 'management'>>,
  service = createOpenworldPlayerModeration({
    db: options.db,
    target: async (id) => {
      if (!options.management) throw new DomainError('integration_unavailable');
      return resolveOpenworldDashboardTarget(options.db, (await options.management()).adapter, id);
    },
    withFiles: async (who, id, grant, signal, work) => {
      if (!options.management) throw new DomainError('integration_unavailable');
      return (await options.management()).fileReadScope(
        who,
        id,
        work,
        signal,
        `game.openworld.${grant === 'ban.create' ? 'bans.manage' : grant}`,
      );
    },
  }),
) {
  const base = '/v1/servers/:id/openworld/players/moderation';
  app.get(`${base}/bans`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(await service.bans(await options.principal(c), c.req.param('id')));
  });
  for (const resource of ['roles', 'zones'] as const)
    app.get(`${base}/${resource}/:account`, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const account = z.uuid().safeParse(c.req.param('account'));
      if (!account.success) throw new DomainError('validation_failed');
      return c.json(
        await service[resource](
          await options.principal(c),
          c.req.param('id'),
          account.data.toLowerCase(),
        ),
      );
    });
  app.post(base, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const who = await options.principal(c);
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      throw new DomainError('validation_failed');
    const request = moderationRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!request.success) throw new DomainError('validation_failed');
    return c.json(await service.change(who, c.req.param('id'), request.data));
  });
}
