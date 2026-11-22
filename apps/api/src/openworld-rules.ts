import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import { openworldRuleActionSchema } from '../../../games/openworld/src/rules.js';
import type { createOpenworldRules } from '../../../packages/server-management/src/openworld-rules.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

const change = z.strictObject({
  requestId: z.uuid(),
  processRef: z.string().regex(/^[a-f0-9]{64}$/),
  action: openworldRuleActionSchema,
});

export function registerOpenworldRulesRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal'>,
  service: ReturnType<typeof createOpenworldRules>,
) {
  const path = '/v1/servers/:id/openworld/rules';
  app.get(path, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(await service.list(await options.principal(c), c.req.param('id')));
  });
  app.post(path, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const who = await options.principal(c);
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      throw new DomainError('validation_failed');
    const parsed = change.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) throw new DomainError('validation_failed');
    return c.json(await service.change(who, c.req.param('id'), parsed.data));
  });
}
