import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createGatewayControlClient, GatewayRouteRevisionStaleError } from './control-client.js';

const gatewayId = randomUUID();
const token = 'a'.repeat(43);
const settings = {
  baseUrl: 'https://core.example.test',
  gatewayId,
  token,
  requestTimeoutMs: 1000,
  maxResponseBytes: 100000,
};
const snapshot = {
  gatewayId,
  revision: 1,
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 10000).toISOString(),
  routes: [],
};

describe('authenticated bounded Gateway control client', () => {
  it.each(['context', 'proof-read', 'proof-write'])(
    'recognizes only authenticated explicit revision preconditions for %s',
    async (action) => {
      const client = createGatewayControlClient({
        ...settings,
        fetcher: vi.fn(async () =>
          Response.json(
            {
              error: {
                code: 'conflict',
                messageKey: 'errors.conflict',
                status: 412,
                message: 'The requested state has changed.',
              },
            },
            { status: 412 },
          ),
        ),
      });
      await expect(
        client.requestJson(action, {
          routeId: randomUUID(),
          routeRevision: 1,
          ...(action === 'proof-write' ? { proof: {} } : {}),
        }),
      ).rejects.toBeInstanceOf(GatewayRouteRevisionStaleError);
    },
  );
  it.each([
    {
      action: 'context',
      status: 409,
      body: '{"error":{"code":"conflict","messageKey":"errors.conflict"}}',
    },
    { action: 'context', status: 412, body: 'not JSON' },
    { action: 'context', status: 412, body: '{}' },
    {
      action: 'context',
      status: 412,
      body: '{"error":{"code":"provenance_mismatch","messageKey":"errors.provenance_mismatch"}}',
    },
    {
      action: 'snapshot',
      status: 412,
      body: '{"error":{"code":"conflict","messageKey":"errors.conflict"}}',
    },
    {
      action: 'wake',
      status: 412,
      body: '{"error":{"code":"conflict","messageKey":"errors.conflict"}}',
    },
    {
      action: 'inventory',
      status: 412,
      body: '{"error":{"code":"conflict","messageKey":"errors.conflict"}}',
    },
  ])(
    'does not classify unrelated or malformed errors as stale: $action/$status/$body',
    async ({ action, status, body }) => {
      const client = createGatewayControlClient({
        ...settings,
        fetcher: vi.fn(async () => new Response(body, { status })),
      });
      await expect(
        client.requestJson(action, { routeId: randomUUID(), routeRevision: 1 }),
      ).rejects.toThrow(/^integration_unavailable$/);
    },
  );
  it('requires an explicit revision and bounds even a valid 412 error body', async () => {
    const error = { error: { code: 'conflict', messageKey: 'errors.conflict' } };
    const client = createGatewayControlClient({
      ...settings,
      fetcher: vi.fn(async () => Response.json(error, { status: 412 })),
    });
    await expect(client.requestJson('context', { routeId: randomUUID() })).rejects.toThrow(
      /^integration_unavailable$/,
    );
    const bounded = createGatewayControlClient({
      ...settings,
      maxResponseBytes: 20,
      fetcher: vi.fn(async () => Response.json(error, { status: 412 })),
    });
    await expect(
      bounded.requestJson('context', { routeId: randomUUID(), routeRevision: 1 }),
    ).rejects.toThrow(/^integration_unavailable$/);
  });
  it('validates authenticated snapshot, wake and observation contracts with redirect refusal', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json({ mode: 'waking', operationId: randomUUID() }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createGatewayControlClient({ ...settings, fetcher });
    expect(await client.fetchSnapshot()).toEqual(snapshot);
    const wake = { routeId: randomUUID(), routeRevision: 3, requestId: randomUUID() };
    expect(await client.requestWake(wake)).toMatchObject({ mode: 'waking' });
    const observation = {
      routeId: wake.routeId,
      routeRevision: 3,
      routes: [{ routeId: wake.routeId, routeRevision: 3 }],
      generation: randomUUID(),
      observedAt: new Date().toISOString(),
      ready: false,
      activeSessions: 0,
    };
    await client.reportObservation(observation);
    expect(fetcher.mock.calls[0]?.[0].toString()).toBe(
      `https://core.example.test/internal/gateway/${gatewayId}/snapshot`,
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
    });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(wake),
    });
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ body: JSON.stringify(observation) });
  });
  it.each([
    'http://core.example.test',
    'http://localhost',
    'http://192.0.2.1',
    'ftp://core.example.test',
    'https://user:password@core.example.test',
    'https://core.example.test?token=secret',
    'https://core.example.test#fragment',
  ])('rejects credential-unsafe base URL %s', (baseUrl) => {
    expect(() => createGatewayControlClient({ ...settings, baseUrl })).toThrow(
      'configuration_invalid',
    );
  });
  it.each(['http://127.0.0.1', 'http://127.0.0.2', 'http://[::1]'])(
    'permits explicit numerical loopback IPC %s',
    (baseUrl) => {
      expect(() => createGatewayControlClient({ ...settings, baseUrl })).not.toThrow();
    },
  );
  it('refuses malformed/wrong-identity snapshots and provider error bodies without disclosing them', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...snapshot, gatewayId: randomUUID() }))
      .mockResolvedValueOnce(Response.json({ ...snapshot, unexpected: true }))
      .mockResolvedValueOnce(new Response('Bearer sensitive-provider-key', { status: 403 }));
    const client = createGatewayControlClient({ ...settings, fetcher });
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(client.fetchSnapshot()).rejects.toThrow(/^integration_unavailable$/);
  });
  it('bounds streamed bodies even when content length is absent or false', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        canceled = true;
      },
    });
    const client = createGatewayControlClient({
      ...settings,
      maxResponseBytes: 512,
      fetcher: vi.fn(async () => new Response(stream, { headers: { 'Content-Length': '1' } })),
    });
    await expect(client.fetchSnapshot()).rejects.toThrow('integration_unavailable');
    expect(canceled).toBe(true);
  });
  it('validates request payloads and confines authenticated generic requests to a single action segment', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createGatewayControlClient({ ...settings, fetcher });
    await expect(
      client.requestWake({ routeId: 'invalid', routeRevision: 1, requestId: randomUUID() }),
    ).rejects.toThrow('validation_failed');
    await expect(client.requestJson('../leak')).rejects.toThrow('validation_failed');
    await expect(client.requestJson('http://external.example')).rejects.toThrow(
      'validation_failed',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses real HTTP redirects and bounds a stalled response from loopback Core', async () => {
    let leaked = false;
    const server = createServer((request, response) => {
      if (request.url?.endsWith('/snapshot')) {
        response.writeHead(302, { Location: '/leak' });
        response.end();
      } else if (request.url === '/leak') {
        leaked = true;
        response.end('{}');
      } else {
        response.writeHead(200);
        response.write('{');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture address');
    try {
      const client = createGatewayControlClient({
        ...settings,
        baseUrl: `http://127.0.0.1:${address.port}`,
        requestTimeoutMs: 50,
      });
      await expect(client.fetchSnapshot()).rejects.toThrow('integration_unavailable');
      expect(leaked).toBe(false);
      await expect(client.requestJson('stalled')).rejects.toThrow('integration_unavailable');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('aborts in-flight authenticated requests and rejects further requests after shutdown', async () => {
    let aborted = false;
    const fetcher: typeof fetch = async (_, options) =>
      new Promise<Response>((_, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    const client = createGatewayControlClient({ ...settings, fetcher });
    const pending = client.fetchSnapshot();
    client.close();
    await expect(pending).rejects.toThrow('integration_unavailable');
    expect(aborted).toBe(true);
    await expect(client.requestJson('snapshot')).rejects.toThrow('integration_unavailable');
  });
});
