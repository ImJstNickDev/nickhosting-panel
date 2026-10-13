import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MotionTimeline } from './motion-timing.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('location', new URL('https://panel.example/servers/example/files'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const timeline = () => new MotionTimeline('/v1/servers/example/files/viewer/motion-timing');
const batches = () =>
  vi.mocked(fetch).mock.calls.map(([, options]) => JSON.parse(String(options?.body)));

describe('bounded Motion debug timeline', () => {
  it('batches fixed milestones without transferring file paths or arbitrary error content', async () => {
    const trace = timeline();
    trace.activate();
    trace.activate();
    trace.mark('video.range', {
      durationMs: 12.34567,
      bytes: 1024,
      status: 206,
      requestId: '11111111-1111-4111-8111-111111111111',
      ...{ path: '/private/movie.mkv', text: 'caption', error: 'secret' },
    });
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(batches()).toHaveLength(1);
    expect(batches()[0]).toEqual({
      traceId: trace.id,
      events: [
        { phase: 'viewer.mounted', atMs: expect.any(Number) },
        {
          phase: 'video.range',
          atMs: expect.any(Number),
          durationMs: 12.346,
          bytes: 1024,
          status: 206,
          requestId: '11111111-1111-4111-8111-111111111111',
        },
      ],
    });
    trace.close();
  });
  it('counts completed spans once and drops malformed numbers and request identifiers', () => {
    const trace = timeline();
    const finish = trace.span('subtitles.window');
    finish({
      outcome: 'succeeded',
      count: 3,
      mediaSeconds: Number.NaN,
      serverMs: -1,
      requestId: 'https://private/token',
    });
    finish({ outcome: 'failed' });
    trace.close();
    const events = batches().flatMap((batch) => batch.events);
    expect(events.filter((event) => event.phase === 'subtitles.window')).toEqual([
      {
        phase: 'subtitles.window',
        atMs: expect.any(Number),
        durationMs: expect.any(Number),
        outcome: 'succeeded',
        count: 3,
      },
    ]);
  });
  it('caps events and batches and stops after close without retrying failed diagnostics', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const trace = timeline();
    for (let index = 0; index < 1000; index++) trace.mark('native.play');
    trace.close();
    trace.mark('native.error');
    await vi.advanceTimersByTimeAsync(6000);
    const sent = batches();
    expect(sent.every((batch) => batch.events.length <= 48)).toBe(true);
    expect(sent.flatMap((batch) => batch.events)).toHaveLength(512);
    expect(sent).toHaveLength(11);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never throws when the diagnostic console or network implementation fails synchronously', () => {
    vi.mocked(console.debug).mockImplementation(() => {
      throw new Error('console unavailable');
    });
    const trace = timeline();
    expect(() => {
      trace.mark('native.play');
      trace.close();
    }).not.toThrow();
    vi.mocked(console.debug).mockImplementation(() => {});
    vi.mocked(fetch).mockImplementation(() => {
      throw new Error('network unavailable');
    });
    const next = timeline();
    expect(() => {
      next.mark('native.play');
      next.close();
    }).not.toThrow();
  });
  it('adds opaque correlation to same-origin requests without replacing their path or range query', () => {
    const trace = timeline();
    const original = '/v1/servers/example/files/viewer/content?path=private%2Fmovie.mkv';
    const url = new URL(trace.url(original, 'subtitles'), location.origin);
    expect(url.searchParams.get('path')).toBe('private/movie.mkv');
    expect(url.searchParams.get('motionTrace')).toBe(trace.id);
    expect(url.searchParams.get('motionPurpose')).toBe('subtitles');
    expect(trace.url('https://unrelated.example/media')).toBe('https://unrelated.example/media');
    trace.close();
  });
});
