/** Fixed diagnostic vocabulary: never filenames, URLs, captions or arbitrary errors. */
export const motionTimingPhases = [
  'viewer.mounted',
  'viewer.closed',
  'native.loadstart',
  'native.metadata',
  'native.loadeddata',
  'native.canplay',
  'native.play',
  'native.playing',
  'native.pause',
  'native.waiting',
  'native.error',
  'native.first_frame',
  'native.seek',
  'video.discovery',
  'video.range',
  'video.range_queue',
  'video.range_headers',
  'mse.start',
  'mse.metadata',
  'mse.first_packets',
  'mse.source_open',
  'mse.first_buffer',
  'subtitles.discovery',
  'subtitles.renderer',
  'subtitles.renderer_import',
  'subtitles.fonts',
  'subtitles.renderer_setup',
  'subtitles.window',
  'subtitles.apply',
] as const;
export type MotionTimingPhase = (typeof motionTimingPhases)[number];
export type MotionTimingValues = {
  durationMs?: number;
  outcome?: 'succeeded' | 'failed' | 'cancelled';
  count?: number;
  bytes?: number;
  status?: number;
  mediaSeconds?: number;
  requestId?: string;
  serverMs?: number;
};
export type MotionTimingEvent = MotionTimingValues & { phase: MotionTimingPhase; atMs: number };
export interface MotionTrace {
  mark(phase: MotionTimingPhase, values?: MotionTimingValues): void;
  span(phase: MotionTimingPhase): (values?: MotionTimingValues) => void;
  url(url: string, purpose?: 'native' | 'discovery' | 'mse' | 'subtitles' | 'thumbnail'): string;
}
