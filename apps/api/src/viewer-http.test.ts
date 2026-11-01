import { describe, expect, it, vi } from 'vitest';
import { viewerBody, viewerHeaders, viewerRange } from './viewer-http.js';

describe('viewer HTTP range and media isolation', () => {
  it.each([
    [undefined, 10, { start: 0, endExclusive: 10, partial: false }],
    ['bytes=2-5', 10, { start: 2, endExclusive: 6, partial: true }],
    ['bytes=7-', 10, { start: 7, endExclusive: 10, partial: true }],
    ['bytes=-4', 10, { start: 6, endExclusive: 10, partial: true }],
    ['bytes=-100', 10, { start: 0, endExclusive: 10, partial: true }],
    ['bytes=7-100', 10, { start: 7, endExclusive: 10, partial: true }],
    [undefined, 0, { start: 0, endExclusive: 0, partial: false }],
  ])('reads only the bounded requested bytes: %s', (range, size, expected) => {
    expect(viewerRange(range, size)).toEqual(expected);
  });

  it.each([
    'bytes=10-',
    'bytes=6-2',
    'bytes=-0',
    'bytes=-',
    'bytes=0-1,3-4',
    'bytes=0-9007199254740992',
    'bytes=-9007199254740992',
    'items=0-1',
  ])('rejects unsupported/invalid ranges without a full-file fallback: %s', (range) => {
    expect(viewerRange(range, 10)).toBeUndefined();
  });

  it('prevents SVG/unknown media from executing with application privileges', () => {
    const range = viewerRange('bytes=2-5', 10);
    const full = viewerRange(undefined, 10);
    if (!range || !full) throw new Error('fixture_range');
    const headers = viewerHeaders('uploaded.SVG', 10, range);
    expect(headers).toMatchObject({
      'Content-Type': 'image/svg+xml',
      'Content-Length': '4',
      'Content-Range': 'bytes 2-5/10',
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    expect(viewerHeaders('script.html', 10, full)).toHaveProperty(
      'Content-Type',
      'application/octet-stream',
    );
  });
});

describe('viewer HTTP body lifetime', () => {
  it('releases the authorized source once on normal EOF', async () => {
    const close = vi.fn(async () => {});
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('file'));
        controller.close();
      },
    });
    const body = viewerBody(stream, new AbortController().signal, close);
    expect(await new Response(body).text()).toBe('file');
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('cancels a pending remote read and releases the source on consumer disconnect', async () => {
    const cancel = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const body = viewerBody(new ReadableStream({ cancel }), new AbortController().signal, close);
    const reader = body.getReader();
    const reading = reader.read();
    await reader.cancel();
    expect(await reading).toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('fails an active pending response immediately on shared authorization revocation', async () => {
    const abort = new AbortController();
    const cancel = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const body = viewerBody(new ReadableStream({ cancel }), abort.signal, close);
    const reading = body.getReader().read();
    const denied = expect(reading).rejects.toMatchObject({ code: 'forbidden' });
    abort.abort();
    await denied;
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects an already revoked source without forwarding buffered bytes', async () => {
    const abort = new AbortController();
    abort.abort();
    const close = vi.fn(async () => {});
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('private'));
      },
    });
    const body = viewerBody(stream, abort.signal, close);
    await expect(body.getReader().read()).rejects.toMatchObject({ code: 'forbidden' });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('releases the source after a transport error', async () => {
    const close = vi.fn(async () => {});
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('fixture_transport_lost'));
      },
    });
    const body = viewerBody(stream, new AbortController().signal, close);
    await expect(body.getReader().read()).rejects.toThrow('fixture_transport_lost');
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});
