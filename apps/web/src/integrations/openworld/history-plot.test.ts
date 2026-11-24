import { expect, it } from 'vitest';
import {
  nearestSample,
  orderedSamples,
  plotPercent,
  seriesPath,
  valueAxis,
} from './history-plot.js';

it('keeps sub-unit ticks distinct and count ticks integral even at zero', () => {
  const tiny = valueAxis([0, 0.0037], false);
  expect(tiny.ticks).toEqual([0, 0.001, 0.002, 0.003, 0.004]);
  expect(valueAxis([0], true).ticks).toEqual([0, 1]);
  const counts = valueAxis([2, 12], true);
  expect(counts.high).toBeGreaterThanOrEqual(12);
  expect(counts.ticks.every(Number.isInteger)).toBe(true);
});

it('uses observed times and original rows when selecting irregular, out-of-order samples inside a zoom', () => {
  const samples = orderedSamples({ t: [1000, 980, 2510, 1010] });
  expect(samples.map((s) => s.row)).toEqual([1, 0, 3, 2]);
  expect(nearestSample(samples, 1600, 0, 3)).toBe(2);
  expect(nearestSample(samples, 2400, 0, 2)).toBe(2);
  expect(nearestSample(samples, 0, 2, 3)).toBe(2);
  expect(plotPercent(1010, 980, 2510)).toBeCloseTo(1.96, 2);
  expect(plotPercent(980, 980, 980)).toBe(50);
});

it('paints real zeros and isolated samples without drawing through missing measurements', () => {
  const samples = orderedSamples({ t: [0, 1, 2, 4] });
  const path = seriesPath(
    samples,
    [0, null, 1, 2],
    (stamp) => stamp,
    (value) => 2 - value,
  );
  expect(path).toBe('M0.000,2.000l0,0M2.000,1.000l0,0L4.000,0.000');
  expect(seriesPath(samples, undefined, Number, Number)).toBe('');
});

it('keeps an axis and coordinates finite at the numeric limits accepted by telemetry', () => {
  for (const values of [
    [Number.MIN_VALUE],
    [Number.MAX_VALUE],
    [-Number.MAX_VALUE],
    [-Number.MAX_VALUE, Number.MAX_VALUE],
  ]) {
    const axis = valueAxis(values, false);
    expect(axis.ticks.every(Number.isFinite)).toBe(true);
    expect(values.every((v) => Number.isFinite(plotPercent(v, axis.low, axis.high)))).toBe(true);
  }
});
