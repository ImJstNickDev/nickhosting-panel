import { DomainError } from '@nickhosting/core';
import { getServerGatewayMessages, setServerGatewayMessages } from '@nickhosting/server-management';
import type { Hono } from 'hono';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';
export function registerGatewayMessageRoutes(
  app: Hono<{ Variables: Variables }>,
  { db, env, principal }: Omit<ServerRouteOptions, 'acquireUploadSlot'>,
) {
  app.get('/v1/servers/:id/gateway-messages', async (c) =>
    c.json(await getServerGatewayMessages(db, await principal(c), c.req.param('id'), env)),
  );
  app.put('/v1/servers/:id/gateway-messages', async (c) => {
    const context = await principal(c, true);
    if (!c.req.header('content-type')?.startsWith('application/json'))
      throw new DomainError('validation_failed');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new DomainError('validation_failed');
    }
    return c.json(await setServerGatewayMessages(db, context, c.req.param('id'), body, env));
  });
}
