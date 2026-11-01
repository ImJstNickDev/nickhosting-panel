import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayTcpContext } from '@nickhosting/game-sdk';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { SatisfactoryHttpsCache } from './https-cache.js';
import { acceptSatisfactoryHttps } from './https-gateway.js';

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
  const controller = new AbortController();
  const context = {
    tlsIdentity: async () => identity,
    signal: controller.signal,
    canForward: () => false,
    requestWake: wake,
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

it('keeps polling passive and obtains join tickets only from the backend', async () => {
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
    expect(cached.status).toBe(200);
    expect(wake).not.toHaveBeenCalled();
    expect((await exchange(publicAddress.port, 'JoinGameRequest')).status).toBe(503);
    expect(wake).not.toHaveBeenCalled();
    expect(beginActivity).not.toHaveBeenCalled();
    const joined = await exchange(publicAddress.port, 'JoinGameRequest', {
      authorization,
      'X-FactoryGame-PlayerId': '060102',
    });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(joined.body).toContain('backend-ticket');
    expect(seen).toEqual(['QueryServerState', 'JoinGameRequest']);
    expect(beginActivity).toHaveBeenCalledTimes(1);
    expect(activeRequests).toBe(0);
    await exchange(publicAddress.port, 'ApplyServerOptions', { authorization });
    expect(beginActivity).toHaveBeenCalledTimes(2);
    expect(activeRequests).toBe(0);
    online = false;
    fenced = true;
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
