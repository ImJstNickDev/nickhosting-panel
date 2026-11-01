import { describe, expect, it } from 'vitest';
import {
  readWaveformPeak,
  waveformBars,
  waveformEligible,
  waveformLimits,
} from './audio-waveform-model.js';

describe('Wave compact amplitude envelope', () => {
  it('only analyzes bounded files after finite native duration metadata', () => {
    expect(waveformEligible(waveformLimits.bytes, 600)).toBe(true);
    for (const [size, duration] of [
      [0, 1],
      [1, 0],
      [1, Number.NaN],
      [1, Number.POSITIVE_INFINITY],
      [1, 601],
      [waveformLimits.bytes + 1, 1],
    ] as const) {
      expect(waveformEligible(size, duration)).toBe(false);
    }
  });
  it('preserves silence and combines stereo without phase cancellation', () => {
    expect(readWaveformPeak([new Float32Array(8)], 0, 8)).toBe(0);
    expect(
      readWaveformPeak([new Float32Array([0.5, -0.75]), new Float32Array([-0.5, 0.75])], 0, 2),
    ).toBe(0.75);
    expect(readWaveformPeak([new Float32Array([0.1]), new Float32Array([0.9])], 0, 1)).toBeCloseTo(
      0.9,
    );
  });
  it('handles partial windows, invalid amplitudes and clipping without invalid SVG geometry', () => {
    expect(
      readWaveformPeak([new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, -2])], -3, 50),
    ).toBe(1);
    expect(readWaveformPeak([], 0, 10)).toBe(0);
    expect(readWaveformPeak([new Float32Array([1])], 2, 4)).toBe(0);
  });
  it('reduces bars by peak without dropping tail samples or exceeding viewport bounds', () => {
    const peaks = new Float32Array([0.1, 0.5, 0.3, 0.2, 0.9]);
    expect(waveformBars(peaks, 2)).toEqual([peaks[1], peaks[4]]);
    expect(waveformBars(peaks, 100)).toHaveLength(5);
    expect(waveformBars(new Float32Array(1024), 1000)).toHaveLength(128);
    expect(waveformBars(peaks, Number.NaN)).toEqual([]);
    expect(waveformBars(peaks, 0)).toEqual([]);
    expect(waveformBars(new Float32Array(), 5)).toEqual([]);
  });
});
