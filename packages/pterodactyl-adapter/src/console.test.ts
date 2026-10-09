import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { createPterodactylAdapter } from './adapter.js';
import type { ConsoleEvent, ConsoleRelay } from './console.js';

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
    String(url).endsWith('/websocket')
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
    incoming,
    origins,
    send(event: string, args: unknown[]) {
      if (!connected) throw new Error('not connected');
      connected.send(JSON.stringify({ event, args }));
    },
  };
}

describe('backend console mediation over a real isolated WebSocket', () => {
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
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events).toEqual([
      { type: 'console', data: 'server ready [redacted] [redacted]' },
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
