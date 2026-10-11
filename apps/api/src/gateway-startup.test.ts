import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { DomainError } from '@nickhosting/core';
import type { ConsoleRelayOptions } from '@nickhosting/pterodactyl-adapter';
import { Hono } from 'hono';
import { SSEStreamingApi } from 'hono/streaming';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Variables } from './app.js';
import { registerGatewayStartupRoutes } from './gateway-startup.js';
import { createApiHttpServer } from './http-server.js';

const keepalive = 'event: keepalive\ndata: {}\n\n';

const mocks = vi.hoisted(() => ({ route: vi.fn(), identity: vi.fn() }));
vi.mock('@nickhosting/server-management', () => ({
  requireGatewayRoute: mocks.route,
  verifyManagedIdentity: mocks.identity,
}));
const input = {
  routeId: randomUUID(),
  routeRevision: 3,
  generation: randomUUID(),
  wakeJobId: randomUUID(),
};
const gatewayId = randomUUID(),
  serverId = randomUUID();
function fixture(authenticated = true) {
  const current = {
    id: input.routeId,
    serverId,
    mode: 'waking',
    generation: input.generation,
    wakeJobId: input.wakeJobId,
  };
  mocks.route.mockResolvedValue(current);
  mocks.identity.mockResolvedValue(undefined);
  let relayInput: ConsoleRelayOptions | undefined;
  const close = vi.fn(),
    requestLogs = vi.fn();
  const adapter = {
    getApplicationServer: vi.fn(async () => ({ identifier: '12345678' })),
    relayConsole: vi.fn(async (_id: string, options: ConsoleRelayOptions) => {
      relayInput = options;
      return { close, requestLogs };
    }),
  };
  const row = { id: serverId, pterodactyl_id: 1 };
  const query = {
    selectAll: () => query,
    where: () => query,
    executeTakeFirstOrThrow: async () => row,
  };
  const app = new Hono<{ Variables: Variables }>();
  const log = vi.fn();
  app.onError((error, c) =>
    c.json({ error: error instanceof DomainError ? error.code : 'internal' }, 400),
  );
  app.use('*', async (c, next) => {
    c.set('gatewayAuthenticated', authenticated);
    await next();
  });
  registerGatewayStartupRoutes(app, {
    logger: { log } as never,
    db: { selectFrom: () => query } as never,
    env: {},
    body: (c) => c.req.json(),
    management: async () => ({ adapter }) as never,
  });
  const call = (body: unknown = input, signal?: AbortSignal, keepalives = true) =>
    app.request(`/internal/gateway/${gatewayId}/startup-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(keepalives ? { 'X-NickHosting-Gateway-Features': 'startup-keepalive-v1' } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  const ready = async () => {
    await vi.waitFor(() => expect(relayInput).toBeDefined());
    return relayInput as ConsoleRelayOptions;
  };
  return { app, call, ready, adapter, close, requestLogs, current, log };
}
beforeEach(() => vi.clearAllMocks());
describe('Gateway startup hints', () => {
  it('preserves the startup-only wire contract for legacy Gateway clients', async () => {
    const f = fixture();
    const response = await f.call(input, undefined, false);
    const relay = await f.ready();
    relay.onEvent({ type: 'status', data: 'running' });
    expect(await response.text()).toBe(`event: startup\ndata: ${JSON.stringify(input)}\n\n`);
    expect(f.log).toHaveBeenCalledTimes(2);
    expect(f.log).toHaveBeenLastCalledWith(
      'info',
      'gateway_startup_channel_closed',
      expect.objectContaining({ reason: 'hint_sent' }),
    );
  });
  it.each([false, true])(
    'keeps the real HTTP startup stream alive beyond socket inactivity only with heartbeats (%s)',
    async (heartbeats) => {
      const realInterval = globalThis.setInterval;
      const interval = vi
        .spyOn(globalThis, 'setInterval')
        .mockImplementation((callback, ms, ...args) =>
          realInterval(callback, ms === 10000 ? 50 : ms, ...args),
        );
      const realWrite = SSEStreamingApi.prototype.writeSSE;
      // Negative control reproduces the original silent stream using the same
      // route, Node server and network; only its keepalive writes are suppressed.
      const write = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementation(function (
        this: SSEStreamingApi,
        event,
      ) {
        if (!heartbeats && event.event === 'keepalive') return Promise.resolve();
        return realWrite.call(this, event);
      });
      const f = fixture();
      const server = createApiHttpServer(getRequestListener(f.app.fetch), { idleTimeoutMs: 200 });
      let running: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture port');
        const result = new Promise<{ body: string; error: boolean }>((resolve) => {
          const request = httpRequest(
            {
              host: '127.0.0.1',
              port: address.port,
              path: `/internal/gateway/${gatewayId}/startup-events`,
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'X-NickHosting-Gateway-Features': 'startup-keepalive-v1',
              },
            },
            (response) => {
              let body = '';
              response.setEncoding('utf8');
              response.on('data', (chunk: string) => {
                body += chunk;
              });
              response.on('end', () => resolve({ body, error: false }));
              response.on('error', () => resolve({ body, error: true }));
            },
          );
          request.on('error', () => resolve({ body: '', error: true }));
          request.end(JSON.stringify(input));
        });
        const relay = await f.ready();
        running = setTimeout(() => relay.onEvent({ type: 'status', data: 'running' }), 700);
        const response = await result;
        expect(response.error).toBe(!heartbeats);
        if (heartbeats) {
          expect(response.body.split(keepalive).length).toBeGreaterThan(3);
          expect(response.body).toContain(`event: startup\ndata: ${JSON.stringify(input)}\n\n`);
        } else {
          expect(response.body).not.toContain('event: startup');
        }
        await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
        expect(relay.signal?.aborted).toBe(true);
        expect(f.requestLogs).not.toHaveBeenCalled();
      } finally {
        clearTimeout(running);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        write.mockRestore();
        interval.mockRestore();
      }
    },
  );
  it('requires service authentication and rejects additional request fields', async () => {
    const f = fixture(false);
    expect((await f.call()).status).toBe(400);
    expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
    const g = fixture();
    expect((await g.call({ ...input, command: 'start' })).status).toBe(400);
    expect(g.adapter.getApplicationServer).not.toHaveBeenCalled();
  });
  it('only emits sanitized running hint; never requests logs or allows commands', async () => {
    const f = fixture();
    const response = await f.call();
    const relay = await f.ready();
    relay.onEvent({ type: 'console', data: 'Done! provider-secret' });
    relay.onEvent({ type: 'status', data: 'starting' });
    relay.onEvent({ type: 'status', data: 'running' });
    relay.onEvent({ type: 'status', data: 'running' });
    const text = await response.text();
    expect(text).toBe(`${keepalive}event: startup\ndata: ${JSON.stringify(input)}\n\n`);
    expect(f.requestLogs).not.toHaveBeenCalled();
    expect(relay.canSendCommands).toBe(false);
    expect(f.close).toHaveBeenCalledOnce();
    expect(mocks.identity).toHaveBeenCalledOnce();
    expect(f.log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('provider-secret');
  });
  it('denies stale generation and foreign identity before connecting', async () => {
    const f = fixture();
    f.current.generation = randomUUID();
    expect((await f.call()).status).toBe(400);
    expect(f.adapter.relayConsole).not.toHaveBeenCalled();
    f.current.generation = input.generation;
    mocks.identity.mockRejectedValueOnce(new DomainError('forbidden'));
    expect((await f.call()).status).toBe(400);
    expect(f.adapter.relayConsole).not.toHaveBeenCalled();
  });
  it('rechecks current generation before emitting and hides stale events', async () => {
    const f = fixture();
    const response = await f.call(),
      relay = await f.ready();
    f.current.wakeJobId = randomUUID();
    relay.onEvent({ type: 'status', data: 'running' });
    expect(await response.text()).toBe(keepalive);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('caps duplicate subscriptions and abort releases the slot', async () => {
    const f = fixture(),
      controller = new AbortController();
    const response = await f.call(input, controller.signal),
      relay = await f.ready();
    expect((await f.call()).status).toBe(400);
    controller.abort();
    expect(await response.text()).toBe(keepalive);
    expect(relay.signal?.aborted).toBe(true);
    expect(f.close).toHaveBeenCalledOnce();
    const next = await f.call();
    await vi.waitFor(() => expect(f.adapter.relayConsole).toHaveBeenCalledTimes(2));
    const latest = f.adapter.relayConsole.mock.calls[1]?.[1];
    latest?.onEvent({ type: 'closed' });
    expect(await next.text()).toBe(keepalive);
  });
  it('ends an idle subscription after sixty seconds and closes its relay', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const response = await f.call();
      const body = response.text();
      await Promise.resolve();
      expect(f.adapter.relayConsole).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60000);
      expect(await body).toBe(keepalive.repeat(6));
      expect(f.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(f.log).toHaveBeenLastCalledWith(
        'info',
        'gateway_startup_channel_closed',
        expect.objectContaining({ reason: 'deadline', elapsedMs: 60000 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('disconnects a non-reading backpressured consumer and releases its subscription', async () => {
    vi.useFakeTimers();
    // Emulate an exhausted HTTP writer; never consume the response body.
    const write = vi
      .spyOn(SSEStreamingApi.prototype, 'writeSSE')
      .mockImplementation(() => new Promise(() => {}));
    const abort = vi.spyOn(SSEStreamingApi.prototype, 'abort');
    try {
      const f = fixture();
      const response = await f.call();
      expect(response.body?.locked).toBe(false);
      const relay = f.adapter.relayConsole.mock.calls[0]?.[1];
      relay?.onEvent({ type: 'status', data: 'running' });
      await vi.advanceTimersByTimeAsync(0);
      expect(write).toHaveBeenCalledOnce();
      expect(f.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(abort).toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledOnce();
      expect(relay?.signal?.aborted).toBe(true);
      const next = await f.call();
      expect(next.status).toBe(200);
      expect(f.adapter.relayConsole).toHaveBeenCalledTimes(2);
      f.adapter.relayConsole.mock.calls[1]?.[1].onEvent({ type: 'closed' });
      await next.body?.cancel();
      await response.body?.cancel();
    } finally {
      write.mockRestore();
      abort.mockRestore();
      vi.useRealTimers();
    }
  });
  it('local revocation closes without disclosing provider errors', async () => {
    const f = fixture();
    const response = await f.call(),
      relay = await f.ready();
    mocks.route.mockRejectedValue(new Error('disabled-secret'));
    expect(await relay.authorize()).toBe(false);
    relay.onEvent({ type: 'error', code: 'integration_unavailable' });
    expect(await response.text()).toBe(keepalive);
  });
});
