import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { watchGatewayStartup } from './startup-client.js';

const hint = {
  routeId: randomUUID(),
  routeRevision: 4,
  generation: randomUUID(),
  wakeJobId: randomUUID(),
};
const options = { baseUrl: 'https://core.example', gatewayId: randomUUID(), token: 'a'.repeat(43) };
function response(text: string) {
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}
describe('startup client', () => {
  it('authenticates without redirect and accepts exact bounded hint', async () => {
    const fetcher = vi.fn(async () =>
      response(`event: startup\ndata: ${JSON.stringify(hint)}\n\n`),
    );
    const receive = vi.fn();
    await watchGatewayStartup({ ...options, fetcher }, hint, receive, new AbortController().signal);
    expect(receive).toHaveBeenCalledExactlyOnceWith(hint);
    expect(fetcher.mock.calls[0]).toMatchObject([
      expect.any(URL),
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'X-NickHosting-Gateway-Features': 'startup-keepalive-v1,provider-readiness-v1',
        },
      },
    ]);
  });
  it('accepts a bounded durable readiness receipt only with its event timestamp', async () => {
    const snapshot = {
      gatewayId: options.gatewayId,
      revision: 5,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      routes: [],
    };
    const event = { ...hint, readinessSnapshot: snapshot, observedAt: new Date().toISOString() };
    const receive = vi.fn();
    await watchGatewayStartup(
      {
        ...options,
        fetcher: async () => response(`event: startup\ndata: ${JSON.stringify(event)}\n\n`),
      },
      hint,
      receive,
      new AbortController().signal,
    );
    expect(receive).toHaveBeenCalledWith(event);
    await expect(
      watchGatewayStartup(
        {
          ...options,
          fetcher: async () =>
            response(
              `event: startup\ndata: ${JSON.stringify({ ...hint, readinessSnapshot: snapshot })}\n\n`,
            ),
        },
        hint,
        receive,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  it.each([
    `event: startup\ndata: ${JSON.stringify({ ...hint, generation: randomUUID() })}\n\n`,
    `event: startup\ndata: ${JSON.stringify({ ...hint, token: 'secret' })}\n\n`,
    'x'.repeat(1048577),
    'event: console\ndata: secret\n\n',
    'event: keepalive\ndata: {"ready":true}\n\n',
    'event: keepalive\ndata: {}\n\n'.repeat(400),
  ])('rejects malformed, oversized or mismatched payload', async (text) => {
    const receive = vi.fn();
    await expect(
      watchGatewayStartup(
        { ...options, fetcher: async () => response(text) },
        hint,
        receive,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(receive).not.toHaveBeenCalled();
  });
  it('handles partial frames without reading beyond a single hint', async () => {
    const text = `event: startup\ndata: ${JSON.stringify(hint)}\n\n`;
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const part of [text.slice(0, 12), text.slice(12)])
          c.enqueue(new TextEncoder().encode(part));
      },
      cancel: cancelled,
    });
    const receive = vi.fn();
    await watchGatewayStartup(
      {
        ...options,
        fetcher: async () =>
          new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      },
      hint,
      receive,
      new AbortController().signal,
    );
    expect(receive).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('abort cancels a stalled response body', async () => {
    const cancelled = vi.fn(),
      controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const fetcher = vi.fn(
      async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const receive = vi.fn();
    const pending = watchGatewayStartup({ ...options, fetcher }, hint, receive, controller.signal);
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort();
    await pending;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(receive).not.toHaveBeenCalled();
  });
  it('bounds a stalled stream by its deadline without publishing a hint', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(),
        receive = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const pending = watchGatewayStartup(
        {
          ...options,
          requestTimeoutMs: 50,
          fetcher: async () =>
            new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
        },
        hint,
        receive,
        new AbortController().signal,
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
      await pending;
      expect(cancel).toHaveBeenCalledOnce();
      expect(receive).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('rejects insecure destination and suppresses raw provider exception', async () => {
    await expect(
      watchGatewayStartup(
        { ...options, baseUrl: 'http://core.example' },
        hint,
        vi.fn(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'configuration_invalid' });
    await expect(
      watchGatewayStartup(
        {
          ...options,
          fetcher: async () => {
            throw new Error('secret');
          },
        },
        hint,
        vi.fn(),
        new AbortController().signal,
      ),
    ).rejects.not.toThrow('secret');
  });
});

it.each(['coalesced', 'fragmented'])(
  'consumes %s keepalive frames before one real hint',
  async (shape) => {
    const text = `event: keepalive\ndata: {}\n\nevent: keepalive\ndata: {}\n\nevent: startup\ndata: ${JSON.stringify(hint)}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const chunks = shape === 'coalesced' ? [text] : [...text];
        for (const part of chunks) c.enqueue(new TextEncoder().encode(part));
        c.close();
      },
    });
    const receive = vi.fn();
    await watchGatewayStartup(
      {
        ...options,
        fetcher: async () =>
          new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      },
      hint,
      receive,
      new AbortController().signal,
    );
    expect(receive).toHaveBeenCalledExactlyOnceWith(hint);
  },
);
it('keepalives neither grant readiness nor extend the absolute stream deadline', async () => {
  vi.useFakeTimers();
  try {
    const receive = vi.fn(),
      cancel = vi.fn();
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        writer = c;
      },
      cancel,
    });
    const pending = watchGatewayStartup(
      {
        ...options,
        requestTimeoutMs: 50,
        fetcher: async () =>
          new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      },
      hint,
      receive,
      new AbortController().signal,
    );
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10);
      writer.enqueue(new TextEncoder().encode('event: keepalive\ndata: {}\n\n'));
    }
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(receive).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
