import {
  Agent,
  type ClientRequest,
  request as httpRequest,
  type RequestListener,
  type Server,
} from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { getRequestListener } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiHttpServer, type HttpServerPolicy, httpServerPolicy } from './http-server.js';

const upload = '/v1/servers/a64e1f2c-99bb-4ab6-8812-382196f03eba/files/upload?path=world.zip';
const servers: Server[] = [];
const clients: ClientRequest[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listen(listener: RequestListener, policy: Partial<HttpServerPolicy> = {}) {
  const server = createApiHttpServer(listener, {
    ordinaryBodyDeadlineMs: 80,
    idleTimeoutMs: 300,
    headersDeadlineMs: 80,
    connectionsCheckingIntervalMs: 10,
    ...policy,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return { server, port: address.port };
}
const collect: RequestListener = (incoming, outgoing) => {
  let bytes = 0;
  incoming.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  incoming.once('end', () => outgoing.end(String(bytes)));
};
function client(
  port: number,
  path: string,
  method = 'PUT',
  length = 6,
  agent: Agent | false = false,
) {
  const { promise: result, resolve } = Promise.withResolvers<{
    status?: number;
    body?: string;
    error?: string;
  }>();
  const outgoing = httpRequest(
    {
      host: '127.0.0.1',
      port,
      path,
      method,
      agent,
      headers: { 'Content-Length': length, 'Content-Type': 'application/octet-stream' },
    },
    (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.once('end', () => resolve({ status: response.statusCode, body }));
      response.once('error', () => resolve({ error: 'response_closed' }));
    },
  );
  outgoing.once('error', (error: NodeJS.ErrnoException) =>
    resolve({ error: error.code ?? 'closed' }),
  );
  outgoing.flushHeaders();
  clients.push(outgoing);
  return { outgoing, result };
}

describe('Node HTTP request deadlines', () => {
  it('lets an actively progressing binary upload exceed the ordinary total-body deadline', async () => {
    const { server, port } = await listen(collect);
    const { outgoing, result } = client(port, upload);
    for (let i = 0; i < 6; i++) {
      outgoing.write(Buffer.from([i]));
      await delay(40);
    }
    outgoing.end();
    expect(await result).toEqual({ status: 200, body: '6' });
    expect(server.requestTimeout).toBe(0);
    expect(server.headersTimeout).toBe(80);
    expect(server.timeout).toBe(300);
  });

  it('closes a stalled upload and aborts the backend request signal', async () => {
    let aborted = false;
    let received = false;
    const handler = getRequestListener(async (request) => {
      received = true;
      request.signal.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        { once: true },
      );
      try {
        await request.arrayBuffer();
        return new Response('complete');
      } catch {
        return new Response(null, { status: 499 });
      }
    });
    const { port } = await listen(handler, { idleTimeoutMs: 100 });
    const { outgoing, result } = client(port, upload);
    outgoing.write('a');
    expect(await result).toHaveProperty('error');
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(received).toBe(true);
  });

  it.each([
    ['POST', upload],
    ['PUT', '/v1/servers/a64e1f2c-99bb-4ab6-8812-382196f03eba/files'],
    ['PUT', '/v1/servers/not-a-uuid/files/upload'],
    ['PUT', '/v1/servers/a64e1f2c-99bb-4ab6-8812-382196f03eba/files/upload/extra'],
  ])(
    'keeps an ordinary total-body deadline for %s %s even while bytes progress',
    async (method, path) => {
      const { port } = await listen(collect);
      const { outgoing, result } = client(port, path, method, 1000);
      const progress = setInterval(() => outgoing.write('a'), 20);
      try {
        expect(await result).toMatchObject({ status: 408 });
      } finally {
        clearInterval(progress);
      }
    },
  );

  it('retains a header deadline even when a client keeps trickling header bytes', async () => {
    const handler = vi.fn(collect);
    const { port } = await listen(handler);
    const socket = connect(port, '127.0.0.1');
    let body = '';
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.on('data', (data: Buffer) => {
      body += data.toString();
    });
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(`PUT ${upload} HTTP/1.1\r\nHost: fixture\r\nX-Slow: `);
    const progress = setInterval(() => socket.write('a'), 20);
    try {
      await closed;
      expect(body).toContain('408 Request Timeout');
      expect(handler).not.toHaveBeenCalled();
    } finally {
      clearInterval(progress);
      socket.destroy();
    }
  });

  it('closes an early rejected upload with an unread body instead of draining it indefinitely', async () => {
    const { port } = await listen((_incoming, outgoing) => {
      outgoing.writeHead(403);
      outgoing.end();
    });
    const { outgoing, result } = client(port, upload, 'PUT', 1000000);
    outgoing.write('a');
    expect(await result).toMatchObject({ status: 403 });
    await vi.waitFor(() => expect(outgoing.destroyed).toBe(true));
  });

  it('does not carry an upload exemption into the next request on a keepalive connection', async () => {
    const { port } = await listen(collect);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const first = client(port, upload, 'PUT', 1, agent);
      let firstSocket: unknown;
      first.outgoing.once('socket', (socket) => {
        firstSocket = socket;
      });
      first.outgoing.end('a');
      expect(await first.result).toEqual({ status: 200, body: '1' });
      const second = client(port, '/v1/owner/settings', 'POST', 1000, agent);
      let secondSocket: unknown;
      second.outgoing.once('socket', (socket) => {
        secondSocket = socket;
      });
      const progress = setInterval(() => second.outgoing.write('a'), 20);
      try {
        expect(await second.result).toMatchObject({ status: 408 });
        expect(firstSocket).toBeDefined();
        expect(secondSocket).toBe(firstSocket);
      } finally {
        clearInterval(progress);
      }
    } finally {
      agent.destroy();
    }
  });

  it('clears the body deadline when the body finishes so a longer response can stream', async () => {
    const { port } = await listen((incoming, outgoing) => {
      incoming.resume();
      incoming.once('end', () => {
        setTimeout(() => outgoing.end('response'), 200);
      });
    });
    const { outgoing, result } = client(port, '/v1/servers', 'POST', 1);
    outgoing.end('a');
    expect(await result).toEqual({ status: 200, body: 'response' });
  });

  it('propagates client disconnect to the backend without waiting for a timeout', async () => {
    let aborted = false;
    let received = false;
    const { port } = await listen(
      getRequestListener(async (request) => {
        received = true;
        request.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
          },
          { once: true },
        );
        try {
          await request.arrayBuffer();
          return new Response('complete');
        } catch {
          return new Response(null, { status: 499 });
        }
      }),
      { idleTimeoutMs: 10000 },
    );
    const { outgoing, result } = client(port, upload);
    outgoing.write('a');
    await vi.waitFor(() => expect(received).toBe(true));
    outgoing.destroy();
    expect(await result).toHaveProperty('error');
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it('does not permit disabling any replacement guard through helper options', () => {
    for (const key of Object.keys(httpServerPolicy)) {
      for (const value of [0, -1, Number.NaN, Infinity, 0.1])
        expect(() => createApiHttpServer(collect, { [key]: value })).toThrow(RangeError);
    }
  });
});
