export type History = { t: number[]; [series: string]: (number | null)[] | undefined };
export type Sample = { stamp: number; row: number };

export function orderedSamples(history: History): Sample[] {
  return history.t.map((stamp, row) => ({ stamp, row })).sort((a, b) => a.stamp - b.stamp);
}

export function nearestSample(samples: Sample[], stamp: number, start: number, end: number) {
  let low = start;
  let high = end;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const middle = samples[mid];
    if (middle && middle.stamp < stamp) low = mid + 1;
    else high = mid;
  }
  const previous = samples[low - 1];
  const next = samples[low];
  if (low > start && previous && next && stamp - previous.stamp <= next.stamp - stamp)
    return low - 1;
  return low;
}

export function valueAxis(values: number[], integral: boolean) {
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const target = (high - low || 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const multiplier = [1, 2, 2.5, 5, 10].find((k) => k * magnitude >= target) ?? 10;
  const rounded = multiplier * magnitude;
  const step = integral ? Math.max(1, Math.ceil(rounded)) : rounded;
  const first = Math.floor(low / step);
  const last = Math.max(first + 1, Math.ceil(high / step));
  if (
    !Number.isFinite(last - first) ||
    !Number.isFinite(last * step) ||
    !Number.isFinite(first * step)
  ) {
    return { low, high, ticks: [low, high] };
  }
  const ticks = Array.from({ length: last - first + 1 }, (_, i) => (first + i) * step);
  return { low: first * step, high: last * step, ticks };
}

// Divide first for very large finite readings whose difference would overflow.
export function plotPercent(value: number, low: number, high: number) {
  if (high === low) return 50;
  const span = high - low;
  return (
    100 *
    (Number.isFinite(span) ? (value - low) / span : (value / 2 - low / 2) / (high / 2 - low / 2))
  );
}

export function seriesPath(
  samples: Sample[],
  values: History[string],
  timeAt: (stamp: number) => number,
  heightAt: (value: number) => number,
) {
  let d = '';
  let connected = false;
  for (const { stamp, row } of samples) {
    const value = values?.[row];
    if (value == null) {
      connected = false;
      continue;
    }
    const x = timeAt(stamp).toFixed(3);
    const y = heightAt(value).toFixed(3);
    // A zero-length segment with a round cap also paints an isolated sample.
    d += connected ? `L${x},${y}` : `M${x},${y}l0,0`;
    connected = true;
  }
  return d;
}
