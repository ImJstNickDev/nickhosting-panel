import { z } from 'zod';
import type { Resources } from './service-contracts.js';

export type DisplayResources = {
  current_state: Resources['current_state'] | 'unknown';
  resources: Partial<Resources['resources']>;
};
const statsSchema = z.object({
  memory_bytes: z.number().nonnegative(),
  cpu_absolute: z.number().nonnegative(),
  disk_bytes: z.number().nonnegative().optional(),
  uptime: z.number().nonnegative().optional(),
  network: z
    .object({ rx_bytes: z.number().nonnegative(), tx_bytes: z.number().nonnegative() })
    .optional(),
});
export function parseConsoleResources(value: unknown) {
  const result = statsSchema.safeParse(value);
  if (!result.success) return undefined;
  return {
    memory_bytes: result.data.memory_bytes,
    cpu_absolute: result.data.cpu_absolute,
    disk_bytes: result.data.disk_bytes,
    uptime: result.data.uptime,
    network_rx_bytes: result.data.network?.rx_bytes,
    network_tx_bytes: result.data.network?.tx_bytes,
  };
}

export type TelemetrySample = { time: number; cpu: number; memory: number; rx: number; tx: number };
/** Keep real observations only, with at most one (latest) sample per second. */
export function rollingTelemetry(samples: TelemetrySample[], now: number) {
  const seconds = new Map<number, TelemetrySample>();
  for (const sample of samples.slice().sort((a, b) => a.time - b.time)) {
    if (sample.time > now || sample.time < now - 30000) continue;
    seconds.set(Math.floor(sample.time / 1000), sample);
  }
  return [...seconds.values()].slice(-31);
}

export function networkRates(samples: TelemetrySample[], direction: 'rx' | 'tx') {
  return samples.map((sample, index) => {
    const previous = samples[index - 1];
    if (!previous) return { time: sample.time, value: NaN };
    const elapsed = sample.time - previous.time;
    const delta = sample[direction] - previous[direction];
    return {
      time: sample.time,
      value: elapsed > 0 && elapsed <= 2500 && delta >= 0 ? (delta * 1000) / elapsed : NaN,
    };
  });
}
