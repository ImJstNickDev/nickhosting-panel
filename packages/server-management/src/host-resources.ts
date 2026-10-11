import { readFile, statfs } from 'node:fs/promises';
import { cpus } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '@nickhosting/core';

type CpuCounters = ReturnType<typeof cpus>[number]['times'][];

export type HostResourceSample = Awaited<ReturnType<typeof readResources>>;

/** Per-observer baseline: no shared global state or cached filesystem observations. */
export function createHostResourceSampler() {
  let baseline: { counters: CpuCounters; at: number } | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Promise<HostResourceSample>>();
  const collect = async (path: string): Promise<HostResourceSample> => {
    try {
      const now = performance.now();
      const elapsed = baseline ? now - baseline.at : 0;
      const warm = baseline && elapsed >= 250 && elapsed <= 4000;
      const before = warm && baseline ? baseline.counters : cpus().map((cpu) => ({ ...cpu.times }));
      if (!warm) await delay(250);
      const after = cpus().map((cpu) => ({ ...cpu.times }));
      const at = performance.now();
      const result = await readResources(path, before, after);
      baseline = { counters: after, at };
      return result;
    } catch (error) {
      baseline = undefined;
      throw error;
    }
  };
  return {
    sample(path: string): Promise<HostResourceSample> {
      const existing = pending.get(path);
      if (existing) return existing;
      const result = tail.then(() => collect(path));
      pending.set(path, result);
      tail = result.then(
        () => pending.delete(path),
        () => pending.delete(path),
      );
      return result;
    },
  };
}

/** Compatibility one-shot collector; periodic observers should retain a sampler. */
export function sampleLocalResources(path: string) {
  return createHostResourceSampler().sample(path);
}

/** The host counters, not the application's cgroup CPU quota, define physical capacity. */
async function readResources(path: string, before: CpuCounters, after: CpuCounters) {
  if (!before.length || before.length !== after.length)
    throw new DomainError('integration_unavailable');
  let idle = 0;
  let total = 0;
  for (let i = 0; i < before.length; i++) {
    const a = after[i];
    const b = before[i];
    if (!a || !b) throw new DomainError('integration_unavailable');
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq'] as const) {
      const delta = a[key] - b[key];
      if (!Number.isFinite(a[key]) || !Number.isFinite(b[key]) || b[key] < 0 || delta < 0)
        throw new DomainError('integration_unavailable');
      total += delta;
      if (key === 'idle') idle += delta;
    }
  }
  if (!Number.isFinite(total) || total <= 0) throw new DomainError('integration_unavailable');
  const observedAt = new Date().toISOString();
  const [info, disk] = await Promise.all([readFile('/proc/meminfo', 'utf8'), statfs(path)]);
  const amount = (name: string) =>
    Number(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(info)?.[1]) / 1024;
  const totalMemoryMiB = amount('MemTotal');
  const availableMemoryMiB = amount('MemAvailable');
  const availableDiskMiB = (disk.bavail * disk.bsize) / 1048576;
  if (
    !Number.isFinite(totalMemoryMiB) ||
    totalMemoryMiB <= 0 ||
    !Number.isFinite(availableMemoryMiB) ||
    availableMemoryMiB < 0 ||
    availableMemoryMiB > totalMemoryMiB ||
    !Number.isFinite(availableDiskMiB) ||
    availableDiskMiB < 0 ||
    disk.bsize <= 0
  )
    throw new DomainError('integration_unavailable');
  const cpuCapacityPercent = after.length * 100;
  return {
    totalMemoryMiB,
    availableMemoryMiB,
    cpuCapacityPercent,
    cpuBusyPercent: (1 - idle / total) * cpuCapacityPercent,
    availableDiskMiB,
    observedAt,
  };
}
