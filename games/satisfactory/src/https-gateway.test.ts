import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayTcpContext } from '@nickhosting/game-sdk';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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
async function exchange(port: number, fn: string, headers?: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1',
        headers,
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
    req.end(JSON.stringify({ function: fn }));
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
  const backend = createHttpsServer(
    { key: identity.privateKeyPem, cert: identity.certificatePem },
    (req, res) => {
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

it('wakes only on a proven player JoinGameRequest and obtains tickets from the backend', async () => {
  const authorization = `Bearer ${Buffer.from(JSON.stringify({ pl: 'Client' })).toString('base64')}.verified`;
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
  const controller = new AbortController();
  const context = {
    tlsIdentity: async () => identity,
    signal: controller.signal,
    canForward: () => online,
    requestWake: wake,
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
    const joined = await exchange(publicAddress.port, 'JoinGameRequest', {
      authorization,
      'X-FactoryGame-PlayerId': '060102',
    });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(joined.body).toContain('backend-ticket');
    expect(seen).toEqual(['QueryServerState', 'JoinGameRequest']);
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});
