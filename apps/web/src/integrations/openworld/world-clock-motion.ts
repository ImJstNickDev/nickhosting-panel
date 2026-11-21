/** Time and velocity on the continuous game-day axis. Only the drawing wraps at midnight. */
export type ClockReading = {
  fraction: number;
  observedAt: number;
  dayLengthS: number;
  tick?: number | null;
  tickBudgetMs?: number | null;
};

const easingSeconds = 1.5;
const correctionSeconds = 8;
// Three missed status polls. A stalled connection must not animate indefinitely.
export const predictionLimitMs = 15_000;

export function dayPhase(position: number) {
  return position - Math.floor(position);
}

function phaseDifference(delta: number) {
  return delta - Math.round(delta);
}

type ClockMotion = {
  reading: ClockReading;
  receivedAt: number;
  position: number;
  initialRate: number;
  targetRate: number;
};

export function clockAt(motion: ClockMotion, now: number) {
  const elapsed = Math.max(0, Math.min(now - motion.receivedAt, predictionLimitMs)) / 1000;
  const blend = -Math.expm1(-elapsed / easingSeconds);
  const rateChange = motion.targetRate - motion.initialRate;
  // Integrate the easing curve so display refresh rate never affects the clock.
  return {
    position: motion.position + motion.targetRate * elapsed - rateChange * easingSeconds * blend,
    rate:
      now - motion.receivedAt >= predictionLimitMs ? 0 : motion.initialRate + rateChange * blend,
  };
}

function observedRate(previous: ClockReading, next: ClockReading) {
  const nominal = 1 / next.dayLengthS;
  const intervalMs = next.observedAt - previous.observedAt;
  if (intervalMs > predictionLimitMs || next.dayLengthS !== previous.dayLengthS) return nominal;
  // Count completed simulation ticks over the pair of samples. The instantaneous TPS
  // field can report a healthy rate between long stalls.
  if (
    next.tick != null &&
    previous.tick != null &&
    next.tickBudgetMs != null &&
    next.tickBudgetMs > 0
  ) {
    const ticks = next.tick - previous.tick;
    if (ticks < 0) return nominal; // A new server process.
    return Math.min(2, (ticks * next.tickBudgetMs) / intervalMs) * nominal;
  }
  // Older status payloads can omit tick counters. Reject preset-time changes as speed samples.
  const rate = (phaseDifference(next.fraction - previous.fraction) * 1000) / intervalMs;
  return rate >= 0 && rate <= 2 * nominal ? rate : nominal;
}

export function observeClock(
  previous: ClockMotion | null,
  reading: ClockReading,
  now: number,
): ClockMotion {
  const nominal = 1 / reading.dayLengthS;
  if (!previous) {
    return {
      reading,
      receivedAt: now,
      position: reading.fraction,
      initialRate: nominal,
      targetRate: nominal,
    };
  }
  if (reading.observedAt <= previous.reading.observedAt) return previous;
  const { position, rate } = clockAt(previous, now);
  const error = phaseDifference(reading.fraction - position);
  const targetRate = Math.max(
    0,
    Math.min(4 * nominal, observedRate(previous.reading, reading) + error / correctionSeconds),
  );
  return { reading, receivedAt: now, position, initialRate: rate, targetRate };
}
