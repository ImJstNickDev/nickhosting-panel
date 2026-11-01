import { DomainError } from '@nickhosting/core';
import { authorizeServer } from '@nickhosting/server-management';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  beginSatisfactoryExternalEdit,
  finishSatisfactoryExternalEdit,
} from '../../../packages/server-management/src/satisfactory-mod-external.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerSatisfactoryModExternalRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal' | 'env' | 'management'>,
) {
  const base = '/v1/servers/:id/satisfactory/mods/external';
  app.post(`${base}/begin`, async (c) => {
    const input = z
      .strictObject({
        revision: z.number().int().nonnegative(),
        idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new DomainError('validation_failed');
    const actor = await options.principal(c),
      id = c.req.param('id');
    await authorizeServer(options.db, actor, id, 'server:manage');
    const service = await options.management();
    await service.externalOptions.verifyServer(options.db, id);
    return c.json(
      await beginSatisfactoryExternalEdit(options.db, actor, id, input.data, options.env),
    );
  });
  app.post(`${base}/finish`, async (c) => {
    const input = z
      .strictObject({
        revision: z.number().int().nonnegative(),
        inventoryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new DomainError('validation_failed');
    const actor = await options.principal(c),
      id = c.req.param('id');
    await authorizeServer(options.db, actor, id, 'server:manage');
    const service = await options.management();
    await service.externalOptions.verifyServer(options.db, id);
    if (!(await service.lifecycle.confirmInitialInstallationStopped(id, options.db)))
      throw new DomainError('operation_uncertain');
    return c.json(
      await finishSatisfactoryExternalEdit(
        options.db,
        service.adapter,
        actor,
        id,
        input.data,
        options.env,
      ),
    );
  });
}
