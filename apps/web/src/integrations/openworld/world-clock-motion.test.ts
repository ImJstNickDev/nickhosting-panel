import { describe, expect, it } from 'vitest';
import { clockAt, dayPhase, observeClock, predictionLimitMs } from './world-clock-motion.js';

const nominal = 1 / 1500;
const sample = (fraction: number, observedAt: number, tick = observedAt / 50) => ({
  fraction,
  observedAt,
  tick,
  tickBudgetMs: 50,
  dayLengthS: 1500,
});

describe('Openworld display clock', () => {
  it('uses the declared day length between reads, independently of frame cadence', () => {
    const start = observeClock(null, { ...sample(0.4, 0), dayLengthS: 1200 }, 800);
    expect(clockAt(start, 3800).position).toBeCloseTo(0.4 + 3 / 1200, 12);
    expect(clockAt(start, 3800).rate).toBeCloseTo(1 / 1200, 12);
  });

  it('eases toward the measured tick rate under sustained load', () => {
    let clock = observeClock(null, sample(0.45, 0), 0);
    const expectedRate = nominal * (3.2 / 20);
    for (let seconds = 5; seconds <= 100; seconds += 5) {
      const at = seconds * 1000;
      const before = clockAt(clock, at);
      clock = observeClock(clock, sample(0.45 + seconds * expectedRate, at, seconds * 3.2), at);
      expect(clockAt(clock, at)).toEqual(before);
      expect(clockAt(clock, at + 50).rate).toBeGreaterThanOrEqual(0);
    }
    const current = clockAt(clock, 101000);
    expect(Math.abs(current.rate / expectedRate - 1)).toBeLessThan(0.001);
    expect(Math.abs(current.position - (0.45 + 101 * expectedRate)) * 86400).toBeLessThan(1);
  });

  it.each([0.3, 0.72])(
    'keeps position and velocity continuous when the game time is set to %s',
    (fraction) => {
      const start = observeClock(null, sample(0.5, 0), 0);
      const before = clockAt(start, 5000);
      const steered = observeClock(start, sample(fraction, 5000), 5000);
      expect(clockAt(steered, 5000)).toEqual(before);
      const soon = clockAt(steered, 5016);
      expect(soon.position).toBeGreaterThan(before.position);
      expect(soon.rate / before.rate).toBeCloseTo(1, 1);
      const later = clockAt(steered, 8000);
      expect(later.position).toBeGreaterThan(soon.position);
      if (fraction < 0.5) expect(later.rate).toBeLessThan(soon.rate);
      else expect(later.rate).toBeGreaterThan(soon.rate);
    },
  );

  it('unwraps a midnight crossing and ignores duplicate or older observations', () => {
    const start = observeClock(null, sample(0.999, 0), 0);
    const next = observeClock(start, sample(dayPhase(0.999 + 5 * nominal), 5000), 5000);
    expect(clockAt(next, 6000).position).toBeCloseTo(0.999 + 6 * nominal, 12);
    expect(observeClock(next, sample(0.3, 5000), 12000)).toBe(next);
    expect(observeClock(next, sample(0.3, 4000), 13000)).toBe(next);
  });

  it('uses progress across midnight when the status omits tick counters', () => {
    const start = observeClock(null, { ...sample(0.999, 0), tick: null }, 0);
    const rate = nominal / 2;
    const next = observeClock(
      start,
      { ...sample(dayPhase(0.999 + rate * 5), 5000), tick: null },
      5000,
    );
    expect(next.targetRate).toBeGreaterThan(0);
    expect(next.targetRate).toBeLessThan(rate);
  });

  it('stops extrapolating after missed polls and restarts smoothly on the next reading', () => {
    const start = observeClock(null, sample(0.1, 0), 0);
    const stopped = clockAt(start, predictionLimitMs);
    expect(clockAt(start, 60000)).toEqual(stopped);
    expect(stopped.rate).toBe(0);
    const fresh = observeClock(start, sample(0.14, 60000), 60000);
    expect(clockAt(fresh, 60000)).toEqual(stopped);
    expect(clockAt(fresh, 61000).position).toBeGreaterThan(stopped.position);
  });
});
