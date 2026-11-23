import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import type { BlankSchema } from 'hono/types';
import { openworldMapDebugBatch } from '../../../games/openworld/src/map-debug.js';
import {
  openworldProcessRef,
  readOpenworldScope,
} from '../../../packages/server-management/src/openworld-telemetry.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerOpenworldMapDebug(
  routes: Hono<{ Variables: Variables }, BlankSchema, '/v1/servers/:id/openworld'>,
  options: Pick<ServerRouteOptions, 'db' | 'principal' | 'logger'>,
) {
  // A burst permits opening the recorder or changing face mid-batch. Cap the total number of
  // accepted reports as well, which also bounds the number of reader entries per API process.
  const readers = new Map<string, number>();
  let windowEnd = 0;
  let total = 0;
  routes.post('/map/debug-telemetry', async (c) => {
    const who = await options.principal(c);
    const now = Date.now();
    if (now >= windowEnd) {
      windowEnd = now + 60_000;
      readers.clear();
      total = 0;
    }
    const used = readers.get(who.actorUserId) ?? 0;
    if (used >= 20 || total >= 240) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((windowEnd - now) / 1000))));
      throw new DomainError('rate_limited');
    }
    readers.set(who.actorUserId, used + 1);
    total++;
    const scope = await readOpenworldScope(options.db, c.req.param('id'), { who, resource: 'map' });
    if (scope.reason) throw new DomainError('game_not_ready');
    if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json'))
      throw new DomainError('validation_failed');
    const parsed = openworldMapDebugBatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new DomainError('validation_failed');
    const { traceId, batch, processRef, world, face, samples } = parsed.data;
    if (processRef !== openworldProcessRef(scope)) throw new DomainError('conflict');
    if (!options.logger?.isEnabled('info')) return c.json({ recorded: false });
    options.logger.log('info', 'openworld.map.renderer', {
      serverId: scope.serverId,
      traceId,
      batch,
      worldHash: createHash('sha256').update(world).digest('hex').slice(0, 12),
      face,
      samples,
    });
    return c.body(null, 204);
  });
}
