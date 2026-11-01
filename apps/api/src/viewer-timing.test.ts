import { createLogger } from '@nickhosting/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { viewerBody } from './viewer-http.js';
import { createViewerTiming, motionTimingInput, motionTimingLimiter } from './viewer-timing.js';

const traceId = '926dd38e-5c86-4a0c-b3df-eed1f9bf6c79';
afterEach(() => vi.restoreAllMocks());
describe('Motion debug diagnostics', () => {
  it('does not start clocks or instrumentation when debug is off or identity invalid', () => {
    const clock = vi.spyOn(performance, 'now');
    const sink = vi.fn();
    expect(createViewerTiming(createLogger(sink), { traceId, purpose: 'native' })).toBeUndefined();
    expect(
      createViewerTiming(createLogger(sink, { level: 'debug' }), {
        traceId: 'private/file',
        purpose: 'native',
      }),
    ).toBeUndefined();
    expect(clock).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });
  it('reports one summary for bytes and EOF without modifying streamed content', async () => {
    const sink = vi.fn();
    const trace = createViewerTiming(createLogger(sink, { level: 'debug' }), {
      traceId,
      purpose: 'native',
    });
    if (!trace) throw Error('trace');
    await trace.measure('viewerOpen', async () => {});
    const response = new Response(
      viewerBody(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]));
            c.close();
          },
        }),
        new AbortController().signal,
        async () => {},
        trace,
      ),
    );
    trace.headers(response);
    expect(response.headers.get('server-timing')).toMatch(/^nh-motion;dur=/);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      event: 'viewer.motion_request',
      data: {
        traceId,
        bytes: 3,
        outcome: 'succeeded',
        firstByteMs: expect.any(Number),
        phases: { viewerOpen: expect.any(Number) },
      },
    });
    trace.finish('failed');
    expect(sink).toHaveBeenCalledTimes(1);
  });
  it('cancels and releases streams exactly once while reporting cancellation', async () => {
    const sink = vi.fn(),
      close = vi.fn(async () => {});
    const trace = createViewerTiming(createLogger(sink, { level: 'debug' }), {
      traceId,
      purpose: 'native',
    });
    const body = viewerBody(new ReadableStream(), new AbortController().signal, close, trace);
    await body.cancel();
    expect(close).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0].data.outcome).toBe('cancelled');
  });
  it('accepts only bounded numeric browser measurements and fixed vocabulary', () => {
    const event = { phase: 'native.play', atMs: 10, requestId: traceId };
    expect(motionTimingInput.safeParse({ traceId, events: [event] }).success).toBe(true);
    for (const bad of [
      { ...event, path: '/private' },
      { ...event, phase: '/private' },
      { ...event, durationMs: Infinity },
      { ...event, requestId: 'secret' },
      { ...event, atMs: 300001 },
    ])
      expect(motionTimingInput.safeParse({ traceId, events: [bad] }).success).toBe(false);
    expect(motionTimingInput.safeParse({ traceId, events: Array(49).fill(event) }).success).toBe(
      false,
    );
  });
  it('bounds per-session diagnostic batches and restores quota after the window', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000),
      accept = motionTimingLimiter();
    for (let i = 0; i < 30; i++) expect(accept('a')).toBe(true);
    expect(accept('a')).toBe(false);
    expect(accept('b')).toBe(true);
    now.mockReturnValue(62000);
    expect(accept('a')).toBe(true);
  });
});
