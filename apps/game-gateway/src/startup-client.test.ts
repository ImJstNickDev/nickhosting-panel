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
      { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${options.token}` } },
    ]);
  });
  it.each([
    `event: startup\ndata: ${JSON.stringify({ ...hint, generation: randomUUID() })}\n\n`,
    `event: startup\ndata: ${JSON.stringify({ ...hint, token: 'secret' })}\n\n`,
    'x'.repeat(8193),
    'event: console\ndata: secret\n\n',
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
