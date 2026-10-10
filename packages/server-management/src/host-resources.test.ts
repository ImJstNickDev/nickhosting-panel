import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, type CpuInfo, cpus } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleLocalResources } from './host-resources.js';

vi.mock('node:os', () => ({ cpus: vi.fn(), availableParallelism: vi.fn(() => 1) }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), statfs: vi.fn() }));
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));
const counters = (count: number, user: number, idle: number): CpuInfo[] =>
  Array.from({ length: count }, () => ({
    model: 'fixture',
    speed: 1000,
    times: { user, idle, nice: 0, sys: 0, irq: 0 },
  }));
const diskPath = '/app/mountdata';

describe('physical host resource samples', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(availableParallelism).mockReturnValue(1);
    vi.mocked(cpus)
      .mockReturnValueOnce(counters(14, 100, 100))
      .mockReturnValueOnce(counters(14, 125, 175));
    vi.mocked(readFile).mockResolvedValue(
      'MemTotal:       16777216 kB\nMemAvailable:   8388608 kB\n',
    );
    vi.mocked(statfs).mockResolvedValue({ bavail: 1024, bsize: 4096 } as Awaited<
      ReturnType<typeof statfs>
    >);
  });

  it('measures all 14 physical CPU counters despite the application having a one-CPU quota', async () => {
    expect(await sampleLocalResources(diskPath)).toMatchObject({
      totalMemoryMiB: 16384,
      availableMemoryMiB: 8192,
      cpuCapacityPercent: 1400,
      cpuBusyPercent: 350,
      availableDiskMiB: 4,
    });
    expect(availableParallelism).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith('/proc/meminfo', 'utf8');
    expect(statfs).toHaveBeenCalledWith(diskPath);
  });

  it.each([
    ['no CPUs', [], []],
    ['CPU count changed', counters(2, 100, 100), counters(1, 150, 150)],
    ['counter regressed', counters(1, 100, 100), counters(1, 90, 150)],
    ['no elapsed counters', counters(1, 100, 100), counters(1, 100, 100)],
    ['invalid counter', counters(1, 100, 100), counters(1, Number.NaN, 150)],
  ] as const)('fails closed on %s', async (_label, before, after) => {
    vi.mocked(cpus)
      .mockReset()
      .mockReturnValueOnce([...before])
      .mockReturnValueOnce([...after]);
    await expect(sampleLocalResources(diskPath)).rejects.toThrow();
  });

  it.each([
    'MemTotal: 16777216 kB\n',
    'MemTotal: 1024 kB\nMemAvailable: 2048 kB\n',
    'MemTotal: 0 kB\nMemAvailable: 0 kB\n',
  ])('fails closed on missing or inconsistent memory readings', async (memory) => {
    vi.mocked(readFile).mockResolvedValue(memory);
    await expect(sampleLocalResources(diskPath)).rejects.toThrow();
  });

  it('does not substitute another filesystem when the configured path is unavailable', async () => {
    vi.mocked(statfs).mockRejectedValue(new Error('missing mount'));
    await expect(sampleLocalResources(diskPath)).rejects.toThrow('missing mount');
    expect(statfs).toHaveBeenCalledExactlyOnceWith(diskPath);
  });
});
