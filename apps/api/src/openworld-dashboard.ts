import { DomainError } from '@nickhosting/core';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  readOpenworldDashboard,
  readOpenworldDashboardStatus,
  updateOpenworldDashboard,
} from '../../../packages/server-management/src/openworld-dashboard.js';
import {
  type OpenworldNativeConnection,
  openworldRetryAfterMs,
} from '../../../packages/server-management/src/openworld-telemetry.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerOpenworldDashboardRoutes(
  app: Hono<{ Variables: Variables }>,
  { db, principal }: Pick<ServerRouteOptions, 'db' | 'principal'>,
  native: OpenworldNativeConnection,
) {
  const base = '/v1/servers/:id/openworld/dashboard';
  app.use(`${base}*`, async (c, next) => {
    c.header('cache-control', 'no-store');
    await next();
  });
  app.get(base, async (c) => {
    const who = await principal(c);
    return c.json(await readOpenworldDashboard(db, who, c.req.param('id')));
  });
  app.put(base, async (c) => {
    const who = await principal(c, true);
    const values = z
      .strictObject({ enabled: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!values.success) throw new DomainError('validation_failed');
    return c.json(await updateOpenworldDashboard(db, who, c.req.param('id'), values.data.enabled));
  });
  app.get(`${base}/status`, async (c) => {
    const who = await principal(c);
    try {
      return c.json(
        await readOpenworldDashboardStatus(db, native, who, c.req.param('id'), c.req.raw.signal),
      );
    } catch (error) {
      if (!(error instanceof PterodactylError) || error.reason !== 'rate_limited') throw error;
      c.header('Retry-After', String(Math.max(1, Math.ceil(openworldRetryAfterMs(error) / 1000))));
      throw new DomainError('rate_limited');
    }
  });
}
