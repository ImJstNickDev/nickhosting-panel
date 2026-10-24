import { authorizeServer, getServerProvisioning } from '@nickhosting/server-management';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Variables } from './app.js';
import { createServerEventStream } from './server-events-stream.js';
import type { ServerRouteOptions } from './servers.js';
import { boundedEventWriter } from './stream-buffer.js';

export function registerProvisioningRoutes(
  app: Hono<{ Variables: Variables }>,
  options: ServerRouteOptions,
) {
  const events = options.pool ? createServerEventStream(options.pool) : undefined;
  app.get('/v1/servers/:id/provisioning', async (c) =>
    c.json({
      provisioning: await getServerProvisioning(
        options.db,
        await options.principal(c),
        c.req.param('id'),
        options.provisioningCache,
      ),
    }),
  );
  app.get('/v1/servers/:id/provisioning/stream', async (c) => {
    const server = await authorizeServer(options.db, await options.principal(c), c.req.param('id'));
    return streamSSE(c, async (stream) => {
      let wake: (() => void) | undefined;
      let dirty = false;
      let lost = false;
      let release: (() => void) | undefined;
      let previous = '';
      let heartbeat = Date.now();
      const changed = () => {
        dirty = true;
        wake?.();
      };
      stream.onAbort(() => wake?.());
      const output = boundedEventWriter(
        (event) => stream.writeSSE(event),
        () => stream.abort(),
        { bytes: 1024 * 1024, events: 1, timeoutMs: 5000 },
      );
      const write = async (event: { event: string; data: string }) => {
        output.send(event);
        await output.drain();
      };
      try {
        release = await events?.subscribe(server.id, changed, () => {
          lost = true;
          wake?.();
        });
        const deadline = Date.now() + 15 * 60_000;
        while (!stream.aborted && !lost && Date.now() < deadline) {
          dirty = false;
          const provisioning = await getServerProvisioning(
            options.db,
            await options.principal(c),
            server.id,
            options.provisioningCache,
          );
          const data = JSON.stringify({ provisioning });
          if (data !== previous) {
            // Cache reads may wait. Do not carry authority across that await.
            await authorizeServer(options.db, await options.principal(c), server.id);
            if (stream.aborted || lost) break;
            await write({ event: 'provisioning', data });
            previous = data;
            heartbeat = Date.now();
          } else if (Date.now() - heartbeat >= 10_000) {
            await write({ event: 'keepalive', data: '{}' });
            heartbeat = Date.now();
          }
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              wake = undefined;
              resolve();
            };
            const timer = setTimeout(done, 1000);
            wake = done;
            if (dirty || stream.aborted || lost) done();
          });
        }
      } catch {
        /* Revocation/disconnection ends delivery; no private errors in SSE. */
      } finally {
        output.close();
        release?.();
      }
    });
  });
}
