import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Variables } from './app.js';
import { registerGatewaySleepRoutes } from './gateway-sleep.js';

const mocks = vi.hoisted(() => ({ listen: vi.fn(), snapshot: vi.fn() }));
vi.mock('@nickhosting/database', () => ({ listenForGatewayChanges: mocks.listen }));
vi.mock('@nickhosting/server-management', () => ({ getGatewaySnapshot: mocks.snapshot }));
const gatewayId = randomUUID();
function fixture(authenticated = true) {
  const input = {
    routeId: randomUUID(),
    generation: randomUUID(),
    quiescenceUntil: new Date(Date.now() + 60000).toISOString(),
  };
  const route = {
    id: input.routeId,
    generation: input.generation,
    completedSleep: undefined as undefined | { generation: string; quiescenceUntil: string },
  };
  mocks.snapshot.mockImplementation(async () => ({ routes: [{ ...route }] }));
  let changed = () => {};
  let lost = () => {};
  const close = vi.fn();
  mocks.listen.mockImplementation(async (_pool, onChanged, onLost) => {
    changed = onChanged;
    lost = onLost;
    return { close };
  });
  const authenticate = vi.fn(async () => {});
  const app = new Hono<{ Variables: Variables }>();
  app.onError((e, c) => c.json({ code: e instanceof DomainError ? e.code : 'internal' }, 400));
  app.use('*', async (c, next) => {
    c.set('gatewayAuthenticated', authenticated);
    await next();
  });
  registerGatewaySleepRoutes(app, {
    db: {} as never,
    pool: {} as never,
    env: {},
    body: (c) => c.req.json(),
    authenticate,
  });
  return {
    input,
    route,
    close,
    authenticate,
    changed: () => changed(),
    lost: () => lost(),
    complete: () => {
      route.completedSleep = {
        generation: input.generation,
        quiescenceUntil: input.quiescenceUntil,
      };
    },
    call: async (signal?: AbortSignal, body: unknown = input) =>
      app.request(`/internal/gateway/${gatewayId}/sleep-completion`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }),
    ready: () => vi.waitFor(() => expect(mocks.snapshot).toHaveBeenCalled()),
  };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());
describe('durable sleep completion notifications', () => {
  it('requires service authentication and strict input before subscribing', async () => {
    expect((await fixture(false).call()).status).toBe(400);
    const f = fixture();
    expect((await f.call(undefined, { ...f.input, unexpected: true })).status).toBe(400);
    expect(mocks.listen).not.toHaveBeenCalled();
  });
  it('reads after LISTEN and returns an already committed exact proof', async () => {
    const f = fixture();
    f.complete();
    expect((await f.call()).status).toBe(200);
    expect(mocks.listen.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.snapshot.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('waits for the durable exact proof, ignoring unrelated hints and mismatched fences', async () => {
    const f = fixture();
    let settled = false;
    const response = f.call().then((r) => {
      settled = true;
      return r;
    });
    await f.ready();
    f.route.completedSleep = {
      generation: f.input.generation,
      quiescenceUntil: new Date(Date.now()).toISOString(),
    };
    f.changed();
    await vi.waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    f.complete();
    f.changed();
    expect((await response).status).toBe(200);
    expect(f.authenticate).toHaveBeenCalledTimes(4);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('coalesces notifications during a read and rechecks a commit arriving during that read', async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    mocks.snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const response = f.call();
    await f.ready();
    f.complete();
    f.changed();
    f.changed();
    release({ routes: [{ id: f.input.routeId, generation: f.input.generation }] });
    expect((await response).status).toBe(200);
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  });
  it('does not miss a commit while LISTEN setup is pending', async () => {
    const f = fixture();
    let connected!: () => void;
    mocks.listen.mockImplementation(
      () =>
        new Promise((resolve) => {
          connected = () => resolve({ close: f.close });
        }),
    );
    const response = f.call();
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled());
    expect(mocks.snapshot).not.toHaveBeenCalled();
    f.complete();
    connected();
    expect((await response).status).toBe(200);
  });
  it('uses a single shared connection and releases it only after the last waiter', async () => {
    const f = fixture();
    const a = new AbortController();
    const b = new AbortController();
    const first = f.call(a.signal),
      second = f.call(b.signal);
    await f.ready();
    expect(mocks.listen).toHaveBeenCalledOnce();
    a.abort();
    expect((await first).status).toBe(204);
    expect(f.close).not.toHaveBeenCalled();
    b.abort();
    expect((await second).status).toBe(204);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('ends on disconnect without returning a readiness proof', async () => {
    const f = fixture();
    const response = f.call();
    await f.ready();
    f.lost();
    expect((await response).status).toBe(204);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('expires below the HTTP idle timeout, without periodic queries', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const response = f.call();
    await vi.advanceTimersByTimeAsync(19999);
    expect(mocks.snapshot).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect((await response).status).toBe(204);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('releases a listener acquired after the request aborts', async () => {
    const f = fixture();
    let connected!: () => void;
    mocks.listen.mockImplementation(
      () =>
        new Promise((resolve) => {
          connected = () => resolve({ close: f.close });
        }),
    );
    const controller = new AbortController();
    const response = f.call(controller.signal);
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalled());
    controller.abort();
    expect((await response).status).toBe(204);
    connected();
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it('rejects revoked service credentials and route generations', async () => {
    const f = fixture();
    const response = f.call();
    await f.ready();
    f.authenticate.mockRejectedValue(new DomainError('unauthenticated'));
    f.complete();
    f.changed();
    expect((await response).status).toBe(400);
    const g = fixture();
    g.route.generation = randomUUID();
    expect((await g.call()).status).toBe(400);
  });
  it('rejects credentials rotated during the final durable read', async () => {
    const f = fixture();
    f.complete();
    mocks.snapshot.mockImplementation(async () => {
      f.authenticate.mockRejectedValue(new DomainError('unauthenticated'));
      return { routes: [{ ...f.route }] };
    });
    expect((await f.call()).status).toBe(400);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('never waits beyond the original quiescence deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.input.quiescenceUntil = new Date(Date.now() + 1000).toISOString();
    const response = f.call();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await response).status).toBe(204);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('bounds the waiter count without acquiring more LISTEN connections', async () => {
    const f = fixture();
    const controller = new AbortController();
    const requests = Array.from({ length: 128 }, () => f.call(controller.signal));
    await vi.waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(128));
    expect((await f.call()).status).toBe(400);
    expect(mocks.listen).toHaveBeenCalledOnce();
    controller.abort();
    expect((await Promise.all(requests)).every((r) => r.status === 204)).toBe(true);
    expect(f.close).toHaveBeenCalledOnce();
  });
});
