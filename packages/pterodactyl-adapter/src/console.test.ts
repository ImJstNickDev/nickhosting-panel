import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { createPterodactylAdapter } from './adapter.js';
import type { ConsoleEvent, ConsoleRelay } from './console.js';
import type { ApplicationServer } from './types.js';

const uuid = 'f729c8a1-6773-467a-af3f-a7ea8704f0bd';
const client = {
  server_owner: true,
  identifier: 'f729c8a1',
  uuid,
  name: 'fixture',
  description: '',
  limits: { memory: 128, swap: 0, disk: 256, io: 500, cpu: 25 },
  feature_limits: { databases: 0, allocations: 1, backups: 1 },
  is_suspended: false,
  is_installing: false,
};
const servers: WebSocketServer[] = [];
const relays: ConsoleRelay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) relay.close();
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function setup() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const origin = `ws://127.0.0.1:${address.port}`;
  const incoming: { event: string; args: string[] }[] = [];
  const origins: (string | undefined)[] = [];
  let connected: WebSocket | undefined;
  server.on('connection', (socket, request) => {
    connected = socket;
    origins.push(request.headers.origin);
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      incoming.push(event);
      if (event.event === 'auth') socket.send(JSON.stringify({ event: 'auth success', args: [] }));
    });
  });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    /\/(?:installation-)?websocket$/.test(String(url))
      ? Response.json({
          data: {
            token: `jwt-fixture-secret-${incoming.filter((event) => event.event === 'auth').length}`,
            socket: `${origin}/api/servers/${uuid}/ws`,
          },
        })
      : Response.json({ attributes: client }),
  );
  const adapter = createPterodactylAdapter({
    baseURL: 'https://panel.example.com',
    applicationKey: 'app-fixture-secret',
    clientKey: 'client-fixture-secret',
    fetcher,
    webSocketOrigins: [origin],
    timeoutMs: 1000,
  });
  return {
    adapter,
    fetcher,
    origin,
    incoming,
    origins,
    send(event: string, args: unknown[]) {
      if (!connected) throw new Error('not connected');
      connected.send(JSON.stringify({ event, args }));
    },
  };
}

