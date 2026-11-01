import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrivateTransferCache } from './adapter.js';
import { type ConsoleCredentials, createConsoleCredentials } from './console-credentials.js';
import { createTransport, createTransportCoordinator } from './transport.js';

const options = {
  baseURL: 'https://panel.example.test',
  applicationKey: 'app-key',
  clientKey: 'client-key',
  fileDownloadBinding: 'binding-v1',
};
const path = 'servers/fixture/websocket';
function value(serial = 1): ConsoleCredentials {
  return {
    token: `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, serial })).toString('base64url')}.signature`,
    socket: 'wss://node.example.test/api/servers/uuid/ws',
  };
}
const validate = (candidate: unknown) => candidate as ConsoleCredentials;
afterEach(() => vi.useRealTimers());

describe('private WebSocket credential reuse', () => {
  it('keeps timeout invalidation nonthrowing when fenced entries fill the bounded cache', async () => {
    const config = { ...options, coordinator: createTransportCoordinator() };
    const read = vi.fn(async () => value());
    const create = (id: string) =>
      createConsoleCredentials(createTransport(config), config, path, id, read, validate);
    const oldest = create('oldest');
    const token = await oldest.read();
    for (let i = 0; i < 1024; i++) create(`server-${i}`).invalidate('rejected');
    expect(() => oldest.invalidate(token.token)).not.toThrow();
    await expect(oldest.read()).rejects.toMatchObject({
      reason: 'unavailable',
      outcome: 'rejected',
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(['delayed', 'failed'])(
    'fences rejected grants immediately when shared deletion is %s',
    async (cleanup) => {
      const stored = new Map<string, string>();
      let finishDelete: (() => void) | undefined;
      let failWrites = false;
      const transferCache: PrivateTransferCache = {
        get: async (key) => stored.get(key),
        put: async (key, content) => {
          if (failWrites) throw new Error('cache unavailable');
          stored.set(key, content);
        },
        delete: async (key) => {
          if (cleanup === 'failed') throw new Error('cache unavailable');
          await new Promise<void>((resolve) => {
            finishDelete = resolve;
          });
          stored.delete(key);
        },
        take: async () => undefined,
      };
      const config = { ...options, coordinator: createTransportCoordinator(), transferCache };
      let serial = 0;
      const read = vi.fn(async () => value(++serial));
      const create = () =>
        createConsoleCredentials(createTransport(config), config, path, 'uuid', read, validate);
      const first = create();
      const rejected = await first.read();
      // Keep the rejected grant in Redis even if the replacement write fails.
      failWrites = true;
      first.invalidate(rejected.token);
      const replacement = await create().read();
      expect(replacement.token).not.toBe(rejected.token);
      expect(read).toHaveBeenCalledTimes(2);
      expect([...stored.values()][0]).toContain(rejected.token);
      expect(await first.read()).toEqual(replacement);
      finishDelete?.();
    },
  );

  it('does not revive an invalidated grant from a shared read already in flight', async () => {
    const rejected = value();
    let completeRead: ((value: string) => void) | undefined;
    const transferCache: PrivateTransferCache = {
      get: async () =>
        new Promise<string>((resolve) => {
          completeRead = resolve;
        }),
      put: async () => {},
      delete: async () => {
        throw new Error('cache unavailable');
      },
      take: async () => undefined,
    };
    const config = { ...options, transferCache };
    const read = vi.fn(async () => value(2));
    const grant = createConsoleCredentials(
      createTransport(config),
      config,
      path,
      'uuid',
      read,
      validate,
    );
    const pending = grant.read();
    grant.invalidate(rejected.token);
    completeRead?.(JSON.stringify({ value: rejected, expiresAt: Date.now() + 120_000 }));
    const fresh = await pending;
    expect(fresh.token).not.toBe(rejected.token);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await grant.read()).toEqual(fresh);
  });

  it('coalesces concurrent reads and reuses completed grants across adapter recreation', async () => {
    const coordinator = createTransportCoordinator();
    const config = { ...options, coordinator };
    const read = vi.fn(async () => value());
    const a = createConsoleCredentials(
      createTransport(config),
      config,
      path,
      'uuid',
      read,
      validate,
    );
    const b = createConsoleCredentials(
      createTransport(config),
      config,
      path,
      'uuid',
      read,
      validate,
    );
    const tokens = await Promise.all([a.read(), b.read()]);
    expect(tokens[0]).toEqual(tokens[1]);
    await b.read();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('binds reuse to credential, managed identity, UUID, provider and installation scope', async () => {
    const coordinator = createTransportCoordinator();
    const config = { ...options, coordinator };
    const read = vi.fn(async () => value());
    const variants = [
      { config, path, uuid: 'uuid' },
      { config: { ...config, clientKey: 'new-key' }, path, uuid: 'uuid' },
      { config: { ...config, fileDownloadBinding: 'binding-v2' }, path, uuid: 'uuid' },
      { config: { ...config, baseURL: 'https://other-panel.example.test' }, path, uuid: 'uuid' },
      { config, path, uuid: 'other-uuid' },
      {
        config,
        path: 'extensions/nickhosting/servers/fixture/installation-websocket',
        uuid: 'uuid',
      },
    ];
    for (const entry of variants)
      await createConsoleCredentials(
        createTransport(entry.config),
        entry.config,
        entry.path,
        entry.uuid,
        read,
        validate,
      ).read();
    expect(read).toHaveBeenCalledTimes(variants.length);
  });

  it('shares through the existing private cache without extending reuse and refreshes/rejects old tokens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T10:00:00Z'));
    const stored = new Map<string, string>();
    const transferCache: PrivateTransferCache = {
      get: async (key) => stored.get(key),
      put: async (key, content) => {
        stored.set(key, content);
      },
      delete: async (key) => {
        stored.delete(key);
      },
      take: async () => undefined,
    };
    const config = { ...options, transferCache };
    let serial = 0;
    const read = vi.fn(async () => value(++serial));
    const create = () =>
      createConsoleCredentials(createTransport(config), config, path, 'uuid', read, validate);
    const first = await create().read();
    expect(await create().read()).toEqual(first);
    expect(read).toHaveBeenCalledTimes(1);
    expect([...stored.keys()][0]).not.toContain('client-key');
    vi.advanceTimersByTime(119_000);
    expect(await create().read()).toEqual(first);
    vi.advanceTimersByTime(1001);
    const refreshed = await create().read();
    expect(refreshed.token).not.toBe(first.token);
    expect(read).toHaveBeenCalledTimes(2);
    const grant = create();
    const next = await grant.read(refreshed.token);
    expect(next.token).not.toBe(refreshed.token);
    grant.invalidate(next.token);
    await create().read();
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('does not cache opaque or nearly expired tokens and falls back on private-cache failure', async () => {
    const config = {
      ...options,
      transferCache: {
        get: vi.fn().mockRejectedValue(new Error('private')),
        put: vi.fn(),
        delete: vi.fn(),
        take: vi.fn(),
      },
    };
    const read = vi.fn(async () => ({
      token: 'opaque-fixture',
      socket: 'wss://node.example.test',
    }));
    const grant = createConsoleCredentials(
      createTransport(config),
      config,
      path,
      'uuid',
      read,
      validate,
    );
    await grant.read();
    await grant.read();
    expect(read).toHaveBeenCalledTimes(2);
    expect(config.transferCache.put).not.toHaveBeenCalled();
    read.mockImplementation(async () => ({
      token: `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 20 })).toString('base64url')}.signature`,
      socket: 'wss://node.example.test',
    }));
    await grant.read();
    await grant.read();
    expect(read).toHaveBeenCalledTimes(4);
    expect(config.transferCache.put).not.toHaveBeenCalled();
  });
});
