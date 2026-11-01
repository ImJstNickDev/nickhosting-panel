import { type RefObject, useEffect, useRef, useState } from 'react';
import type {
  MotionTimingEvent,
  MotionTimingPhase,
  MotionTimingValues,
  MotionTrace,
} from '../../../../../../packages/core/src/motion-timing.js';
import { serverPath } from '../../service-contracts.js';

const maximumEvents = 512;
const maximumRangeEvents = 192;
const maximumBatch = 48;
const maximumMs = 300_000;
const noop = () => {};
const round = (value: number) => Math.round(value * 1000) / 1000;

/** Debug-only, bounded milestone collection. Delivery never blocks playback. */
export class MotionTimeline implements MotionTrace {
  readonly id = crypto.randomUUID();
  private readonly started = performance.now();
  private pending: MotionTimingEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private count = 0;
  private rangeCount = 0;
  private closed = false;
  private mounted = false;
  constructor(private readonly endpoint: string) {}
  activate() {
    if (this.mounted) return;
    this.mounted = true;
    this.mark('viewer.mounted');
  }
  mark(phase: MotionTimingPhase, values: MotionTimingValues = {}) {
    try {
      if (this.closed || this.count >= maximumEvents) return;
      const elapsed = performance.now() - this.started;
      if (elapsed < 0 || elapsed > maximumMs) return;
      // Reserve the remaining budget for seeks, failures and subtitle recovery.
      if (
        phase === 'video.range' ||
        phase === 'video.range_queue' ||
        phase === 'video.range_headers'
      ) {
        if (this.rangeCount >= maximumRangeEvents) return;
        this.rangeCount++;
      }
      // Deliberately copy only the diagnostic contract, never arbitrary objects.
      const event: MotionTimingEvent = { phase, atMs: round(elapsed) };
      for (const key of [
        'durationMs',
        'count',
        'bytes',
        'status',
        'mediaSeconds',
        'serverMs',
      ] as const) {
        const value = values[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
          event[key] = round(value);
      }
      if (values.outcome && ['succeeded', 'failed', 'cancelled'].includes(values.outcome))
        event.outcome = values.outcome;
      if (
        values.requestId &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          values.requestId,
        )
      )
        event.requestId = values.requestId;
      this.pending.push(event);
      this.count++;
      if (this.pending.length >= maximumBatch) this.flush();
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), 1000);
      if (
        this.rangeCount === maximumRangeEvents &&
        (phase === 'video.range' ||
          phase === 'video.range_queue' ||
          phase === 'video.range_headers')
      )
        this.mark('trace.range_limit', { count: maximumRangeEvents });
    } catch {
      // Observability is never a media failure.
    }
  }
  span(phase: MotionTimingPhase) {
    if (this.closed || this.count >= maximumEvents) return noop;
    let start: number;
    try {
      start = performance.now();
    } catch {
      return noop;
    }
    let finished = false;
    return (values: MotionTimingValues = {}) => {
      if (finished) return;
      finished = true;
      try {
        this.mark(phase, { ...values, durationMs: performance.now() - start });
      } catch {
        /* Diagnostics cannot replace the operation's result. */
      }
    };
  }
  url(url: string, purpose: 'native' | 'discovery' | 'mse' | 'subtitles' | 'thumbnail' = 'native') {
    try {
      const parsed = new URL(url, location.href);
      if (parsed.origin !== location.origin) return url;
      parsed.searchParams.set('motionTrace', this.id);
      parsed.searchParams.set('motionPurpose', purpose);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  }
  flush() {
    try {
      clearTimeout(this.timer);
      this.timer = undefined;
      const events = this.pending.splice(0, maximumBatch);
      if (!events.length) return;
      // One small batch per second (or 48 milestones), never per frame/chunk.
      const body = JSON.stringify({ traceId: this.id, events });
      console.debug('viewer.motion_timing', { traceId: this.id, events });
      void fetch(this.endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
        signal: AbortSignal.timeout(5000),
      }).catch(noop);
    } catch {
      /* A failed diagnostic delivery has no retry or UI error. */
    }
  }
  close() {
    if (this.closed) return;
    this.mark('viewer.closed');
    this.closed = true;
    this.flush();
  }
}

/** Snapshot the already-loaded capability: a refetch cannot replace a playing source. */
export function useMotionTiming(
  media: RefObject<HTMLVideoElement | null>,
  serverId: string,
  enabled: boolean,
) {
  const [trace] = useState(() => {
    if (!enabled) return undefined;
    try {
      return new MotionTimeline(`${serverPath(serverId)}/files/viewer/motion-timing`);
    } catch {
      return undefined;
    }
  });
  const generation = useRef(0);
  useEffect(() => {
    const video = media.current;
    if (!video || !trace) return;
    const current = ++generation.current;
    trace.activate();
    const listeners: [string, EventListener][] = [];
    const on = (event: string, listener: EventListener) => {
      listeners.push([event, listener]);
      video.addEventListener(event, listener);
    };
    for (const [event, phase] of [
      ['loadstart', 'native.loadstart'],
      ['loadedmetadata', 'native.metadata'],
      ['loadeddata', 'native.loadeddata'],
      ['canplay', 'native.canplay'],
      ['play', 'native.play'],
      ['playing', 'native.playing'],
      ['pause', 'native.pause'],
      ['error', 'native.error'],
    ] as const)
      on(event, () =>
        trace.mark(phase, {
          mediaSeconds: video.currentTime,
          ...(event === 'error' ? { status: video.error?.code, outcome: 'failed' as const } : {}),
        }),
      );
    let seeking: ReturnType<MotionTrace['span']> | undefined;
    let waiting: ReturnType<MotionTrace['span']> | undefined;
    on('seeking', () => {
      seeking?.({ outcome: 'cancelled' });
      seeking = trace.span('native.seek');
    });
    on('seeked', () => {
      seeking?.({ outcome: 'succeeded', mediaSeconds: video.currentTime });
      seeking = undefined;
    });
    on('waiting', () => {
      waiting ??= trace.span('native.waiting');
    });
    for (const event of ['playing', 'canplay'])
      on(event, () => {
        waiting?.({ outcome: 'succeeded' });
        waiting = undefined;
      });
    for (const event of ['pause', 'error', 'emptied', 'ended'])
      on(event, () => {
        waiting?.({ outcome: 'cancelled' });
        waiting = undefined;
      });
    let firstFrame: number | undefined;
    if (typeof video.requestVideoFrameCallback === 'function')
      firstFrame = video.requestVideoFrameCallback((_now, metadata) => {
        firstFrame = undefined;
        trace.mark('native.first_frame', { mediaSeconds: metadata.mediaTime });
      });
    return () => {
      for (const [event, listener] of listeners) video.removeEventListener(event, listener);
      if (firstFrame !== undefined) video.cancelVideoFrameCallback(firstFrame);
      seeking?.({ outcome: 'cancelled' });
      waiting?.({ outcome: 'cancelled' });
      // React StrictMode replays effects; keep one timeline across that replay.
      queueMicrotask(() => {
        if (generation.current === current) trace.close();
      });
    };
  }, [media, trace]);
  return trace;
}
