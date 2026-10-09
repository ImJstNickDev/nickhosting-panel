import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createPterodactylAdapter } from './adapter.js';
import { createDownloadProxy } from './downloads.js';
import { createTransferGuard } from './transfer-guard.js';
import { createUploadProxy } from './uploads.js';

async function withHttp(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  test: (origin: string) => Promise<void>,
) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const options = { applicationKey: 'fixture-application', clientKey: 'fixture-client' };
function bytes(length: number, onPull?: (produced: number) => void) {
  let produced = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (produced === length) {
          controller.close();
          return;
        }
        const chunk = new Uint8Array(Math.min(64 * 1024, length - produced)).fill(0xa5);
        produced += chunk.length;
        onPull?.(produced);
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
}

describe('real HTTP streaming transfers', () => {
  it('downloads more than 1 GiB with bounded buffers and slow-consumer backpressure', async () => {
    const length = 1024 ** 3 + 64 * 1024;
    let produced = 0;
    let received = 0;
    let pausedProduction = 0;
    await withHttp(
      async (request, response) => {
        expect(request.headers.authorization).toBeUndefined();
        response.writeHead(200, {
          'Content-Length': length,
          'Content-Type': 'application/octet-stream',
        });
        const chunk = Buffer.alloc(64 * 1024, 0xa5);
        while (produced < length && !response.destroyed) {
          produced += chunk.length;
          if (!response.write(chunk)) await once(response, 'drain');
        }
        response.end();
      },
      async (origin) => {
        const download = await createDownloadProxy({ ...options, baseURL: origin })(
          `${origin}/download?token=private-fixture`,
          {},
        );
        expect(download.contentLength).toBe(length);
        expect(download).not.toHaveProperty('url');
        await delay(80);
        pausedProduction = produced;
        expect(pausedProduction).toBeLessThan(16 * 1024 ** 2);
        const baseline = process.memoryUsage().rss;
        let peak = baseline;
        const sampler = setInterval(() => {
          peak = Math.max(peak, process.memoryUsage().rss);
        }, 10);
        const reader = download.body.getReader();
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            expect(item.value[0]).toBe(0xa5);
            expect(item.value.at(-1)).toBe(0xa5);
            received += item.value.length;
            if (received % (4 * 1024 ** 2) < item.value.length) await delay(1);
          }
        } finally {
          clearInterval(sampler);
        }
        expect(peak - baseline).toBeLessThan(128 * 1024 ** 2);
      },
    );
    expect(received).toBe(length);
  }, 30_000);

  it('streams binary multipart uploads with exact destination, length and no API credential', async () => {
    const length = 32 * 1024 ** 2 + 7;
    let uploaded = 0;
    let producer = 0;
    let prefix = Buffer.alloc(0),
      tail = Buffer.alloc(0);
    await withHttp(
      async (request, response) => {
        expect(request.method).toBe('POST');
        expect(request.headers.authorization).toBeUndefined();
        expect(new URL(request.url ?? '', 'http://fixture').searchParams.get('directory')).toBe(
          '/worlds',
        );
        expect(request.headers['content-type']).toMatch(/^multipart\/form-data; boundary=nh-/);
        request.pause();
        await delay(80);
        expect(producer).toBeLessThan(16 * 1024 ** 2);
        for await (const data of request) {
          const chunk = Buffer.from(data);
          uploaded += chunk.length;
          if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk]).subarray(0, 512);
          tail = Buffer.concat([tail, chunk]).subarray(-100);
          if (uploaded % (2 * 1024 ** 2) < chunk.length) await delay(1);
        }
        expect(uploaded).toBe(Number(request.headers['content-length']));
        response.writeHead(204).end();
      },
      async (origin) => {
        await createUploadProxy({ ...options, baseURL: origin, uploadOrigins: [origin] })(
          `${origin}/upload/file?token=private-fixture`,
          'worlds/world.dat',
          {
            body: bytes(length, (value) => {
              producer = value;
            }),
            contentLength: length,
            maxBytes: 64 * 1024 ** 2,
          },
        );
      },
    );
    const start = prefix.indexOf('\r\n\r\n') + 4;
    expect(prefix.subarray(0, start).toString()).toContain('name="files"; filename="world.dat"');
    expect(prefix[start]).toBe(0xa5);
    expect(tail.toString()).toMatch(/\r\n--nh-[a-f0-9-]+--\r\n$/);
    const suffix = /\r\n--nh-[a-f0-9-]+--\r\n$/.exec(tail.toString())?.[0];
    expect(uploaded - start - Buffer.byteLength(suffix ?? '')).toBe(length);
  });

  it('cancels the upstream socket when the downstream cancels', async () => {
    let closed: Promise<unknown> | undefined;
    await withHttp(
      (_, response) => {
        response.writeHead(200);
        response.write(Buffer.alloc(64 * 1024));
        closed = once(response, 'close');
      },
      async (origin) => {
        const result = await createDownloadProxy({ ...options, baseURL: origin })(
          `${origin}/download`,
          {},
        );
        const reader = result.body.getReader();
        await reader.read();
        await reader.cancel();
        await Promise.race([
          closed,
          delay(1000).then(() => {
            throw new Error('Socket was not closed');
          }),
        ]);
      },
    );
  });

  it('terminates a stalled provider without imposing a total-transfer timeout', async () => {
    await withHttp(
      (_, response) => {
        response.writeHead(200);
        response.write('first');
      },
      async (origin) => {
        const result = await createDownloadProxy({ ...options, baseURL: origin })(
          `${origin}/download`,
          { idleTimeoutMs: 50 },
        );
        const reader = result.body.getReader();
        expect((await reader.read()).value?.length).toBe(5);
        await expect(reader.read()).rejects.toMatchObject({ reason: 'unavailable' });
      },
    );
    await withHttp(
      async (_, response) => {
        response.writeHead(200);
        for (let n = 0; n < 10; n++) {
          response.write('x');
          await delay(15);
        }
        response.end();
      },
      async (origin) => {
        const result = await createDownloadProxy({ ...options, baseURL: origin })(
          `${origin}/download`,
          { idleTimeoutMs: 50 },
        );
        expect(await new Response(result.body).text()).toBe('xxxxxxxxxx');
      },
    );
  });

  it('detects a truncated HTTP response instead of completing successfully', async () => {
    await withHttp(
      (_, response) => {
        response.writeHead(200, { 'Content-Length': '100' });
        response.end('short');
      },
      async (origin) => {
        const result = await createDownloadProxy({ ...options, baseURL: origin })(
          `${origin}/download`,
          { idleTimeoutMs: 100 },
        );
        await expect(new Response(result.body).arrayBuffer()).rejects.toMatchObject({
          reason: 'unavailable',
        });
      },
    );
  });

  it('revokes an idle download from current authorization and closes its upstream', async () => {
    let allowed = true;
    let closed: Promise<unknown> | undefined;
    await withHttp(
      (_, response) => {
        response.writeHead(200);
        response.write('first');
        closed = once(response, 'close');
      },
      async (origin) => {
        const result = await createDownloadProxy({ ...options, baseURL: origin })(
          `${origin}/download`,
          {
            authorize: async () => {
              if (!allowed) throw new Error('revoked');
            },
            authorizationIntervalMs: 10,
          },
        );
        allowed = false;
        await delay(30);
        await expect(result.body.getReader().read()).rejects.toMatchObject({
          reason: 'unavailable',
        });
        await closed;
      },
    );
  });

  it('revokes an in-progress upload and cancels its browser source', async () => {
    let allowed = true,
      cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await delay(10);
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await withHttp(
      async (request, response) => {
        request.once('data', () => {
          allowed = false;
        });
        for await (const _ of request) {
          /* Drain only this isolated fixture. */
        }
        response.end();
      },
      async (origin) => {
        await expect(
          createUploadProxy({ ...options, baseURL: origin, uploadOrigins: [origin] })(
            `${origin}/upload/file?token=fixture`,
            'world.dat',
            {
              body: source,
              contentLength: 1024 ** 2,
              maxBytes: 1024 ** 2,
              authorize: async () => {
                if (!allowed) throw new Error('revoked');
              },
              authorizationIntervalMs: 10,
            },
          ),
        ).rejects.toMatchObject({ outcome: 'unknown' });
        expect(cancelled).toBe(true);
      },
    );
  });
});

