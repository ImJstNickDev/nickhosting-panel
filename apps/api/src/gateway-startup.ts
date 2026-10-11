import { DomainError } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import {
  type ManagementRuntime,
  requireGatewayRoute,
  verifyManagedIdentity,
} from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Variables } from './app.js';
import { boundedEventWriter } from './stream-buffer.js';

const requestSchema = z
  .object({
    routeId: z.uuid(),
    routeRevision: z.number().int().positive(),
    generation: z.uuid(),
    wakeJobId: z.uuid(),
  })
  .strict();

/** Register after the Gateway service-auth middleware. Startup events are hints,
 * never readiness evidence or authority to forward traffic. */
export function registerGatewayStartupRoutes(
  app: Hono<{ Variables: Variables }>,
  options: {
    db: ReturnType<typeof createDatabase>['db'];
    env: Readonly<Record<string, string | undefined>>;
    body: (c: Context) => Promise<unknown>;
    management: () => Promise<ManagementRuntime>;
  },
) {
  const active = new Set<string>();
  app.post('/internal/gateway/:gatewayId/startup-events', async (c) => {
    if (!c.get('gatewayAuthenticated')) throw new DomainError('unauthenticated');
    const parsed = requestSchema.safeParse(await options.body(c));
    if (!parsed.success) throw new DomainError('validation_failed');
    const input = parsed.data;
    const selected = await requireGatewayRoute(
      options.db,
      input.routeId,
      input.routeRevision,
      options.env,
    );
    const matches = (route: typeof selected) =>
      route.mode === 'waking' &&
      route.generation === input.generation &&
      route.wakeJobId === input.wakeJobId;
    if (!matches(selected)) throw new DomainError('conflict');
    if (active.has(selected.serverId) || active.size >= 128) throw new DomainError('conflict');
    active.add(selected.serverId);
    let service: ManagementRuntime;
    let identifier: string;
    try {
      service = await options.management();
      const server = await options.db
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', selected.serverId)
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      if (!server.pterodactyl_id) throw new DomainError('not_found');
      const remote = await service.adapter.getApplicationServer(server.pterodactyl_id);
      await verifyManagedIdentity(options.db, server, remote);
      identifier = remote.identifier;
    } catch (error) {
      active.delete(selected.serverId);
      throw error;
    }
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      let finish!: () => void;
      const closed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const stop = () => {
        controller.abort();
        finish();
      };
      const disconnect = () => {
        stream.abort();
        stop();
      };
      const output = boundedEventWriter((event) => stream.writeSSE(event), disconnect, {
        bytes: 1024,
        events: 1,
        timeoutMs: 5000,
      });
      stream.onAbort(stop);
      c.req.raw.signal.addEventListener('abort', disconnect, { once: true });
      if (c.req.raw.signal.aborted) disconnect();
      const timeout = setTimeout(disconnect, 60000);
      timeout.unref();
      let hintPending = false;
      const authorized = async () => {
        if (controller.signal.aborted) return false;
        try {
          // Local route/config checks only; the relay does not poll Pterodactyl.
          const current = await requireGatewayRoute(
            options.db,
            input.routeId,
            input.routeRevision,
            options.env,
          );
          return matches(current) && !controller.signal.aborted;
        } catch {
          return false;
        }
      };
      try {
        const relay = await service.adapter.relayConsole(identifier, {
          signal: controller.signal,
          canSendCommands: false,
          maxDurationMs: 60000,
          authorize: authorized,
          onEvent: (event) => {
            if (event.type === 'closed' || event.type === 'error') {
              stop();
              return;
            }
            if (
              event.type !== 'status' ||
              event.data !== 'running' ||
              hintPending ||
              controller.signal.aborted
            )
              return;
            hintPending = true;
            void (async () => {
              if (await authorized()) {
                output.send({ event: 'startup', data: JSON.stringify(input) });
                await output.drain();
              }
            })()
              .catch(() => {})
              .finally(stop);
          },
        });
        try {
          // Never wait for an unbounded downstream write after cancellation.
          await closed;
        } finally {
          relay.close();
        }
      } catch {
        // Stream failure is deliberately content-free; polling remains the fallback.
      } finally {
        stop();
        output.close();
        clearTimeout(timeout);
        c.req.raw.signal.removeEventListener('abort', disconnect);
        active.delete(selected.serverId);
      }
    });
  });
}
