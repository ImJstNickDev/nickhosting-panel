import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  readOpenworldDashboard,
  readOpenworldDashboardStatus,
  revealOpenworldDashboardPassword,
  updateOpenworldDashboard,
} from '../../../packages/server-management/src/openworld-dashboard.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerOpenworldDashboardRoutes(
  app: Hono<{ Variables: Variables }>,
  {
    db,
    principal,
    management,
  }: Pick<ServerRouteOptions, 'db' | 'principal'> & Partial<Pick<ServerRouteOptions, 'management'>>,
) {
  const base = '/v1/servers/:id/openworld/dashboard';
  async function adapter() {
    if (!management) throw new DomainError('integration_unavailable');
    return (await management()).adapter;
  }
  app.use(`${base}*`, async (c, next) => {
    c.header('cache-control', 'no-store');
    await next();
  });
  app.get(base, async (c) => {
    const who = await principal(c);
    return c.json(await readOpenworldDashboard(db, await adapter(), who, c.req.param('id')));
  });
  app.put(base, async (c) => {
    const who = await principal(c, true);
    const values = z
      .strictObject({ enabled: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!values.success) throw new DomainError('validation_failed');
    await updateOpenworldDashboard(
      db,
      await adapter(),
      who,
      c.req.param('id'),
      values.data.enabled,
    );
    return c.body(null, 204);
  });
  app.post(`${base}/password`, async (c) => {
    const who = await principal(c, true);
    return c.json(
      await revealOpenworldDashboardPassword(db, await adapter(), who, c.req.param('id')),
    );
  });
  app.get(`${base}/status`, async (c) => {
    const who = await principal(c);
    return c.json(
      await readOpenworldDashboardStatus(
        db,
        await adapter(),
        who,
        c.req.param('id'),
        c.req.raw.signal,
      ),
    );
  });
}
