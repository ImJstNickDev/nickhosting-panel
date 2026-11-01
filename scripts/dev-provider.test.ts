import { once } from 'node:events';
import { request, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDevProviderHandler,
  createDevProviderServer,
  stopDevProviderServer,
} from '../deploy/dev-provider.mjs';
import { validateConnection } from '../packages/pterodactyl-adapter/src/index.js';

const token = 'isolated-development-sandbox-test-token-only';

describe('development-only empty provider sandbox', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createDevProviderServer(token);
    expect(server.listening).toBe(false);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback test address');
    port = address.port;
  });

  afterAll(async () => stopDevProviderServer(server));

  async function call(
    path: string,
    options: {
      method?: string;
      authorization?: string | string[] | null;
      headers?: Record<string, string>;
    } = {},
  ) {
    return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
      (resolve, reject) => {
        const credentials =
          options.authorization === null
            ? []
            : Array.isArray(options.authorization)
              ? options.authorization
              : [options.authorization ?? `Bearer ${token}`];
        const client = request(
          {
            hostname: '127.0.0.1',
            port,
            path,
            method: options.method ?? 'GET',
            headers: [
              'host',
              `127.0.0.1:${port}`,
              ...credentials.flatMap((value) => ['authorization', value]),
              ...Object.entries(options.headers ?? {}).flat(),
            ],
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
                headers: response.headers,
              }),
            );
          },
        );
        client.once('error', reject);
        client.end();
      },
    );
  }

  it('requires a bounded, header-safe independent local token', () => {
    for (const invalid of ['', 'short', 'x'.repeat(4097), `${'x'.repeat(32)}\n`, ' '.repeat(32)])
      expect(() => createDevProviderHandler(invalid)).toThrow('development sandbox token');
  });

  it('exposes only a GET health check without credentials', async () => {
    const result = await call('/healthz', { authorization: null });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: 'ok', mode: 'empty-inventory-read-only' });
    expect((await call('/healthz?anything=true', { authorization: null })).status).toBe(403);
    expect((await call('/healthz', { method: 'POST', authorization: null })).status).toBe(405);
  });

  it('requires one exact bearer credential for inventory and never echoes secrets', async () => {
    for (const authorization of [
      null,
      'Bearer wrong',
      `bearer ${token}`,
      [`Bearer ${token}`, `Bearer ${token}`],
    ]) {
      const result = await call('/api/application/nodes', { authorization });
      expect(result.status).toBe(403);
      expect(result.body).not.toContain(token);
      expect(result.headers['cache-control']).toBe('no-store');
    }
  });

  it('returns genuine empty list envelopes for every supported read-only collection', async () => {
    for (const path of [
      '/api/application/nodes',
      '/api/application/nests',
      '/api/application/servers',
      '/api/application/users',
      '/api/client',
    ]) {
      const result = await call(`${path}?per_page=1&page=1`);
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        object: 'list',
        data: [],
        meta: {
          pagination: {
            total: 0,
            count: 0,
            per_page: 1,
            current_page: 1,
            total_pages: 1,
            links: {},
          },
        },
      });
      expect(result.headers.connection).toBe('close');
      expect(result.headers['x-nickhosting-dev-sandbox']).toBe('empty-inventory-read-only');
    }
  });

  it('allows the real first-run connection validator without provisioning or seed data', async () => {
    await expect(
      validateConnection({
        baseURL: `http://127.0.0.1:${port}`,
        applicationKey: token,
        clientKey: token,
      }),
    ).resolves.toBeUndefined();
    await expect(
      validateConnection({
        baseURL: `http://127.0.0.1:${port}`,
        applicationKey: token,
        clientKey: 'incorrect-client-key',
      }),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
  });

  it('rejects all mutation methods and never creates resources', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']) {
      const result = await call('/api/application/servers', { method });
      expect(result.status).toBe(405);
      expect(result.headers.allow).toBe('GET');
    }
    expect((await call('/api/application/servers/1')).status).toBe(404);
    expect(JSON.parse((await call('/api/application/servers')).body).data).toEqual([]);
  });

  it('never normalizes weird paths or falls back to unsupported provider operations', async () => {
    for (const path of [
      '/api/application/nodes/1',
      '/api/application/nests/1/eggs',
      '/api/client/servers/example',
      '/api/application/nodes/',
      '/api//application/nodes',
      '//api/application/nodes',
      '/api/application/../application/nodes',
      '/api/application/%6eodes',
      '/api%2fapplication%2fnodes',
      '/api/application/nodes#ignored',
      'http://upstream.invalid/api/application/nodes',
      '/anything',
    ])
      expect((await call(path)).status, path).toBe(404);
  });

  it('rejects invalid pagination, body framing and oversized request headers', async () => {
    for (const query of [
      'page=0',
      'page=1001',
      'page=1&page=2',
      'per_page=101',
      'per_page=0',
      'page=NaN',
      'redirect=https://upstream.invalid',
    ])
      expect((await call(`/api/application/nodes?${query}`)).status, query).toBe(400);
    expect(
      (await call('/api/application/nodes', { headers: { 'content-length': '1' } })).status,
    ).toBe(400);
    expect(
      (await call('/api/application/nodes', { headers: { 'transfer-encoding': 'chunked' } }))
        .status,
    ).toBe(400);
    expect((await call('/healthz', { headers: { 'x-large': 'x'.repeat(9000) } })).status).toBe(431);
    expect(server.headersTimeout).toBe(5000);
    expect(server.requestTimeout).toBe(5000);
    expect(server.maxHeadersCount).toBe(32);
  });

  it('rejects proxy CONNECT and protocol upgrades instead of forwarding', async () => {
    async function rawRequest(target: string) {
      const socket = connect(port, '127.0.0.1');
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      const ended = once(socket, 'end');
      socket.end(target);
      await ended;
      return Buffer.concat(chunks).toString('utf8');
    }
    expect(
      await rawRequest('CONNECT upstream.invalid:443 HTTP/1.1\r\nHost: upstream.invalid\r\n\r\n'),
    ).toContain('405 Method Not Allowed');
    expect(
      await rawRequest(
        'GET /api/client HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      ),
    ).toContain('405 Method Not Allowed');
  });

  it('closes incomplete requests during graceful service shutdown', async () => {
    const isolated = createDevProviderServer(token);
    isolated.listen(0, '127.0.0.1');
    await once(isolated, 'listening');
    const address = isolated.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    let socket: Socket | undefined;
    try {
      socket = connect(address.port, '127.0.0.1');
      await once(socket, 'connect');
      const failures: NodeJS.ErrnoException[] = [];
      socket.on('error', (failure: NodeJS.ErrnoException) => failures.push(failure));
      socket.write('GET /healthz HTTP/1.1\r\n');
      const closed = new Promise<void>((resolve) => socket?.once('close', () => resolve()));
      await stopDevProviderServer(isolated);
      await closed;
      expect(isolated.listening).toBe(false);
      expect(failures.every((failure) => failure.code === 'ECONNRESET')).toBe(true);
    } finally {
      socket?.destroy();
      if (isolated.listening) await stopDevProviderServer(isolated);
    }
  });
});
