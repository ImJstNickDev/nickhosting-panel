import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MotionTimingPhase,
  MotionTimingValues,
  MotionTrace,
} from '../../../../../../packages/core/src/motion-timing.js';
import {
  bufferedContains,
  capturePlayback,
  updateSourceBuffer,
  VideoBufferBudget,
  VideoRangeReader,
  videoBufferEviction,
  videoSourceLimits,
} from './video-mse.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const source = 'https://panel.example/v1/servers/server/files/viewer/content?path=/video.mkv';
function ranges(entries: [number, number][]): TimeRanges {
  return {
    length: entries.length,
    start: (index) => entries[index]?.[0] ?? 0,
    end: (index) => entries[index]?.[1] ?? 0,
  };
}
function rangeFetch(size: number) {
  const request = vi.fn(async (_url: unknown, options: RequestInit) => {
    const range = new Headers(options.headers).get('Range');
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    if (!match) throw new Error('Expected bounded Range');
    const start = Number(match[1]),
      end = Number(match[2]);
    const data = new Uint8Array(end - start + 1);
    for (let index = 0; index < data.length; index++) data[index] = (start + index) % 251;
    return new Response(data, {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${size}` },
    });
  });
  vi.stubGlobal('fetch', request);
  return request;
}

describe('Motion bounded video Range reader', () => {
  it('records queue, headers and complete body once per remote block, without tracing cache hits', async () => {
    const events: { phase: MotionTimingPhase; values?: MotionTimingValues }[] = [];
    const trace: MotionTrace = {
      mark: vi.fn(),
      url: (url) => url,
      span: (phase) => (values) => {
        events.push({ phase, values });
      },
    };
    const request = vi.fn(
      async () =>
        new Response(new Uint8Array(100), {
          status: 206,
          headers: {
            'content-range': 'bytes 0-99/100',
            'x-request-id': 'ec6109de-e4e1-467b-967f-7a38cf97c37a',
            'server-timing': 'nh-motion;dur=12.5',
          },
        }),
    );
    vi.stubGlobal('fetch', request);
    const reader = new VideoRangeReader(source, 100, new AbortController().signal, trace);
    await reader.read(1, 2);
    await reader.read(3, 4);
    expect(request).toHaveBeenCalledOnce();
    expect(events).toEqual([
      { phase: 'video.range_queue', values: { outcome: 'succeeded' } },
      { phase: 'video.range_headers', values: { outcome: 'succeeded', status: 206 } },
      {
        phase: 'video.range',
        values: {
          outcome: 'succeeded',
          bytes: 100,
          status: 206,
          serverMs: 12.5,
          requestId: 'ec6109de-e4e1-467b-967f-7a38cf97c37a',
        },
      },
    ]);
  });
  it('records body failures without exposing error text or file paths', async () => {
    const finishes: MotionTimingValues[] = [];
    const trace: MotionTrace = {
      mark: vi.fn(),
      url: (url) => url,
      span: () => (values) => {
        if (values) finishes.push(values);
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(99), {
            status: 206,
            headers: { 'content-range': 'bytes 0-99/100' },
          }),
      ),
    );
    const reader = new VideoRangeReader(source, 100, new AbortController().signal, trace);
    await expect(reader.read(0, 1)).rejects.toThrow('Incomplete video range');
    expect(finishes.at(-1)).toEqual({ outcome: 'failed', status: 206 });
    expect(JSON.stringify(finishes)).not.toContain('video.mkv');
  });

  it('coalesces tiny metadata reads and concurrent overlapping packets into authenticated bounded ranges', async () => {
    const size = 1024 * 1024;
    const request = rangeFetch(size);
    const reader = new VideoRangeReader(source, size, new AbortController().signal);
    const [first, overlap] = await Promise.all([reader.read(2, 8), reader.read(4, 9)]);
    expect([...first]).toEqual([2, 3, 4, 5, 6, 7]);
    expect([...overlap]).toEqual([4, 5, 6, 7, 8]);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'same-origin',
      redirect: 'error',
      headers: { Range: 'bytes=0-65535' },
    });
  });
  it('switches to larger playback requests without downloading the rest of the file', async () => {
    const size = 50 * 1024 * 1024;
    const request = rangeFetch(size);
    const reader = new VideoRangeReader(source, size, new AbortController().signal);
    reader.streaming();
    await reader.read(900000, 900100);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1].headers).toEqual({ Range: 'bytes=524288-1048575' });
  });
  it('retains correctly sized discovery and playback blocks across seek budget resets', async () => {
    const size = 4 * 1024 * 1024;
    const request = rangeFetch(size);
    const reader = new VideoRangeReader(source, size, new AbortController().signal);
    await reader.read(0, 10);
    reader.streaming();
    const sample = await reader.read(65530, 65550);
    expect([...sample]).toEqual(Array.from({ length: 20 }, (_, index) => (65530 + index) % 251));
    reader.resetBudget(videoSourceLimits.windowBytes);
    await reader.read(900000, 900020);
    await reader.read(65530, 65550);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map((call) => new Headers(call[1].headers).get('Range'))).toEqual([
      'bytes=0-65535',
      'bytes=0-524287',
      'bytes=524288-1048575',
    ]);
  });
  it('bounds mixed discovery/playback cache by actual bytes and clears it on disposal', async () => {
    const block = videoSourceLimits.playbackBlockBytes;
    const size = block * 8;
    const request = rangeFetch(size);
    const reader = new VideoRangeReader(source, size, new AbortController().signal);
    await reader.read(0, 1);
    reader.streaming();
    reader.resetBudget(videoSourceLimits.windowBytes);
    for (let index = 0; index < 4; index++) await reader.read(index * block, index * block + 1);
    await reader.read(0, 1);
    expect(request).toHaveBeenCalledTimes(5);
    reader.clear();
    await reader.read(0, 1);
    expect(request).toHaveBeenCalledTimes(6);
  });
  it('evicts old blocks instead of retaining the complete movie', async () => {
    const block = videoSourceLimits.playbackBlockBytes;
    const size = block * 20;
    const request = rangeFetch(size);
    const reader = new VideoRangeReader(source, size, new AbortController().signal);
    reader.streaming();
    reader.resetBudget(videoSourceLimits.windowBytes);
    for (let index = 0; index < 6; index++) await reader.read(index * block, index * block + 1);
    await reader.read(0, 1);
    expect(request).toHaveBeenCalledTimes(7);
  });
  it('bounds scans and permits a new validated streaming window without a full prefetch buffer', async () => {
    const block = videoSourceLimits.playbackBlockBytes;
    const size = block * 8;
    const request = rangeFetch(size);
    const reader = new VideoRangeReader(source, size, new AbortController().signal);
    reader.streaming();
    reader.resetBudget(block);
    await reader.read(0, 1);
    await expect(reader.read(block, block + 1)).rejects.toThrow('budget');
    reader.resetBudget(block);
    await expect(reader.read(block, block + 1)).resolves.toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(['full', 'changed', 'long', 'short'])(
    'rejects %s responses without accepting a whole-file fallback',
    async (kind) => {
      const size = 100;
      const request = vi.fn(
        async () =>
          new Response(new Uint8Array(kind === 'long' ? 101 : kind === 'short' ? 99 : 100), {
            status: kind === 'full' ? 200 : 206,
            headers: { 'content-range': `bytes 0-99/${kind === 'changed' ? 101 : 100}` },
          }),
      );
      vi.stubGlobal('fetch', request);
      const reader = new VideoRangeReader(source, size, new AbortController().signal);
      await expect(reader.read(0, 1)).rejects.toThrow();
    },
  );
  it('aborts queued range reads and prevents any later fetch', async () => {
    const cancel = new AbortController();
    const request = rangeFetch(1024 * 1024);
    const reader = new VideoRangeReader(source, 1024 * 1024, cancel.signal);
    cancel.abort();
    await expect(reader.read(0, 1)).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('Motion media lifecycle primitives', () => {
  it('does not mistake gaps between buffered regions for a local seek', () => {
    const buffered = ranges([
      [0, 3],
      [8, 12],
    ]);
    expect(bufferedContains(buffered, 2)).toBe(true);
    expect(bufferedContains(buffered, 5)).toBe(false);
    expect(bufferedContains(buffered, 11)).toBe(true);
  });
  it('retains old compressed frames without an age limit and charges partially removed fragments fully', () => {
    const budget = new VideoBufferBudget();
    budget.add(0, 2, 40 * 1024 * 1024);
    budget.add(300, 302, 50 * 1024 * 1024);
    expect(budget.bytes).toBe(90 * 1024 * 1024);
    expect(budget.bytes).toBeLessThan(videoSourceLimits.retainedBytes);
    budget.reconcile(
      ranges([
        [1, 2],
        [300, 302],
      ]),
    );
    expect(budget.bytes).toBe(90 * 1024 * 1024);
    budget.add(301, 303, 40 * 1024 * 1024);
    expect(budget.bytes).toBeGreaterThan(videoSourceLimits.retainedBytes);
    expect(
      videoBufferEviction(
        ranges([
          [1, 2],
          [300, 303],
        ]),
        301,
      ),
    ).toEqual([1, 2]);
    budget.reconcile(ranges([[300, 303]]));
    expect(budget.bytes).toBe(90 * 1024 * 1024);
  });
  it('refunds cumulatively removed media and initialization bytes once no frames remain', () => {
    const budget = new VideoBufferBudget();
    budget.add(0, 0, 1024);
    budget.add(0, 10, videoSourceLimits.retainedBytes - 1024);
    budget.reconcile(ranges([[4, 10]]));
    expect(budget.bytes).toBe(videoSourceLimits.retainedBytes - 1024);
    budget.reconcile(ranges([]));
    expect(budget.bytes).toBe(0);
    budget.add(20, 22, 4096);
    expect(budget.bytes).toBe(4096);
  });
  it('reconciles browser-evicted completed data without refunding a partially appended fragment', () => {
    const budget = new VideoBufferBudget();
    budget.add(0, 2, videoSourceLimits.retainedBytes - 4096, 1);
    budget.add(300, 302, 4096, 2);
    budget.reconcile(ranges([]), 2);
    expect(budget.bytes).toBe(4096);
    budget.reconcile(ranges([[300, 302]]), 3);
    expect(budget.bytes).toBe(4096);
    budget.reconcile(ranges([]), 3);
    expect(budget.bytes).toBe(0);
  });
  it('evicts either distant side while protecting active playback and allows quota backpressure', () => {
    expect(
      videoBufferEviction(
        ranges([
          [0, 15],
          [28, 40],
        ]),
        3,
      ),
    ).toEqual([28, 40]);
    expect(
      videoBufferEviction(
        ranges([
          [0, 15],
          [28, 40],
        ]),
        29,
      ),
    ).toEqual([0, 15]);
    expect(videoBufferEviction(ranges([[2, 4]]), 3)).toBeNull();
  });
  it('captures actual playback preferences without silently starting paused or ended media', () => {
    const media = {
      currentTime: 8.5,
      paused: false,
      ended: false,
      playbackRate: 1.5,
      volume: 0.35,
      muted: true,
    } as HTMLVideoElement;
    expect(capturePlayback(media)).toEqual({
      time: 8.5,
      playing: true,
      rate: 1.5,
      volume: 0.35,
      muted: true,
    });
    media.pause = () => {};
    expect(capturePlayback({ ...media, paused: true } as HTMLVideoElement).playing).toBe(false);
    expect(capturePlayback({ ...media, ended: true } as HTMLVideoElement).playing).toBe(false);
  });
  it('settles cancelled append operations even when the browser never emits updateend', async () => {
    const buffer = new EventTarget() as SourceBuffer;
    const cancel = new AbortController();
    const update = vi.fn();
    const append = updateSourceBuffer(buffer, cancel.signal, update);
    const assertion = expect(append).rejects.toMatchObject({ name: 'AbortError' });
    cancel.abort();
    await assertion;
    expect(update).toHaveBeenCalledOnce();
  });
  it('times out missing SourceBuffer completion events and preserves synchronous quota errors', async () => {
    vi.useFakeTimers();
    const buffer = new EventTarget() as SourceBuffer;
    const waiting = updateSourceBuffer(buffer, new AbortController().signal, () => {});
    const assertion = expect(waiting).rejects.toThrow('Video buffer failed');
    await vi.advanceTimersByTimeAsync(videoSourceLimits.operationMs);
    await assertion;
    await expect(
      updateSourceBuffer(buffer, new AbortController().signal, () => {
        throw new DOMException('full', 'QuotaExceededError');
      }),
    ).rejects.toMatchObject({ name: 'QuotaExceededError' });
  });
});
