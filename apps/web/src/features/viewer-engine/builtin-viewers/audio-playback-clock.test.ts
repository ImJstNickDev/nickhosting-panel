import { describe, expect, it } from 'vitest';
import { AudioPlaybackClock } from './audio-playback-clock.js';

describe('Wave visual playback clock', () => {
  it.each([60, 120, 144, 240])(
    'bridges 40ms native ticks at %iHz without backward steps or drift',
    (hz) => {
      const clock = new AudioPlaybackClock();
      clock.reset(0, 0);
      let previous = 0;
      for (let frame = 1; frame <= hz * 30; frame++) {
        const now = (frame * 1000) / hz;
        const native = Math.floor(now / 40) * 0.04;
        const position = clock.sample(native, now, 1);
        expect(position).toBeGreaterThan(previous);
        expect(position - previous).toBeLessThanOrEqual(1.101 / hz);
        expect(Math.abs(position - now / 1000)).toBeLessThan(0.06);
        previous = position;
      }
    },
  );

  it.each([0.5, 2])('uses the media playback rate %i', (rate) => {
    const clock = new AudioPlaybackClock();
    clock.reset(5, 0);
    expect(clock.sample(5, 25, rate)).toBeCloseTo(5 + 0.025 * rate);
    expect(clock.sample(5, 50, rate)).toBeCloseTo(5 + 0.05 * rate);
  });

  it('stops predicting after 100ms without any native advance', () => {
    const clock = new AudioPlaybackClock();
    clock.reset(5, 0);
    for (let now = 4; now <= 2000; now += 4) clock.sample(5, now, 1);
    expect(clock.sample(5, 2004, 1)).toBeCloseTo(5.1);
  });

  it('snaps on explicit holds/seeks and resets the prediction anchor', () => {
    const clock = new AudioPlaybackClock();
    clock.reset(5, 0);
    expect(clock.sample(5, 30, 1)).toBeGreaterThan(5);
    expect(clock.reset(5, 30)).toBe(5);
    expect(clock.reset(20, 1000)).toBe(20);
    expect(clock.sample(20, 1005, 1)).toBeCloseTo(20.005);
  });

  it('snaps for backwards loops, large discontinuities and suspended frames', () => {
    const clock = new AudioPlaybackClock();
    clock.reset(5, 0);
    expect(clock.sample(0, 10, 1)).toBe(0);
    expect(clock.sample(10, 20, 1)).toBe(10);
    expect(clock.sample(10.01, 1500, 1)).toBe(10.01);
    expect(clock.sample(10.01, 1505, 1)).toBeCloseTo(10.015);
  });
});
