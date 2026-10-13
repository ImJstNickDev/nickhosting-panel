import type { createLogger } from '@nickhosting/core';
import { z } from 'zod';
import { motionTimingPhases } from '../../../packages/core/src/motion-timing.js';

const duration = z.number().finite().min(0).max(300_000);
export const motionTimingInput = z.strictObject({
  traceId: z.uuid(),
  events: z
    .array(
      z.strictObject({
        phase: z.enum(motionTimingPhases),
        atMs: duration,
        durationMs: duration.optional(),
        outcome: z.enum(['succeeded', 'failed', 'cancelled']).optional(),
        count: z.number().int().min(0).max(1_000_000).optional(),
        bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        status: z.number().int().min(0).max(599).optional(),
        mediaSeconds: z.number().finite().min(0).max(1_000_000).optional(),
        requestId: z.uuid().optional(),
        serverMs: duration.optional(),
      }),
    )
    .min(1)
    .max(48),
});
const identity = z.strictObject({
  traceId: z.uuid(),
  purpose: z.enum(['native', 'discovery', 'mse', 'subtitles', 'thumbnail']),
});
type Phase =
  | 'principal'
  | 'management'
  | 'viewerOpen'
  | 'retainedAcquire'
  | 'parserOpen'
  | 'subtitleWindow';
export type ViewerTiming = NonNullable<ReturnType<typeof createViewerTiming>>;
export function createViewerTiming(
  logger: ReturnType<typeof createLogger> | undefined,
  input: { traceId?: string; purpose?: string; requestId?: string; serverId?: string },
) {
  // No allocation of clocks or instrumentation when diagnostics are disabled.
  if (!logger?.isEnabled('debug')) return undefined;
  const parsed = identity.safeParse({ traceId: input.traceId, purpose: input.purpose });
  if (!parsed.success) return undefined;
  const started = performance.now();
  const phases: Partial<Record<Phase, number>> = {};
  let finished = false,
    bytes = 0,
    firstByteMs: number | undefined;
  let headersReadyMs: number | undefined, cacheHit: boolean | undefined;
  const elapsed = () => Math.round((performance.now() - started) * 1000) / 1000;
  const finish = (outcome: 'succeeded' | 'failed' | 'cancelled') => {
    if (finished) return;
    finished = true;
    try {
      logger.log('debug', 'viewer.motion_request', {
        requestId: input.requestId,
        serverId: input.serverId,
        ...parsed.data,
        durationMs: elapsed(),
        headersReadyMs,
        firstByteMs,
        bytes,
        outcome,
        cacheHit,
        phases,
      });
    } catch {
      /* Diagnostics never change a media response. */
    }
  };
  return {
    streaming: false,
    async measure<T>(phase: Phase, work: () => Promise<T>): Promise<T> {
      const start = performance.now();
      try {
        return await work();
      } finally {
        phases[phase] = Math.round((performance.now() - start) * 1000) / 1000;
      }
    },
    cache(hit: boolean) {
      cacheHit = hit;
    },
    headers(response: Response) {
      headersReadyMs = elapsed();
      try {
        response.headers.append('Server-Timing', `nh-motion;dur=${headersReadyMs}`);
      } catch {}
    },
    chunk(size: number) {
      if (firstByteMs === undefined) firstByteMs = elapsed();
      bytes += size;
    },
    finish,
  };
}

/** Debug-only, bounded in-memory per-session intake; no persistent telemetry state. */
export function motionTimingLimiter() {
  const windows = new Map<string, { count: number; until: number }>();
  return (key: string) => {
    const now = Date.now();
    let item = windows.get(key);
    if (!item || item.until <= now) {
      if (windows.size >= 512) {
        for (const [id, window] of windows) if (window.until <= now) windows.delete(id);
        if (windows.size >= 512) return false;
      }
      item = { count: 0, until: now + 60_000 };
      windows.set(key, item);
    }
    return ++item.count <= 30;
  };
}