describe('stream validation and provider isolation', () => {
  it('handles already-aborted downloads and uploads without invoking work or leaking rejected promises', async () => {
    const rejections: unknown[] = [];
    const observe = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', observe);
    const controller = new AbortController();
    controller.abort();
    const authorize = vi.fn(async () => {
      throw new Error('must not run');
    });
    const fetcher = vi.fn<typeof fetch>();
    const configuration = {
      ...options,
      baseURL: 'https://panel.example.test',
      uploadOrigins: ['https://wings.example.test'],
      fetcher,
    };
    try {
      await expect(
        createDownloadProxy(configuration)('https://panel.example.test/file', {
          signal: controller.signal,
          authorize,
        }),
      ).rejects.toMatchObject({ reason: 'unavailable' });
      await expect(
        createUploadProxy(configuration)('https://wings.example.test/upload/file', 'file.bin', {
          body: bytes(1),
          contentLength: 1,
          maxBytes: 1,
          signal: controller.signal,
          authorize,
        }),
      ).rejects.toMatchObject({ reason: 'unavailable' });
      const adapter = createPterodactylAdapter(configuration);
      await expect(
        adapter.downloadFile('fixture', 'file.bin', { signal: controller.signal }),
      ).rejects.toMatchObject({ reason: 'unavailable' });
      await expect(
        adapter.uploadFile('fixture', 'file.bin', {
          body: bytes(1),
          contentLength: 1,
          maxBytes: 1,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ reason: 'unavailable' });
      await delay(10);
      expect(authorize).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', observe);
    }
  });
  it('handles an abort that occurs as work begins and a late rejection after abort', async () => {
    const rejections: unknown[] = [];
    const observe = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', observe);
    const guard = createTransferGuard({}, 'rejected');
    try {
      await expect(
        guard.run(async () => {
          guard.abort();
          await delay(5);
          throw new Error('late private failure');
        }),
      ).rejects.toMatchObject({ reason: 'unavailable' });
      await delay(10);
      expect(rejections).toEqual([]);
    } finally {
      guard.close();
      process.off('unhandledRejection', observe);
    }
  });
  it('cancels while authorization is pending without fetching or an unhandled rejection', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>();
    const result = createDownloadProxy({
      ...options,
      baseURL: 'https://panel.example.test',
      fetcher,
    })('https://panel.example.test/file', {
      signal: controller.signal,
      authorize: async () => {
        controller.abort();
        await delay(5);
        throw new Error('late authorization failure');
      },
    });
    await expect(result).rejects.toMatchObject({ reason: 'unavailable' });
    await delay(10);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects an early upstream 2xx instead of falsely claiming a complete upload', async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      createUploadProxy({
        ...options,
        baseURL: 'https://panel.example.test',
        uploadOrigins: ['https://wings.example.test'],
        fetcher,
      })('https://wings.example.test/upload/file', 'file.bin', {
        body: source,
        contentLength: 1024,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ outcome: 'unknown' });
    expect(cancelled).toBe(true);
  });
  it.each(['../x', '/x', 'a//b', 'a%2fb', 'a\\b', 'a\r\nInjected: x'])(
    'rejects upload path %j before requesting a token',
    async (path) => {
      const fetcher = vi.fn<typeof fetch>();
      const adapter = createPterodactylAdapter({
        ...options,
        baseURL: 'https://panel.example.test',
        fetcher,
      });
      await expect(
        adapter.uploadFile('fixture', path, { body: bytes(1), contentLength: 1, maxBytes: 1 }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('does not reuse download origins as upload authority', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        attributes: { url: 'https://backup.example.test/upload/file?token=private' },
      }),
    );
    const adapter = createPterodactylAdapter({
      ...options,
      baseURL: 'https://panel.example.test',
      downloadOrigins: ['https://backup.example.test'],
      fetcher,
    });
    await expect(
      adapter.uploadFile('fixture', 'file.bin', { body: bytes(1), contentLength: 1, maxBytes: 1 }),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([1, 3])('rejects upload length mismatch with actual size %i', async (size) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
      await new Response(init?.body).arrayBuffer();
      return new Response(null, { status: 204 });
    });
    await expect(
      createUploadProxy({
        ...options,
        baseURL: 'https://panel.example.test',
        uploadOrigins: ['https://wings.example.test'],
        fetcher,
      })('https://wings.example.test/upload/file?token=private', 'file.bin', {
        body: bytes(size),
        contentLength: 2,
        maxBytes: 2,
      }),
    ).rejects.toMatchObject({ outcome: 'unknown' });
  });
  it('rejects sizes above the configured quota before the signed destination receives data', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createUploadProxy({ ...options, baseURL: 'https://panel.example.test', fetcher })(
        'https://wings.example.test/upload/file',
        'file.bin',
        { body: bytes(3), contentLength: 3, maxBytes: 2 },
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['-1', '+10', '1.5', '9007199254740992', 'garbage'])(
    'rejects malformed content length %s',
    async (length) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('x', { headers: { 'content-length': length } }));
      await expect(
        createDownloadProxy({ ...options, baseURL: 'https://panel.example.test', fetcher })(
          'https://panel.example.test/file',
          {},
        ),
      ).rejects.toMatchObject({ reason: 'invalid_response' });
    },
  );
  it('checks a declared response length on otherwise clean EOF', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('short', { headers: { 'content-length': '100' } }));
    const result = await createDownloadProxy({
      ...options,
      baseURL: 'https://panel.example.test',
      fetcher,
    })('https://panel.example.test/file', {});
    await expect(new Response(result.body).text()).rejects.toMatchObject({ reason: 'unavailable' });
  });
  it('fails closed on a provider redirect without forwarding credentials or token', async () => {
    let reached = false;
    await withHttp(
      (request, response) => {
        if (request.url?.startsWith('/other')) reached = true;
        response.writeHead(302, { Location: '/other' }).end();
      },
      async (origin) => {
        await expect(
          createDownloadProxy({ ...options, baseURL: origin })(`${origin}/file?token=private`, {}),
        ).rejects.toMatchObject({ reason: 'unavailable' });
      },
    );
    expect(reached).toBe(false);
  });
});
