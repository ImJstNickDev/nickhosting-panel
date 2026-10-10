import { readFile, statfs } from 'node:fs/promises';
import { cpus } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '@nickhosting/core';

/** The host counters, not the application's cgroup CPU quota, define physical capacity. */
export async function sampleLocalResources(path: string) {
  const before = cpus().map((cpu) => cpu.times);
  await delay(250);
  const after = cpus().map((cpu) => cpu.times);
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
  const info = await readFile('/proc/meminfo', 'utf8');
  const amount = (name: string) =>
    Number(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(info)?.[1]) / 1024;
  const totalMemoryMiB = amount('MemTotal');
  const availableMemoryMiB = amount('MemAvailable');
  const disk = await statfs(path);
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
    observedAt: new Date().toISOString(),
  };
}
