import { type createLogger, DomainError } from '@nickhosting/core';
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
    logger?: ReturnType<typeof createLogger>;
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
      const startedAt = Date.now();
      const log = (event: string, data: Record<string, unknown> = {}) => {
        try {
          options.logger?.log('info', event, {
            routeId: input.routeId,
            generation: input.generation,
            wakeJobId: input.wakeJobId,
            ...data,
          });
        } catch {
          // Diagnostics cannot change the subscription or expose provider errors.
        }
      };
      type CloseReason =
        | 'closed'
        | 'client_disconnected'
        | 'output_failed'
        | 'deadline'
        | 'relay_closed'
        | 'relay_error'
        | 'revoked'
        | 'hint_sent';
      let reason: CloseReason = 'closed';
      const controller = new AbortController();
      let finish!: () => void;
      const closed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stop = (nextReason: CloseReason = 'closed') => {
        if (!controller.signal.aborted) reason = nextReason;
        if (heartbeat) clearInterval(heartbeat);
        controller.abort();
        finish();
      };
      const disconnect = (nextReason: CloseReason = 'client_disconnected') => {
        stop(nextReason);
        stream.abort();
      };
      const output = boundedEventWriter(
        (event) => stream.writeSSE(event),
        () => disconnect('output_failed'),
        {
          bytes: 1024,
          events: 2,
          timeoutMs: 5000,
        },
      );
      const clientDisconnected = () => disconnect();
      stream.onAbort(() => stop('client_disconnected'));
      c.req.raw.signal.addEventListener('abort', clientDisconnected, { once: true });
      if (c.req.raw.signal.aborted) disconnect();
      const timeout = setTimeout(() => disconnect('deadline'), 60000);
      timeout.unref();
      // Flush headers and keep Node's HTTP socket active while Wings starts the
      // process. These frames convey no readiness or renewed route authority.
      const keepalives =
        c.req
          .header('X-NickHosting-Gateway-Features')
          ?.split(',')
          .map((value) => value.trim())
          .includes('startup-keepalive-v1') === true;
      if (keepalives && !controller.signal.aborted) {
        output.send({ event: 'keepalive', data: '{}' });
        heartbeat = setInterval(() => {
          output.send({ event: 'keepalive', data: '{}' });
        }, 10000);
        heartbeat.unref();
      }
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
              stop(event.type === 'closed' ? 'relay_closed' : 'relay_error');
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
                stop('hint_sent');
              } else {
                stop('revoked');
              }
            })()
              .catch(() => {})
              .finally(() => stop());
          },
        });
        log('gateway_startup_channel_connected', { keepalives });
        try {
          // Never wait for an unbounded downstream write after cancellation.
          await closed;
        } finally {
          relay.close();
        }
      } catch {
        // Stream failure is deliberately content-free; polling remains the fallback.
        stop('relay_error');
      } finally {
        stop();
        output.close();
        clearTimeout(timeout);
        c.req.raw.signal.removeEventListener('abort', clientDisconnected);
        active.delete(selected.serverId);
        log('gateway_startup_channel_closed', { reason, elapsedMs: Date.now() - startedAt });
      }
    });
  });
}
