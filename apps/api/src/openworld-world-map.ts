import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  openworldCheckpointActionSchema,
  openworldMapWorldKey,
} from '../../../games/openworld/src/world-map.js';
import { resolveOpenworldDashboardTarget } from '../../../packages/server-management/src/openworld-dashboard.js';
import { createOpenworldWorldMap } from '../../../packages/server-management/src/openworld-world-map.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

const integer = (max: number) =>
  z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .pipe(z.int().min(0).max(max));
const processRef = z.string().regex(/^[a-f0-9]{64}$/);
const session = z.strictObject({ processRef });
const world = openworldMapWorldKey;
const selected = session.extend({ world });
const face = integer(5);
const stamp = integer(0xffffffff);
const column = integer(131071);
const aligned = column.refine((i) => i % 8 === 0);
const extent = column.optional();
const columns = selected
  .extend({
    face,
    stamp: stamp.optional(),
    i0: extent,
    i1: extent,
    j0: extent,
    j1: extent,
    stride: integer(8192)
      .refine((n) => n > 0 && (n & (n - 1)) === 0)
      .optional()
      .default(1),
  })
  .transform(({ i0, i1, j0, j1, ...q }, ctx) => {
    if (i0 === undefined && i1 === undefined && j0 === undefined && j1 === undefined) return q;
    if (
      i0 === undefined ||
      i1 === undefined ||
      j0 === undefined ||
      j1 === undefined ||
      i1 < i0 ||
      j1 < j0
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid viewport' });
      return z.NEVER;
    }
    return { ...q, bounds: { i0, i1, j0, j1 } };
  });
const surface = selected.extend({ face, ci: aligned, cj: aligned, stamp: stamp.optional() });
const changes = selected.extend({ since: stamp });
const change = selected.extend({ requestId: z.uuid(), action: openworldCheckpointActionSchema });
function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const data = schema.safeParse(value);
  if (!data.success) throw new DomainError('validation_failed');
  return data.data;
}

export function registerOpenworldWorldMapRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal'> &
    Partial<Pick<ServerRouteOptions, 'management'>>,
  service = createOpenworldWorldMap({
    db: options.db,
    target: async (id) => {
      if (!options.management) throw new DomainError('integration_unavailable');
      return resolveOpenworldDashboardTarget(options.db, (await options.management()).adapter, id);
    },
  }),
) {
  const base = '/v1/servers/:id/openworld/map';
  app.use(`${base}/*`, async (c, next) => {
    c.header('cache-control', 'private, no-store');
    await next();
  });
  app.get(base, async (c) =>
    c.json(await service.info(await options.principal(c), c.req.param('id'))),
  );
  app.get(`${base}/players`, async (c) =>
    c.json(
      await service.players(
        await options.principal(c),
        c.req.param('id'),
        parse(session, c.req.query()).processRef,
      ),
    ),
  );
  app.get(`${base}/index`, async (c) =>
    c.json(
      await service.index(
        await options.principal(c),
        c.req.param('id'),
        parse(selected, c.req.query()),
      ),
    ),
  );
  app.get(`${base}/columns`, async (c) =>
    c.json(
      await service.columns(
        await options.principal(c),
        c.req.param('id'),
        parse(columns, c.req.query()),
      ),
    ),
  );
  app.get(`${base}/changes`, async (c) =>
    c.json(
      await service.changes(
        await options.principal(c),
        c.req.param('id'),
        parse(changes, c.req.query()),
      ),
    ),
  );
  app.get(`${base}/surface`, async (c) =>
    c.json(
      await service.surface(
        await options.principal(c),
        c.req.param('id'),
        parse(surface, c.req.query()),
      ),
    ),
  );
  app.get(`${base}/checkpoints`, async (c) =>
    c.json(
      await service.checkpoints(
        await options.principal(c),
        c.req.param('id'),
        parse(selected, c.req.query()),
      ),
    ),
  );
  app.post(`${base}/checkpoints`, async (c) => {
    const who = await options.principal(c);
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      throw new DomainError('validation_failed');
    const input = parse(change, await c.req.json().catch(() => undefined));
    return c.json(await service.changeCheckpoint(who, c.req.param('id'), input), 202);
  });
}
