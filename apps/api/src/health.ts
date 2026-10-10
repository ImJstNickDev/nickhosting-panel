import { authorizeServer, getOwnerHealth, ownerOnly } from '@nickhosting/server-management';
import type { Hono } from 'hono';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function registerHealthRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Omit<ServerRouteOptions, 'acquireUploadSlot'>,
) {
  // Coalesce repeated Owner requests. Provider discovery remains one in-flight
  // read-only probe, even when a slow provider outlives the five-second cache.
  let cached:
    | { expires: number; promise: ReturnType<typeof getOwnerHealth>; pending: boolean }
    | undefined;
  app.get('/v1/owner/health', async (c) => {
    const context = await options.principal(c, true);
    ownerOnly(context);
    if (!cached || (!cached.pending && cached.expires <= Date.now())) {
      const entry = {
        expires: Date.now() + 5000,
        promise: getOwnerHealth(options.db, context, options.env, {
          management: options.management,
        }),
        pending: true,
      };
      cached = entry;
      void entry.promise
        .finally(() => {
          entry.pending = false;
        })
        .catch(() => {});
    }
    c.header('cache-control', 'no-store');
    return c.json(await cached.promise);
  });
  app.get('/v1/owner/servers/:id/allocations', async (c) => {
    const context = await options.principal(c, true);
    ownerOnly(context);
    const server = await authorizeServer(options.db, context, c.req.param('id'));
    return c.json(
      await options.db
        .selectFrom('server_allocations')
        .select([
          'id',
          'node_id',
          'pterodactyl_allocation_id',
          'address',
          'backend_address',
          'port',
          'role',
          'protocols',
          'is_primary',
        ])
        .where('server_id', '=', server.id)
        .orderBy('role')
        .execute(),
    );
  });
  app.get('/v1/owner/provider-users', async (c) => {
    ownerOnly(await options.principal(c, true));
    const rows = await (await options.management()).adapter.listUsers();
    return c.json(rows.map((row) => ({ id: row.id, uuid: row.uuid, username: row.username })));
  });
}
