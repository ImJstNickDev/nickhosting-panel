import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectTls } from 'node:tls';
import { gzipSync } from 'node:zlib';
import type { GatewayTcpContext } from '@nickhosting/game-sdk';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { SatisfactoryHttpsCache } from './https-cache.js';
import { acceptSatisfactoryHttps } from './https-gateway.js';
import { handleNativeOfflineApi } from './native-api.js';

let directory: string;
let identity: { privateKeyPem: string; certificatePem: string };
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'nh-tls-test-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-keyout',
      join(directory, 'key'),
      '-out',
      join(directory, 'cert'),
    ],
    { stdio: 'ignore' },
  );
  identity = {
    privateKeyPem: readFileSync(join(directory, 'key'), 'utf8'),
    certificatePem: readFileSync(join(directory, 'cert'), 'utf8'),
  };
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function pendingFixture(id: string, budget = 300000, responseGate?: Promise<void>) {
  const received: Array<{ body: string; authorization: string | undefined }> = [];
  const backend = createHttpsServer(
    { key: identity.privateKeyPem, cert: identity.certificatePem },
    (req, res) => {
      let body = '';
      req.on('data', (part) => {
        body += part;
      });
      req.on('end', async () => {
        received.push({ body, authorization: req.headers.authorization });
        if (responseGate) await responseGate;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"data":{"nativeResult":"unchanged-backend-response"}}');
      });
    },
  );
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendAddress = backend.address();
  if (!backendAddress || typeof backendAddress === 'string') throw new Error('bind');
  const controller = new AbortController();
  const state = { online: false, mode: 'waking' };
  const wake = vi.fn(async () => 'waking');
  const beginActivity = vi.fn(() => vi.fn());
  const offline = vi.fn();
  const context = {
    tlsIdentity: async () => identity,
    signal: controller.signal,
    canForward: () => state.online,
    mode: () => state.mode,
    requestWake: wake,
    beginActivity,
    requestOfflineApi: offline,
    backendWaitTimeoutMs: budget,
    route: { serverId: id, backend: { address: '127.0.0.1', port: backendAddress.port } },
  } as unknown as GatewayTcpContext;
  const gateway = createServer((socket) => {
    void acceptSatisfactoryHttps(socket, context);
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const address = gateway.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  return {
    port: address.port,
    state,
    wake,
    beginActivity,
    offline,
    context,
    received,
    controller,
    close: async () => {
      controller.abort();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    },
  };
}

it.each(['online', 'sleeping'] as const)(
  'intercepts namespaced console requests while %s without forwarding or implicit wake',
  async (mode) => {
    const fixture = await pendingFixture(`console-${mode}`);
    fixture.state.mode = mode;
    fixture.state.online = mode === 'online';
    const command = vi.fn<NonNullable<GatewayTcpContext['requestConsoleCommand']>>(async () => ({
      status: 200,
      body: { data: { commandResult: 'Coming Soon :)', returnValue: true } },
    }));
    fixture.context.requestConsoleCommand = command;
    try {
      for (const input of ['nickhosting mods', 'NICKHOSTING status', 'nickhosting']) {
        const response = await exchange(
          fixture.port,
          'RunCommand',
          playerHeaders,
          JSON.stringify({ function: 'RunCommand', data: { Command: input } }),
        );
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toEqual({
          data: { commandResult: 'Coming Soon :)', returnValue: true },
        });
        expect(command).toHaveBeenLastCalledWith({
          operation: 'RunCommand',
          data: { Command: input },
          authorization: playerAuthorization,
          playerId: playerHeaders['X-FactoryGame-PlayerId'],
        });
      }
      expect(fixture.received).toHaveLength(0);
      expect(fixture.wake).not.toHaveBeenCalled();
      expect(fixture.beginActivity).toHaveBeenCalledTimes(mode === 'online' ? 3 : 0);
    } finally {
      await fixture.close();
    }
  },
);
it('keeps native console commands transparent online and returns authenticated offline explanations', async () => {
  const fixture = await pendingFixture('console-native');
  fixture.state.mode = 'online';
  fixture.state.online = true;
  const command = vi.fn<NonNullable<GatewayTcpContext['requestConsoleCommand']>>(async () => ({
    status: 200,
    body: { data: { commandResult: 'The server is sleeping.', returnValue: false } },
  }));
  fixture.context.requestConsoleCommand = command;
  try {
    for (const input of ['server.SaveGame factory', 'nickhostingOther status']) {
      const response = await exchange(
        fixture.port,
        'RunCommand',
        playerHeaders,
        JSON.stringify({ function: 'RunCommand', data: { Command: input } }),
      );
      expect(response.body).toContain('unchanged-backend-response');
    }
    expect(command).not.toHaveBeenCalled();
    fixture.state.mode = 'sleeping';
    fixture.state.online = false;
    const response = await exchange(
      fixture.port,
      'RunCommand',
      playerHeaders,
      JSON.stringify({ function: 'RunCommand', data: { Command: 'server.SaveGame factory' } }),
    );
    expect(JSON.parse(response.body).data.returnValue).toBe(false);
    expect(command).toHaveBeenCalledOnce();
    expect(fixture.wake).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});
it('preserves console auth rejection and never forwards a rejected namespaced command', async () => {
  const fixture = await pendingFixture('console-auth');
  fixture.state.mode = 'online';
  fixture.state.online = true;
  fixture.context.requestConsoleCommand = vi.fn(async () => ({
    status: 403,
    body: { errorCode: 'insufficient_scope' },
  }));
  try {
    const response = await exchange(
      fixture.port,
      'RunCommand',
      playerHeaders,
      JSON.stringify({ function: 'RunCommand', data: { Command: 'nickhosting stop' } }),
    );
    expect(response).toEqual({ status: 403, body: '{"errorCode":"insufficient_scope"}' });
    expect(fixture.received).toHaveLength(0);
    expect(fixture.wake).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});
it('rejects ambiguous console parameters before Core or backend access', async () => {
  const fixture = await pendingFixture('console-invalid');
  fixture.state.mode = 'online';
  fixture.state.online = true;
  const command = vi.fn();
  fixture.context.requestConsoleCommand = command;
  try {
    for (const data of [
      { Command: 'nickhosting start', command: 'nickhosting stop' },
      { Command: 1 },
      {},
    ]) {
      const response = await exchange(
        fixture.port,
        'RunCommand',
        playerHeaders,
        JSON.stringify({ function: 'RunCommand', data }),
      );
      expect(response.status).toBe(400);
    }
    expect(command).not.toHaveBeenCalled();
    expect(fixture.received).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});
it('releases console reply ownership only after sending the native response and strips transport receipts', async () => {
  const fixture = await pendingFixture('console-reply');
  fixture.state.mode = 'online';
  fixture.state.online = true;
  const released = vi.fn();
  fixture.context.beginConsoleReply = () => released;
  fixture.context.requestConsoleCommand = async () => {
    expect(released).not.toHaveBeenCalled();
    return {
      status: 200,
      body: { data: { commandResult: 'Accepted', returnValue: true } },
      transition: { action: 'sleep', previousGeneration: 'old', generation: 'new' },
    };
  };
  try {
    const response = await exchange(
      fixture.port,
      'RunCommand',
      playerHeaders,
      JSON.stringify({ function: 'RunCommand', data: { Command: 'nickhosting stop' } }),
    );
    expect(JSON.parse(response.body)).toEqual({
      data: { commandResult: 'Accepted', returnValue: true },
    });
    expect(released).toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});

it('flushes the TLS console result before closing a detached lifecycle reply socket', async () => {
  const controller = new AbortController();
  let draining = false;
  const server = createServer((socket) => {
    const context = {
      tlsIdentity: async () => identity,
      signal: controller.signal,
      canForward: () => !draining,
      mode: () => (draining ? 'blocked' : 'online'),
      route: { serverId: 'console-tls-drain' },
      beginActivity: () => () => {},
      beginConsoleReply: () => () => socket.destroySoon(),
      consoleReplyOnly: () => draining,
      requestConsoleCommand: async () => {
        draining = true;
        return {
          status: 200,
          body: { data: { commandResult: 'Suspension requested.', returnValue: true } },
        };
      },
    } as unknown as GatewayTcpContext;
    void acceptSatisfactoryHttps(socket, context);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  try {
    const response = await exchange(
      address.port,
      'RunCommand',
      playerHeaders,
      JSON.stringify({ function: 'RunCommand', data: { Command: 'nickhosting stop' } }),
    );
    expect(response).toEqual({
      status: 200,
      body: JSON.stringify({ data: { commandResult: 'Suspension requested.', returnValue: true } }),
    });
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('keeps the original Join alive beyond 25 seconds within the existing Core connection budget', async () => {
  const fixture = await pendingFixture('startup-over-25-seconds');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    fixture.state.mode = 'sleeping';
    let finished = false;
    const body = '{ "function": "JoinGameRequest", "data": {} }';
    const pending = exchange(fixture.port, 'JoinGameRequest', playerHeaders, body).then(
      (result) => {
        finished = true;
        return result;
      },
    );
    await vi.waitFor(() => expect(fixture.wake).toHaveBeenCalledTimes(1));
    fixture.state.mode = 'waking';
    now += 43000;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(finished).toBe(false);
    expect(fixture.received).toHaveLength(0);
    fixture.state.mode = 'online';
    fixture.state.online = true;
    expect((await pending).body).toBe('{"data":{"nativeResult":"unchanged-backend-response"}}');
    expect(fixture.received).toEqual([{ body, authorization: playerAuthorization }]);
    expect(fixture.beginActivity).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
    await fixture.close();
  }
});

it('holds native reads passively during wake and counts activity only when forwarding online', async () => {
  const fixture = await pendingFixture('startup-passive');
  try {
    const requests = ['VerifyAuthenticationToken', 'QueryServerState', 'EnumerateSessions'].map(
      (operation) => exchange(fixture.port, operation, playerHeaders),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fixture.received).toHaveLength(0);
    expect(fixture.beginActivity).not.toHaveBeenCalled();
    fixture.state.mode = 'online';
    fixture.state.online = true;
    expect((await Promise.all(requests)).map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    expect(fixture.wake).not.toHaveBeenCalled();
    expect(fixture.beginActivity).toHaveBeenCalledTimes(3);
    expect(fixture.offline).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});

it.each([
  'HealthCheck',
  'PasswordlessLogin',
  'PasswordLogin',
  'VerifyAuthenticationToken',
  'QueryServerState',
  'EnumerateSessions',
  'GetServerOptions',
  'GetAdvancedGameSettings',
  'ApplyServerOptions',
])('holds activity for an online %s until its backend response finishes', async (operation) => {
  let respond = () => {};
  const gate = new Promise<void>((resolve) => {
    respond = resolve;
  });
  const fixture = await pendingFixture(`online-activity-${operation}`, 300000, gate);
  fixture.state.mode = 'online';
  fixture.state.online = true;
  const release = vi.fn();
  fixture.beginActivity.mockReturnValue(release);
  try {
    const pending = exchange(fixture.port, operation, playerHeaders);
    await vi.waitFor(() => expect(fixture.received).toHaveLength(1));
    expect(fixture.beginActivity).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(fixture.wake).not.toHaveBeenCalled();
    expect(fixture.offline).not.toHaveBeenCalled();
    respond();
    expect((await pending).status).toBe(200);
    expect(release).toHaveBeenCalled();
  } finally {
    respond();
    await fixture.close();
  }
});

it.each(['resolved', 'rejected'])(
  'forwards a passive request after an overlapping wake invalidates its %s offline read',
  async (outcome) => {
    const fixture = await pendingFixture(`startup-offline-race-${outcome}`);
    fixture.state.mode = 'sleeping';
    fixture.offline.mockImplementation(async () => {
      fixture.state.mode = 'waking';
      if (outcome === 'rejected') throw new Error('stopped authority changed');
      return { status: 200, body: { data: { mustNotReplay: true } } };
    });
    try {
      const pending = exchange(fixture.port, 'QueryServerState', playerHeaders);
      await vi.waitFor(() => expect(fixture.offline).toHaveBeenCalledTimes(1));
      expect(fixture.received).toHaveLength(0);
      expect(fixture.beginActivity).not.toHaveBeenCalled();
      fixture.state.mode = 'online';
      fixture.state.online = true;
      expect((await pending).body).toBe('{"data":{"nativeResult":"unchanged-backend-response"}}');
      expect(fixture.wake).not.toHaveBeenCalled();
      expect(fixture.beginActivity).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.close();
    }
  },
);

it.each(['manually_stopped', 'maintenance', 'blocked', 'stopping', 'sleeping'])(
  'stops a passive startup wait when the route changes to %s',
  async (mode) => {
    const fixture = await pendingFixture(`startup-revoked-${mode}`);
    try {
      const pending = exchange(fixture.port, 'QueryServerState', playerHeaders);
      await new Promise((resolve) => setTimeout(resolve, 100));
      fixture.state.mode = mode;
      expect((await pending).status).toBe(503);
      expect(fixture.received).toHaveLength(0);
      expect(fixture.wake).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  },
);

it('honors a shorter Core startup wait budget', async () => {
  const fixture = await pendingFixture('startup-short-budget', 40);
  try {
    expect((await exchange(fixture.port, 'QueryServerState', playerHeaders)).status).toBe(503);
    expect(fixture.received).toHaveLength(0);
    expect(fixture.wake).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});

it('bounds pipelined waiting requests per connection and releases them when authority changes', async () => {
  const fixture = await pendingFixture('startup-pipeline');
  const socket = connectTls({ host: '127.0.0.1', port: fixture.port, rejectUnauthorized: false });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    let received = '';
    socket.on('data', (part) => {
      received += part.toString('utf8');
    });
    const body = '{"function":"QueryServerState"}';
    const wire = `POST /api/v1 HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    socket.write(wire.repeat(9));
    await new Promise((resolve) => setTimeout(resolve, 150));
    fixture.state.mode = 'manually_stopped';
    await vi.waitFor(() => expect([...received.matchAll(/HTTP\/1\.1 (\d+)/g)]).toHaveLength(9));
    const statuses = [...received.matchAll(/HTTP\/1\.1 (\d+)/g)].map((match) => Number(match[1]));
    expect(statuses).toEqual([...Array(8).fill(503), 429]);
    expect(fixture.wake).not.toHaveBeenCalled();
  } finally {
    socket.destroy();
    await fixture.close();
  }
});

it('bounds waits across connections for one server and frees capacity when a client disconnects', async () => {
  const fixture = await pendingFixture('startup-global-capacity');
  // Production supplies a distinct signal per connection; this fixture shares one.
  setMaxListeners(0, fixture.controller.signal);
  const finished = new Map<number, number>();
  const start = (index: number) => {
    let resolveResult: (status: number) => void = () => undefined;
    const result = new Promise<number>((resolve) => {
      resolveResult = resolve;
    });
    const complete = (status: number) => {
      finished.set(index, status);
      resolveResult(status);
    };
    const req = request(
      {
        hostname: '127.0.0.1',
        port: fixture.port,
        path: '/api/v1',
        method: 'POST',
        rejectUnauthorized: false,
        agent: false,
        headers: { 'Content-Type': 'application/json' },
      },
      (response) => {
        response.resume();
        response.on('end', () => complete(response.statusCode ?? 0));
      },
    );
    req.on('error', () => complete(0));
    req.end('{"function":"QueryServerState"}');
    return { req, result };
  };
  const pending = Array.from({ length: 65 }, (_, index) => start(index));
  try {
    await vi.waitFor(() => expect(finished.size).toBe(1), { timeout: 5000 });
    expect([...finished.values()]).toEqual([429]);
    const disconnectIndex = pending.findIndex((_, index) => !finished.has(index));
    const disconnected = pending[disconnectIndex];
    if (!disconnected) throw new Error('missing pending request');
    disconnected.req.destroy();
    expect(await disconnected.result).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const replacement = start(65);
    pending.push(replacement);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(finished.has(65)).toBe(false);
    fixture.state.mode = 'manually_stopped';
    expect(await replacement.result).toBe(503);
    const results = await Promise.all(pending.map((request) => request.result));
    expect(results.filter((status) => status === 429)).toHaveLength(1);
    expect(fixture.wake).not.toHaveBeenCalled();
    expect(fixture.beginActivity).not.toHaveBeenCalled();
  } finally {
    for (const pendingRequest of pending) pendingRequest.req.destroy();
    await fixture.close();
  }
});

it('caps all pending native requests at 128 across different servers and releases the slots', async () => {
  const fixtures = await Promise.all(
    [0, 1, 2].map((index) => pendingFixture(`startup-process-cap-${index}`)),
  );
  for (const fixture of fixtures) setMaxListeners(0, fixture.controller.signal);
  const statuses: number[] = [];
  const pending = Array.from({ length: 129 }, (_, index) => {
    const fixture = fixtures[index % fixtures.length];
    if (!fixture) throw new Error('missing fixture');
    return exchange(fixture.port, 'QueryServerState').then((response) => {
      statuses.push(response.status);
      return response.status;
    });
  });
  try {
    await vi.waitFor(() => expect(statuses).toHaveLength(1), { timeout: 5000 });
    expect(statuses).toEqual([429]);
    for (const fixture of fixtures) fixture.state.mode = 'manually_stopped';
    const results = await Promise.all(pending);
    expect(results.filter((status) => status === 503)).toHaveLength(128);
    const fixture = fixtures[0];
    if (!fixture) throw new Error('missing fixture');
    fixture.state.mode = 'waking';
    let completed = false;
    const replacement = exchange(fixture.port, 'QueryServerState').then((response) => {
      completed = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(completed).toBe(false);
    fixture.state.mode = 'manually_stopped';
    expect((await replacement).status).toBe(503);
    for (const fixture of fixtures) {
      expect(fixture.wake).not.toHaveBeenCalled();
      expect(fixture.beginActivity).not.toHaveBeenCalled();
    }
  } finally {
    for (const fixture of fixtures) fixture.controller.abort();
    await Promise.allSettled(pending);
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
});

it.each(['QueryServerState', 'JoinGameRequest'])(
  'rejects an oversized %s before reserving a pending slot or requesting wake',
  async (operation) => {
    const fixture = await pendingFixture(`startup-oversized-${operation}`);
    try {
      const payload = `${' '.repeat(64 * 1024)}{"function":"${operation}"}`;
      const response = await exchange(fixture.port, operation, playerHeaders, payload);
      expect(response.status).toBe(413);
      expect(fixture.wake).not.toHaveBeenCalled();
      expect(fixture.beginActivity).not.toHaveBeenCalled();
      expect(fixture.offline).not.toHaveBeenCalled();
      expect(fixture.received).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  },
);

it('captures compressed native session observations while forwarding their original response bytes', async () => {
  const body = '{"data":{"sessions":[],"currentSessionIndex":-1}}';
  const compressed = gzipSync(body);
  const backend = createHttpsServer(
    { key: identity.privateKeyPem, cert: identity.certificatePem },
    (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Content-Length': compressed.length,
        });
        res.end(compressed);
      });
    },
  );
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  const controller = new AbortController(),
    save = vi.fn(async (_state: unknown) => undefined);
  const context = {
    tlsIdentity: async () => identity,
    signal: controller.signal,
    canForward: () => true,
    savePrivateState: save,
    route: {
      serverId: 'compressed-native-observation',
      backend: { address: '127.0.0.1', port: address.port },
    },
  } as unknown as GatewayTcpContext;
  const gateway = createServer((socket) => {
    void acceptSatisfactoryHttps(socket, context);
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const publicAddress = gateway.address();
  if (!publicAddress || typeof publicAddress === 'string') throw new Error('bind');
  try {
    const received = await new Promise<{ body: Buffer; encoding: string | undefined }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: publicAddress.port,
            path: '/api/v1',
            method: 'POST',
            agent: false,
            rejectUnauthorized: false,
            headers: { 'Content-Type': 'application/json', ...playerHeaders },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () =>
              resolve({ body: Buffer.concat(chunks), encoding: res.headers['content-encoding'] }),
            );
          },
        );
        req.on('error', reject);
        req.end('{"function":"EnumerateSessions"}');
      },
    );
    expect(received).toEqual({ body: compressed, encoding: 'gzip' });
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(JSON.stringify(save.mock.lastCall?.[0])).toContain(JSON.stringify(body));
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});
it('authenticates native players and serves protected status while sleeping without any wake', async () => {
  const password = 'Pässword🔐';
  const credentials = {
    build: 513885,
    serverName: 'Synthetic',
    serverSecret: '01'.repeat(256),
    adminPassword: {
      salt: 'ab'.repeat(32),
      hash: createHash('sha512')
        .update(Buffer.alloc(32, 0xab))
        .update(password, 'utf8')
        .digest('hex')
        .toUpperCase(),
    },
  };
  const wake = vi.fn();
  const offline = vi.fn<NonNullable<GatewayTcpContext['requestOfflineApi']>>(async (input) =>
    handleNativeOfflineApi(credentials, input, () => ({
      data: { serverGameState: { activeSessionName: 'Observed world' } },
    })),
  );
  const controller = new AbortController();
  let mode = 'sleeping';
  const context = {
    tlsIdentity: async () => identity,
    signal: controller.signal,
    canForward: () => false,
    requestWake: wake,
    requestOfflineApi: offline,
    mode: () => mode,
    route: { serverId: 'native-offline-test', wakeEnabled: true },
  } as unknown as GatewayTcpContext;
  const server = createServer((socket) => {
    void acceptSatisfactoryHttps(socket, context);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  const player = '0601100001aabbccdd';
  const headers = {
    'X-FactoryGame-PlayerId': player,
    'Content-Type': 'application/json; charset=utf-8',
  };
  try {
    const login = await exchange(
      address.port,
      'PasswordlessLogin',
      headers,
      JSON.stringify({ function: 'PasswordlessLogin', data: { MinimumPrivilegeLevel: 'Client' } }),
    );
    const token = JSON.parse(login.body).data.authenticationToken as string;
    expect(login.status).toBe(200);
    const verified = await exchange(
      address.port,
      'VerifyAuthenticationToken',
      headers,
      JSON.stringify({
        function: 'VerifyAuthenticationToken',
        data: { PrivilegeLevel: 'Client', AuthenticationToken: token.split('.')[1] },
      }),
    );
    expect(verified).toEqual({ status: 204, body: '' });
    expect(
      (
        await exchange(address.port, 'QueryServerState', {
          ...headers,
          Authorization: `Bearer ${token}`,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await exchange(address.port, 'QueryServerState', {
          ...headers,
          Authorization: 'Bearer invalid',
        })
      ).status,
    ).toBe(401);
    const body = JSON.stringify({
      function: 'PasswordLogin',
      data: { MinimumPrivilegeLevel: 'Administrator', Password: password },
    });
    expect(
      JSON.parse((await exchange(address.port, 'PasswordLogin', headers, body)).body).data
        .authenticationToken,
    ).toBeTypeOf('string');
    // Native missing-charset decoding is Latin1; escaped JSON remains lossless.
    expect(
      JSON.parse(
        (
          await exchange(
            address.port,
            'PasswordLogin',
            { ...headers, 'Content-Type': 'application/json' },
            body,
          )
        ).body,
      ).errorCode,
    ).toBe('wrong_password');
    const escaped = body.replace(
      /[\u0080-\uFFFF]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    expect(
      JSON.parse(
        (
          await exchange(
            address.port,
            'PasswordLogin',
            { ...headers, 'Content-Type': 'application/json' },
            escaped,
          )
        ).body,
      ).data.authenticationToken,
    ).toBeTypeOf('string');
    const count = offline.mock.calls.length;
    mode = 'manually_stopped';
    expect(
      (
        await exchange(address.port, 'QueryServerState', {
          ...headers,
          Authorization: `Bearer ${token}`,
        })
      ).status,
    ).toBe(503);
    expect(offline).toHaveBeenCalledTimes(count);
    expect(wake).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function exchange(
  port: number,
  fn: string,
  headers?: Record<string, string | string[]>,
  payload?: string,
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1',
        headers: { 'Content-Type': 'application/json', ...headers },
        method: 'POST',
        rejectUnauthorized: false,
        agent: false,
      },
      (res) => {
        let body = '';
        res.on('data', (part) => {
          body += part;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(payload ?? JSON.stringify({ function: fn }));
  });
}
it('answers health without waking and never manufactures login tokens', async () => {
  const wake = vi.fn();
  const diagnostics = vi.fn();
  const controller = new AbortController();
  const context = {
    tlsIdentity: async () => identity,
    signal: controller.signal,
    canForward: () => false,
    requestWake: wake,
    onApiDiagnostic: diagnostics,
  } as unknown as GatewayTcpContext;
  const server = createServer((socket) => {
    void acceptSatisfactoryHttps(socket, context);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  try {
    const health = await exchange(address.port, 'HealthCheck');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).data.health).toBe('slow');
    const login = await exchange(address.port, 'PasswordlessLogin');
    expect(login.status).toBe(503);
    expect(login.body).not.toContain('authenticationToken');
    const secret = 'credential-must-not-appear';
    expect(
      (await exchange(address.port, secret, { Authorization: `Bearer ${secret}` })).status,
    ).toBe(503);
    expect(diagnostics.mock.calls.map(([event]) => event)).toEqual([
      { operation: 'HealthCheck', outcome: 'health' },
      { operation: 'PasswordlessLogin', outcome: 'unavailable' },
      { operation: 'other', outcome: 'unavailable' },
    ]);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(secret);
    diagnostics.mockImplementation(() => {
      throw new Error('diagnostic sink failed');
    });
    expect((await exchange(address.port, 'HealthCheck')).status).toBe(200);
    expect(wake).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('forwards backend responses with the pinned per-server identity', async () => {
  const received = vi.fn();
  const releaseForwarding = vi.fn();
  const beginForwarding = vi.fn<() => (() => void) | undefined>(() => releaseForwarding);
  const backend = createHttpsServer(
    { key: identity.privateKeyPem, cert: identity.certificatePem },
    (req, res) => {
      received();
      req.resume();
      req.on('end', () => {
        res.writeHead(200);
        res.end('{"data":{"backend":true}}');
      });
    },
  );
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  const controller = new AbortController();
  const context = {
    tlsIdentity: async () => identity,
    signal: controller.signal,
    canForward: () => true,
    beginForwarding,
    route: { backend: { address: '127.0.0.1', port: address.port } },
  } as unknown as GatewayTcpContext;
  const server = createServer((socket) => {
    void acceptSatisfactoryHttps(socket, context);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const gateway = server.address();
  if (!gateway || typeof gateway === 'string') throw new Error('bind');
  try {
    expect((await exchange(gateway.port, 'QueryServerState')).body).toBe(
      '{"data":{"backend":true}}',
    );
    expect(beginForwarding).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(releaseForwarding).toHaveBeenCalledOnce());
    beginForwarding.mockReturnValue(undefined);
    expect((await exchange(gateway.port, 'QueryServerState')).status).toBe(503);
    expect(received).toHaveBeenCalledOnce();
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});
it('does not send an HTTP request to a backend presenting another certificate', async () => {
  const other = mkdtempSync(join(tmpdir(), 'nh-tls-other-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=other',
      '-keyout',
      join(other, 'key'),
      '-out',
      join(other, 'cert'),
    ],
    { stdio: 'ignore' },
  );
  const received = vi.fn();
  const backend = createHttpsServer(
    { key: readFileSync(join(other, 'key')), cert: readFileSync(join(other, 'cert')) },
    received,
  );
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  const controller = new AbortController();
  const context = {
    tlsIdentity: async () => identity,
    signal: controller.signal,
    canForward: () => true,
    route: { backend: { address: '127.0.0.1', port: address.port } },
  } as unknown as GatewayTcpContext;
  const server = createServer((socket) => {
    void acceptSatisfactoryHttps(socket, context);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const gateway = server.address();
  if (!gateway || typeof gateway === 'string') throw new Error('bind');
  try {
    expect((await exchange(gateway.port, 'PasswordLogin')).status).toBe(502);
    expect(received).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    rmSync(other, { recursive: true, force: true });
  }
});

it('counts online polling, keeps offline polling passive and obtains join tickets only from the backend', async () => {
  const authorization = `Bearer ${Buffer.from(JSON.stringify({ pl: 'Client' })).toString('base64')}.${'ab'.repeat(64)}`;
  const seen: string[] = [];
  const backend = createHttpsServer(
    { key: identity.privateKeyPem, cert: identity.certificatePem },
    (req, res) => {
      let raw = '';
      req.on('data', (part) => {
        raw += part;
      });
      req.on('end', () => {
        const fn = JSON.parse(raw).function;
        seen.push(fn);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data:
              fn === 'JoinGameRequest'
                ? { serverJoinData: { encryptionToken: 'backend-ticket' } }
                : { serverGameState: { numConnectedPlayers: 0 } },
          }),
        );
      });
    },
  );
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  let online = true;
  const wake = vi.fn(async () => {
    online = true;
    return 'online';
  });
  let fenced = false;
  let activeRequests = 0;
  const beginActivity = vi.fn(() => {
    if (fenced) return undefined;
    activeRequests++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeRequests--;
    };
  });
  const controller = new AbortController();
  const context = {
    tlsIdentity: async () => identity,
    signal: controller.signal,
    canForward: () => online,
    requestWake: wake,
    beginActivity,
    route: { serverId: 'test-join', backend: { address: '127.0.0.1', port: address.port } },
  } as unknown as GatewayTcpContext;
  const server = createServer((socket) => {
    void acceptSatisfactoryHttps(socket, context);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const publicAddress = server.address();
  if (!publicAddress || typeof publicAddress === 'string') throw new Error('bind');
  try {
    await exchange(publicAddress.port, 'QueryServerState', { authorization });
    online = false;
    const cached = await exchange(publicAddress.port, 'QueryServerState', { authorization });
    expect(cached.status).toBe(503);
    expect(wake).not.toHaveBeenCalled();
    expect((await exchange(publicAddress.port, 'JoinGameRequest')).status).toBe(503);
    expect(wake).not.toHaveBeenCalled();
    expect(beginActivity).toHaveBeenCalledTimes(1);
    const joined = await exchange(publicAddress.port, 'JoinGameRequest', {
      authorization,
      'X-FactoryGame-PlayerId': '060102',
    });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(joined.body).toContain('backend-ticket');
    expect(seen).toEqual(['QueryServerState', 'JoinGameRequest']);
    expect(beginActivity).toHaveBeenCalledTimes(2);
    expect(activeRequests).toBe(0);
    await exchange(publicAddress.port, 'ApplyServerOptions', { authorization });
    expect(beginActivity).toHaveBeenCalledTimes(3);
    expect(activeRequests).toBe(0);
    fenced = true;
    expect((await exchange(publicAddress.port, 'QueryServerState', { authorization })).status).toBe(
      503,
    );
    expect(seen).toEqual(['QueryServerState', 'JoinGameRequest', 'ApplyServerOptions']);
    expect(activeRequests).toBe(0);
    online = false;
    expect(
      (
        await exchange(publicAddress.port, 'JoinGameRequest', {
          authorization,
          'X-FactoryGame-PlayerId': '060102',
        })
      ).status,
    ).toBe(503);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(activeRequests).toBe(0);
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});

const playerAuthorization = `Bearer ${Buffer.from('{"pl":"Client"}').toString('base64')}.${'ab'.repeat(64)}`;
const playerHeaders = {
  Authorization: playerAuthorization,
  'X-FactoryGame-PlayerId': '060102',
};

it.each(['cold', 'expired', 'rejected'] as const)(
  'classifies %s-cache join as intent and leaves authentication to the backend',
  async (scenario) => {
    let received:
      | { body: string; authorization: string | undefined; playerId: string | string[] | undefined }
      | undefined;
    const backend = createHttpsServer(
      { key: identity.privateKeyPem, cert: identity.certificatePem },
      (req, res) => {
        let body = '';
        req.on('data', (part) => {
          body += part;
        });
        req.on('end', () => {
          received = {
            body,
            authorization: req.headers.authorization,
            playerId: req.headers['x-factorygame-playerid'],
          };
          res.writeHead(scenario === 'rejected' ? 401 : 200, {
            'Content-Type': 'application/json',
          });
          res.end(
            scenario === 'rejected'
              ? '{"errorCode":"invalid_token"}'
              : '{"data":{"serverJoinData":{"encryptionToken":"backend-only-ticket"}}}',
          );
        });
      },
    );
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    const backendAddress = backend.address();
    if (!backendAddress || typeof backendAddress === 'string') throw new Error('bind');
    let online = false;
    const wake = vi.fn(async () => {
      online = true;
      return 'online';
    });
    const expired = new SatisfactoryHttpsCache(() => 0);
    expired.remember(
      'QueryServerState',
      playerAuthorization,
      '060102',
      '{"data":{"serverGameState":{}}}',
    );
    const controller = new AbortController();
    const context = {
      tlsIdentity: async () => identity,
      signal: controller.signal,
      canForward: () => online,
      requestWake: wake,
      loadPrivateState: async () => (scenario === 'expired' ? expired.snapshot() : []),
      route: {
        serverId: `test-${scenario}`,
        backend: { address: '127.0.0.1', port: backendAddress.port },
      },
    } as unknown as GatewayTcpContext;
    const gateway = createServer((socket) => {
      void acceptSatisfactoryHttps(socket, context);
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const address = gateway.address();
    if (!address || typeof address === 'string') throw new Error('bind');
    try {
      const body = '{ "function": "JoinGameRequest", "data": {} }';
      const response = await exchange(address.port, 'JoinGameRequest', playerHeaders, body);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(received).toEqual({ body, authorization: playerAuthorization, playerId: '060102' });
      expect(response.status).toBe(scenario === 'rejected' ? 401 : 200);
      expect(response.body).toBe(
        scenario === 'rejected'
          ? '{"errorCode":"invalid_token"}'
          : '{"data":{"serverJoinData":{"encryptionToken":"backend-only-ticket"}}}',
      );
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
  },
);

it('never wakes for polling, login, malformed joins or ambiguous headers', async () => {
  const wake = vi.fn(async () => 'blocked');
  const controller = new AbortController();
  const context = {
    tlsIdentity: async () => identity,
    signal: controller.signal,
    canForward: () => false,
    requestWake: wake,
    route: { serverId: 'malformed-joins' },
  } as unknown as GatewayTcpContext;
  const server = createServer((socket) => {
    void acceptSatisfactoryHttps(socket, context);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind');
  try {
    for (const fn of [
      'HealthCheck',
      'QueryServerState',
      'PasswordLogin',
      'PasswordlessLogin',
      'VerifyAuthenticationToken',
    ])
      await exchange(address.port, fn, playerHeaders);
    const headers: Record<string, string | string[]>[] = [
      { ...playerHeaders, Authorization: '' },
      {
        ...playerHeaders,
        Authorization: `Bearer ${Buffer.from('{"pl":"APIToken"}').toString('base64')}.${'ab'.repeat(64)}`,
      },
      { ...playerHeaders, Authorization: 'Bearer malformed' },
      { ...playerHeaders, Authorization: [playerAuthorization, playerAuthorization] },
      { ...playerHeaders, 'X-FactoryGame-PlayerId': ['060102', '060102'] },
      { ...playerHeaders, 'X-FactoryGame-PlayerId': '' },
      { ...playerHeaders, 'X-FactoryGame-PlayerId': '123' },
      { ...playerHeaders, 'X-FactoryGame-PlayerId': 'not-hex' },
      { ...playerHeaders, 'Content-Type': 'text/plain' },
      { ...playerHeaders, 'Content-Type': ['application/json', 'application/json'] },
      { ...playerHeaders, 'Content-Encoding': 'identity' },
    ];
    for (const input of headers) {
      const response = await exchange(address.port, 'JoinGameRequest', input);
      expect(response.status).toBe(503);
    }
    for (const body of [
      '{"function":"JoinGameRequest","data":{"token":"invented"}}',
      '{"function":"JoinGameRequest","ticket":"invented"}',
      '{"function":"JoinGameRequest","data":null}',
      '{"function":"JoinGameRequest","data":[]}',
      'null',
      '{broken',
    ]) {
      expect((await exchange(address.port, 'JoinGameRequest', playerHeaders, body)).status).toBe(
        503,
      );
    }
    expect(wake).not.toHaveBeenCalled();
    // Even a legitimate intent cannot bypass Core's manual-stop/admission decision.
    expect((await exchange(address.port, 'JoinGameRequest', playerHeaders)).status).toBe(503);
    expect(wake).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