describe('backend console mediation over a real isolated WebSocket', () => {
  it('reuses a valid grant for another authenticated connection without another issuance', async () => {
    const fixture = await setup();
    const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.signature`;
    fixture.fetcher.mockImplementation(async (url) =>
      String(url).endsWith('/websocket')
        ? Response.json({ data: { token, socket: `${fixture.origin}/api/servers/${uuid}/ws` } })
        : Response.json({ attributes: client }),
    );
    for (let i = 0; i < 2; i++)
      relays.push(
        await fixture.adapter.relayConsole('f729c8a1', {
          authorize: async () => true,
          onEvent() {},
        }),
      );
    expect(
      fixture.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/websocket')),
    ).toHaveLength(1);
    await expect(
      fixture.adapter.relayConsole('f729c8a1', { authorize: async () => false, onEvent() {} }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(fixture.incoming.filter((event) => event.event === 'auth')).toHaveLength(2);
    fixture.send('jwt error', ['invalidated by Wings restart']);
    // Wait for the rejecting connection to close before requesting its replacement.
    await vi.waitFor(() =>
      expect(
        [...(servers.at(-1)?.clients ?? [])].filter((socket) => socket.readyState === 1),
      ).toHaveLength(1),
    );
    relays.push(
      await fixture.adapter.relayConsole('f729c8a1', { authorize: async () => true, onEvent() {} }),
    );
    expect(
      fixture.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/websocket')),
    ).toHaveLength(2);
  });

  it('rejects oversized encoded commands before sending and applies the native log request budget', async () => {
    const fixture = await setup();
    const relay = await fixture.adapter.relayConsole('f729c8a1', {
      authorize: async () => true,
      canSendCommands: true,
      onEvent() {},
    });
    relays.push(relay);
    for (const command of ['a'.repeat(4096), '🌍'.repeat(1024), '\\'.repeat(2048)])
      await expect(relay.sendCommand(command)).rejects.toMatchObject({ code: 'validation_failed' });
    const overhead = Buffer.byteLength(JSON.stringify({ event: 'send command', args: [''] }));
    await relay.sendCommand('a'.repeat(4096 - overhead));
    await relay.requestLogs();
    await relay.requestLogs();
    await expect(relay.requestLogs()).rejects.toMatchObject({
      reason: 'rate_limited',
      outcome: 'rejected',
    });
    await vi.waitFor(() => expect(fixture.incoming).toHaveLength(4));
    expect(Buffer.byteLength(JSON.stringify(fixture.incoming[1]))).toBe(4096);
  });

  it.each(['global', 'send command', 'auth', 'send stats'])(
    'reports Wings throttling (%s) and never replays a dispatched command',
    async (scope) => {
      const fixture = await setup();
      const events: ConsoleEvent[] = [];
      const relay = await fixture.adapter.relayConsole('f729c8a1', {
        authorize: async () => true,
        canSendCommands: true,
        onEvent: (event) => events.push(event),
      });
      relays.push(relay);
      await relay.sendCommand('list');
      fixture.send('throttled', [scope]);
      await vi.waitFor(() => expect(events).toContainEqual({ type: 'closed' }));
      expect(events).toContainEqual({
        type: 'error',
        code: 'integration_unavailable',
        reason: 'rate_limited',
      });
      await expect(relay.sendCommand('stop')).rejects.toMatchObject({
        reason: 'rate_limited',
        outcome: 'unknown',
      });
      expect(fixture.incoming.filter((event) => event.event === 'send command')).toEqual([
        { event: 'send command', args: ['list'] },
      ]);
    },
  );

  it('uses one restricted Blueprint request for installation logs without a blocked Client identity fetch', async () => {
    const fixture = await setup();
    const events: ConsoleEvent[] = [];
    const relay = await fixture.adapter.relayInstallation('f729c8a1', {
      serverUUID: uuid,
      authorize: async () => true,
      canSendCommands: true, // Even a mistaken caller cannot enable commands on this relay.
      onEvent: (event) => events.push(event),
    });
    relays.push(relay);
    expect(fixture.fetcher).toHaveBeenCalledTimes(1);
    expect(String(fixture.fetcher.mock.calls[0]?.[0])).toBe(
      'https://panel.example.com/api/client/extensions/nickhosting/servers/f729c8a1/installation-websocket',
    );
    expect(new Headers(fixture.fetcher.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer client-fixture-secret',
    );
    fixture.send('install started', []);
    fixture.send('install output', ['Downloading jwt-fixture-secret-0']);
    fixture.send('console output', ['runtime output is separate']);
    fixture.send('status', ['running']);
    fixture.send('install completed', []);
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events).toEqual([
      { type: 'installation', phase: 'started' },
      { type: 'console', source: 'installation', data: 'Downloading [redacted]' },
      { type: 'installation', phase: 'completed' },
    ]);
    await expect(relay.sendCommand('stop')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(relay.requestLogs()).rejects.toMatchObject({ code: 'forbidden' });
    await expect(relay.requestStats()).rejects.toMatchObject({ code: 'forbidden' });
    expect(fixture.incoming).toHaveLength(1);
    fixture.send('token expiring', []);
    await vi.waitFor(() => expect(fixture.incoming).toHaveLength(2));
    expect(
      fixture.fetcher.mock.calls.every(([url]) => String(url).endsWith('/installation-websocket')),
    ).toBe(true);
  });
  it('rejects installer websocket tokens pointing to a different managed server UUID', async () => {
    const fixture = await setup();
    await expect(
      fixture.adapter.relayInstallation('f729c8a1', {
        serverUUID: 'a729c8a1-6773-467a-af3f-a7ea8704f0bd',
        authorize: async () => true,
        onEvent() {},
      }),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
  });
  it('uses the managed stop UUID for its internal relay without refetching Application or Client identity', async () => {
    const fixture = await setup();
    const reads: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path.endsWith('/websocket')) return fixture.fetcher(url, init);
      if (path.endsWith('/power')) {
        fixture.send('status', ['stopping']);
        fixture.send('status', ['offline']);
        return new Response(null, { status: 204 });
      }
      throw new Error('Unexpected identity refetch');
    });
    const observer = { preflight: vi.fn(async () => {}), stopped: vi.fn(async () => true) };
    const adapter = createPterodactylAdapter({
      baseURL: 'https://panel.example.com',
      applicationKey: 'isolated-app-key',
      clientKey: 'isolated-client-key',
      fetcher,
      webSocketOrigins: [fixture.origin],
      containerObserver: observer,
      timeoutMs: 1000,
    });
    const beforePower = vi.fn(async () => {}),
      onConfirmed = vi.fn(async () => {});
    const result = await adapter.stopWithConfirmation(1, client.identifier, {
      verifiedServer: {
        id: 1,
        uuid,
        identifier: client.identifier,
        nest: 1,
        egg: 1,
      } as ApplicationServer,
      authorize: async () => true,
      beforePower,
      onConfirmed,
    });
    expect(result).toEqual({ confirmed: true });
    expect(reads).toEqual([
      `/api/client/servers/${client.identifier}/websocket`,
      `/api/client/servers/${client.identifier}/power`,
    ]);
    expect(beforePower).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(observer.stopped).toHaveBeenCalledWith(uuid, 'server');
  });
  it('rechecks command permission independently from read-only stream permission', async () => {
    const fixture = await setup();
    let writable = true;
    const relay = await fixture.adapter.relayConsole('f729c8a1', {
      authorize: async () => true,
      canSendCommands: true,
      authorizeCommand: async () => writable,
      onEvent: () => {},
    });
    relays.push(relay);
    await relay.sendCommand('list');
    await vi.waitFor(() => expect(fixture.incoming).toHaveLength(2));
    writable = false;
    await expect(relay.sendCommand('stop')).rejects.toMatchObject({ code: 'forbidden' });
    expect(fixture.incoming).toHaveLength(2);
    await relay.requestStats();
    await vi.waitFor(() => expect(fixture.incoming.at(-1)?.event).toBe('send stats'));
  });
  it('sets the Panel Origin, authenticates internally, filters events and redacts tokens', async () => {
    const fixture = await setup();
    const events: ConsoleEvent[] = [];
    const relay = await fixture.adapter.relayConsole('f729c8a1', {
      authorize: async () => true,
      canSendCommands: true,
      onEvent: (event) => events.push(event),
    });
    relays.push(relay);
    expect(fixture.origins).toEqual(['https://panel.example.com']);
    expect(fixture.incoming[0]).toEqual({ event: 'auth', args: ['jwt-fixture-secret-0'] });
    fixture.send('console output', ['server ready jwt-fixture-secret-0 client-fixture-secret']);
    fixture.send('daemon message', ['Pulling image app-fixture-secret']);
    fixture.send('install output', ['Installer output client-fixture-secret']);
    fixture.send('auth', ['do-not-forward']);
    fixture.send('status', ['running']);
    fixture.send('stats', [
      JSON.stringify({
        memory_bytes: 100,
        cpu_absolute: 4,
        disk_bytes: 20,
        token: 'do-not-forward',
      }),
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(5));
    expect(events).toEqual([
      { type: 'console', data: 'server ready [redacted] [redacted]' },
      { type: 'console', data: 'Pulling image [redacted]' },
      { type: 'console', data: 'Installer output [redacted]', source: 'installation' },
      { type: 'status', data: 'running' },
      { type: 'stats', data: { memory_bytes: 100, cpu_absolute: 4, disk_bytes: 20 } },
    ]);
    expect(JSON.stringify(relay)).not.toContain('jwt');
    await relay.sendCommand('list');
    await relay.requestLogs();
    await relay.requestStats();
    await vi.waitFor(() =>
      expect(fixture.incoming.map((event) => event.event)).toEqual([
        'auth',
        'send command',
        'send logs',
        'send stats',
      ]),
    );
  });
  it('refreshes expiring JWTs internally and redacts both old and new credentials', async () => {
    const fixture = await setup();
    const events: ConsoleEvent[] = [];
    const relay = await fixture.adapter.relayConsole('f729c8a1', {
      authorize: async () => true,
      onEvent: (event) => events.push(event),
    });
    relays.push(relay);
    fixture.send('token expiring', []);
    await vi.waitFor(() => expect(fixture.incoming).toHaveLength(2));
    fixture.send('console output', ['jwt-fixture-secret-0 jwt-fixture-secret-1']);
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: 'console', data: '[redacted] [redacted]' }),
    );
    expect(events.some((event) => JSON.stringify(event).includes('jwt-fixture'))).toBe(false);
  });
  it('enforces read-only handles and rechecks authorization before outbound commands', async () => {
    const fixture = await setup();
    let authorized = true;
    const events: ConsoleEvent[] = [];
    const relay = await fixture.adapter.relayConsole('f729c8a1', {
      authorize: async () => authorized,
      onEvent: (event) => events.push(event),
    });
    relays.push(relay);
    await expect(relay.sendCommand('stop')).rejects.toMatchObject({ code: 'forbidden' });
    authorized = false;
    await expect(relay.requestLogs()).rejects.toMatchObject({ code: 'forbidden' });
    expect(fixture.incoming).toHaveLength(1);
    expect(events).toContainEqual({ type: 'closed' });
  });
  it('sanitizes JWT/provider errors and closes rather than exposing upstream frames', async () => {
    const fixture = await setup();
    const events: ConsoleEvent[] = [];
    const relay = await fixture.adapter.relayConsole('f729c8a1', {
      authorize: async () => true,
      onEvent: (event) => events.push(event),
    });
    relays.push(relay);
    fixture.send('jwt error', ['private token with internal path']);
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'closed' }));
    expect(events).toEqual([
      { type: 'error', code: 'integration_unavailable' },
      { type: 'closed' },
    ]);
  });
  it('rejects URLs outside the configured Wings origins and the exact verified server path', async () => {
    for (const socket of [
      'wss://untrusted.example.com/api/servers/fixture/ws',
      `wss://panel.example.com/api/servers/${uuid}/ws?token=secret`,
      'wss://panel.example.com/api/servers/another/ws',
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async (url) =>
          String(url).endsWith('/websocket')
            ? Response.json({ data: { socket, token: 'jwt-fixture' } })
            : Response.json({ attributes: client }),
        );
      const adapter = createPterodactylAdapter({
        baseURL: 'https://panel.example.com',
        applicationKey: 'app',
        clientKey: 'client',
        fetcher,
      });
      await expect(
        adapter.relayConsole('f729c8a1', { authorize: async () => true, onEvent: () => {} }),
      ).rejects.toMatchObject({ reason: 'invalid_response' });
    }
  });
  it('closes immediately when the downstream request aborts', async () => {
    const fixture = await setup();
    const events: ConsoleEvent[] = [];
    const controller = new AbortController();
    const relay = await fixture.adapter.relayConsole('f729c8a1', {
      authorize: async () => true,
      onEvent: (event) => events.push(event),
      signal: controller.signal,
    });
    relays.push(relay);
    controller.abort();
    expect(events).toContainEqual({ type: 'closed' });
  });
});
