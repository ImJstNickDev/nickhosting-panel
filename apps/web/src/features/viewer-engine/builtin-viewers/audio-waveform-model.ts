export const waveformLimits = { bytes: 32 * 1024 * 1024, seconds: 600, peaks: 1024 } as const;

export function waveformEligible(size: number, duration: number) {
  return (
    Number.isFinite(size) &&
    size > 0 &&
    size <= waveformLimits.bytes &&
    Number.isFinite(duration) &&
    duration > 0 &&
    duration <= waveformLimits.seconds
  );
}

/** Max magnitude across channels preserves peaks even for opposite-phase stereo. */
export function readWaveformPeak(channels: readonly Float32Array[], start: number, end: number) {
  let peak = 0;
  for (const channel of channels) {
    const stop = Math.min(channel.length, Math.max(0, Math.floor(end)));
    for (let index = Math.max(0, Math.floor(start)); index < stop; index++) {
      const value = channel[index] ?? 0;
      if (Number.isFinite(value)) peak = Math.max(peak, Math.min(1, Math.abs(value)));
    }
  }
  return peak;
}

/** Reduce compact analysis peaks to the current viewport's bar count. */
export function waveformBars(peaks: Float32Array, count: number): number[] {
  if (!Number.isFinite(count) || count < 1 || peaks.length === 0) return [];
  const bins = Math.min(128, Math.floor(count), peaks.length);
  return Array.from({ length: bins }, (_, index) =>
    readWaveformPeak(
      [peaks],
      Math.floor((index * peaks.length) / bins),
      Math.floor(((index + 1) * peaks.length) / bins),
    ),
  );
}
