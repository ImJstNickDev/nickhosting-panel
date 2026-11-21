import { DomainError } from '@nickhosting/core';
import { type PterodactylAdapter, PterodactylError } from '@nickhosting/pterodactyl-adapter';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  readOpenworldDashboard,
  readOpenworldDashboardStatus,
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
  async function withProvider<T>(
    c: Context<{ Variables: Variables }>,
    work: (adapter: PterodactylAdapter) => Promise<T>,
  ) {
    if (!management) throw new DomainError('integration_unavailable');
    try {
      return await work((await management()).adapter);
    } catch (error) {
      if (!(error instanceof PterodactylError) || error.reason !== 'rate_limited') throw error;
      c.header('Retry-After', String(Math.ceil((error.retryAfterMs ?? 60_000) / 1000)));
      throw new DomainError('rate_limited');
    }
  }
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
    return c.json(
      await withProvider(c, (adapter) =>
        readOpenworldDashboardStatus(db, adapter, who, c.req.param('id'), c.req.raw.signal),
      ),
    );
  });
}
