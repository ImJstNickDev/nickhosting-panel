import { DomainError } from '@nickhosting/core';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  maxOpenworldMapColumn,
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
const creatureQuery = selected.extend({ markers: z.literal('1').optional() });
const face = integer(5);
const stamp = integer(0xffffffff);
const column = integer(maxOpenworldMapColumn);
const aligned = column.refine((i) => i % 8 === 0);
const extent = column.optional();
const columns = selected
  .extend({
    face,
    stamp: stamp.optional(),
    sample: z.literal('1').optional(),
    i0: extent,
    i1: extent,
    j0: extent,
    j1: extent,
    stride: integer(maxOpenworldMapColumn + 1)
      .refine((n) => n > 0 && Number.isInteger(Math.log2(n)))
      .optional()
      .default(1),
  })
  .transform(({ i0, i1, j0, j1, ...q }, ctx) => {
    if (q.sample && (q.stride !== 1 || [i0, i1, j0, j1].some((v) => v !== undefined))) {
      ctx.addIssue({ code: 'custom', message: 'Sample requires a full face' });
      return z.NEVER;
    }
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
  const base = '/v1/servers/:id/openworld';
  const routes = new Hono<{ Variables: Variables }>().basePath(base);

  // Coalesced requests receive the same rejected provider read throughout its cooldown.
  const retryUntil = new WeakMap<PterodactylError, number>();
  routes.onError((error, c) => {
    if (!(error instanceof PterodactylError) || error.reason !== 'rate_limited') throw error;
    const now = Date.now();
    const until = retryUntil.get(error) ?? now + (error.retryAfterMs ?? 60_000);
    retryUntil.set(error, until);
    c.header('Retry-After', String(Math.max(1, Math.ceil((until - now) / 1000))));
    throw new DomainError('rate_limited');
  });
  routes.use('/map/*', async (c, next) => {
    c.header('cache-control', 'private, no-store');
    await next();
  });
  routes.get('/factories', async (c) => {
    c.header('cache-control', 'private, no-store');
    return c.json(await service.factories(await options.principal(c), c.req.param('id')));
  });
  routes.get('/map/creatures', async (c) => {
    const who = await options.principal(c);
    const q = parse(creatureQuery, c.req.query());
    return c.json(await service.creatures(who, c.req.param('id'), q, q.markers === '1'));
  });
  routes.get('/map/space', async (c) =>
    c.json(
      await service.space(
        await options.principal(c),
        c.req.param('id'),
        parse(session, c.req.query()).processRef,
      ),
    ),
  );
  routes.get('/map', async (c) =>
    c.json(await service.info(await options.principal(c), c.req.param('id'))),
  );
  routes.get('/map/players', async (c) =>
    c.json(
      await service.players(
        await options.principal(c),
        c.req.param('id'),
        parse(session, c.req.query()).processRef,
      ),
    ),
  );
  routes.get('/map/index', async (c) =>
    c.json(
      await service.index(
        await options.principal(c),
        c.req.param('id'),
        parse(selected, c.req.query()),
      ),
    ),
  );
  routes.get('/map/columns', async (c) =>
    c.json(
      await service.columns(
        await options.principal(c),
        c.req.param('id'),
        parse(columns, c.req.query()),
      ),
    ),
  );
  routes.get('/map/changes', async (c) =>
    c.json(
      await service.changes(
        await options.principal(c),
        c.req.param('id'),
        parse(changes, c.req.query()),
      ),
    ),
  );
  routes.get('/map/surface', async (c) =>
    c.json(
      await service.surface(
        await options.principal(c),
        c.req.param('id'),
        parse(surface, c.req.query()),
      ),
    ),
  );
  routes.get('/map/checkpoints', async (c) =>
    c.json(
      await service.checkpoints(
        await options.principal(c),
        c.req.param('id'),
        parse(selected, c.req.query()),
      ),
    ),
  );
  routes.post('/map/checkpoints', async (c) => {
    const who = await options.principal(c);
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      throw new DomainError('validation_failed');
    const input = parse(change, await c.req.json().catch(() => undefined));
    return c.json(await service.changeCheckpoint(who, c.req.param('id'), input), 202);
  });
  app.route('/', routes);
}
