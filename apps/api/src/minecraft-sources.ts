import { type AuthContext, DomainError } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import type { Context, Hono } from 'hono';
import { createMinecraftSourceStore } from '../../../packages/server-management/src/minecraft-sources.js';
import type { Variables } from './app.js';

export interface MinecraftSourceRouteOptions {
  db: ReturnType<typeof createDatabase>['db'];
  env: Readonly<Record<string, string | undefined>>;
  principal: (c: Context<{ Variables: Variables }>, regularOnly?: boolean) => Promise<AuthContext>;
  acquireUploadSlot: () => () => void;
}
async function body(c: Context<{ Variables: Variables }>) {
  if (!c.req.header('content-type')?.startsWith('application/json'))
    throw new DomainError('validation_failed');
  try {
    return await c.req.json();
  } catch {
    throw new DomainError('validation_failed');
  }
}
/** Browser sessions and the application's normal origin/CSRF middleware apply
 * to every route, including the one exact streamed-body size-limit exception. */
export function registerMinecraftSourceRoutes(
  app: Hono<{ Variables: Variables }>,
  options: MinecraftSourceRouteOptions,
) {
  const store = async (c: Context<{ Variables: Variables }>, owner = false) =>
    createMinecraftSourceStore(options.db, await options.principal(c, owner), options.env);
  app.post('/v1/minecraft/sources', async (c) =>
    c.json(await (await store(c)).reserveUpload(await body(c)), 201),
  );
  app.post('/v1/minecraft/sources/modrinth', async (c) =>
    c.json(await (await store(c)).acquireModrinth(await body(c), c.req.raw.signal), 201),
  );
  app.get('/v1/minecraft/sources/:id', async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await (await store(c)).inspect(c.req.param('id')));
  });
  app.put('/v1/minecraft/sources/:id/upload', async (c) => {
    const declared = c.req.header('x-nh-upload-length');
    const actual = c.req.header('content-length');
    if (
      c.req.header('content-type') !== 'application/octet-stream' ||
      (c.req.header('content-encoding') && c.req.header('content-encoding') !== 'identity') ||
      !declared ||
      !/^[1-9]\d*$/.test(declared) ||
      !Number.isSafeInteger(Number(declared)) ||
      (actual !== undefined && actual !== declared) ||
      !c.req.raw.body
    )
      throw new DomainError('validation_failed');
    const release = options.acquireUploadSlot();
    try {
      return c.json(
        await (await store(c)).upload(
          c.req.param('id'),
          c.req.raw.body,
          Number(declared),
          c.req.raw.signal,
        ),
      );
    } finally {
      release();
    }
  });
  app.get('/v1/owner/minecraft/sources', async (c) =>
    c.json(await (await store(c, true)).ownerInventory()),
  );
  app.post('/v1/owner/minecraft/sources/:id/recover', async (c) => {
    await (await store(c, true)).recover(c.req.param('id'), await body(c));
    return c.body(null, 204);
  });
  app.post('/v1/owner/minecraft/staging/:jobId/recover', async (c) => {
    await (await store(c, true)).recoverStaging(c.req.param('jobId'), await body(c));
    return c.body(null, 204);
  });
}
