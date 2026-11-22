import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { createOpenworldTelemetry } from '../../../packages/server-management/src/openworld-telemetry.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

const playerQuery = z.object({
  id: z
    .string()
    .regex(/^\d{1,10}$/)
    .transform(Number)
    .pipe(z.number().max(0xffffffff)),
  name: z.string().min(1).max(256),
  joinedAt: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .optional(),
});

export function registerOpenworldTelemetryRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal'>,
  service: ReturnType<typeof createOpenworldTelemetry>,
) {
  const base = '/v1/servers/:id/openworld/telemetry';
  app.use(`${base}/*`, async (c, next) => {
    c.header('cache-control', 'private, no-store');
    await next();
  });
  for (const resource of ['players', 'status', 'history', 'chunks', 'storage'] as const)
    app.get(`${base}/${resource}`, async (c) =>
      c.json(await service.read(await options.principal(c), c.req.param('id'), resource)),
    );
  app.get(`${base}/players/:playerId`, async (c) => {
    const selection = playerQuery.safeParse({
      id: c.req.param('playerId'),
      name: c.req.query('name'),
      joinedAt: c.req.query('joinedAt'),
    });
    if (!selection.success) throw new DomainError('validation_failed');
    return c.json(
      await service.read(await options.principal(c), c.req.param('id'), 'player', selection.data),
    );
  });
  app.get(`${base}/players/:playerId/skin`, async (c) => {
    const selection = playerQuery.safeParse({
      id: c.req.param('playerId'),
      name: c.req.query('name'),
      joinedAt: c.req.query('joinedAt'),
    });
    const hash = c.req.query('h');
    const view = c.req.query('view') ?? 'head';
    if (
      !selection.success ||
      !hash ||
      !/^[a-f0-9]{8}$/i.test(hash) ||
      !['head', 'body'].includes(view)
    )
      throw new DomainError('validation_failed');
    const png = await service.skin(
      await options.principal(c),
      c.req.param('id'),
      selection.data,
      view as 'head' | 'body',
      hash.toLowerCase(),
    );
    c.header('content-type', 'image/png');
    c.header('x-content-type-options', 'nosniff');
    return c.body(png);
  });
}
