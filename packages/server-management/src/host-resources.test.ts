import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, type CpuInfo, cpus } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostResourceSampler, sampleLocalResources } from './host-resources.js';

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
  afterEach(() => vi.restoreAllMocks());

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

  it('uses successive periodic CPU endpoints without another sampling wait', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const sampler = createHostResourceSampler();
    await sampler.sample(diskPath);
    clock.mockReturnValue(1000);
    vi.mocked(cpus).mockReturnValueOnce(counters(14, 150, 250));
    expect(await sampler.sample(diskPath)).toMatchObject({ cpuBusyPercent: 350 });
    expect(cpus).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledExactlyOnceWith(250);
    expect(statfs).toHaveBeenCalledTimes(2);
  });

  it.each([4001, -1, 100])('takes a new window when the baseline age is %i ms', async (age) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const sampler = createHostResourceSampler();
    await sampler.sample(diskPath);
    clock.mockReturnValue(age);
    vi.mocked(cpus)
      .mockReturnValueOnce(counters(14, 150, 250))
      .mockReturnValueOnce(counters(14, 175, 325));
    expect(await sampler.sample(diskPath)).toMatchObject({ cpuBusyPercent: 350 });
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['regression', counters(14, 100, 250)],
    ['CPU topology change', counters(1, 150, 250)],
  ] as const)('rejects a warm %s and cold-starts the next observation', async (_label, bad) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const sampler = createHostResourceSampler();
    await sampler.sample(diskPath);
    clock.mockReturnValue(1000);
    vi.mocked(cpus).mockReturnValueOnce([...bad]);
    await expect(sampler.sample(diskPath)).rejects.toThrow();
    vi.mocked(cpus)
      .mockReturnValueOnce(counters(14, 150, 250))
      .mockReturnValueOnce(counters(14, 175, 325));
    await expect(sampler.sample(diskPath)).resolves.toMatchObject({ cpuBusyPercent: 350 });
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent observations only for the same disk path', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.mocked(cpus)
      .mockReturnValueOnce(counters(14, 150, 250))
      .mockReturnValueOnce(counters(14, 175, 325));
    vi.mocked(statfs)
      .mockResolvedValueOnce({ bavail: 1024, bsize: 4096 } as Awaited<ReturnType<typeof statfs>>)
      .mockResolvedValueOnce({ bavail: 2048, bsize: 4096 } as Awaited<ReturnType<typeof statfs>>);
    const sampler = createHostResourceSampler();
    const first = sampler.sample(diskPath);
    expect(sampler.sample(diskPath)).toBe(first);
    const other = sampler.sample('/another-mount');
    expect((await first).availableDiskMiB).toBe(4);
    expect((await other).availableDiskMiB).toBe(8);
    expect(vi.mocked(statfs).mock.calls.map(([path]) => path)).toEqual([
      diskPath,
      '/another-mount',
    ]);
  });

  it('reads memory and disk concurrently and clears the baseline after an I/O failure', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const sampler = createHostResourceSampler();
    await sampler.sample(diskPath);
    clock.mockReturnValue(1000);
    vi.mocked(cpus).mockReturnValueOnce(counters(14, 150, 250));
    let release!: (value: string) => void;
    vi.mocked(readFile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    vi.mocked(statfs).mockRejectedValueOnce(new Error('unavailable mount'));
    await expect(sampler.sample(diskPath)).rejects.toThrow('unavailable mount');
    expect(release).toBeTypeOf('function');
    release('MemTotal: 1024 kB\nMemAvailable: 512 kB\n');
    vi.mocked(cpus)
      .mockReturnValueOnce(counters(14, 175, 325))
      .mockReturnValueOnce(counters(14, 200, 400));
    await expect(sampler.sample(diskPath)).resolves.toMatchObject({ cpuBusyPercent: 350 });
    expect(delay).toHaveBeenCalledTimes(2);
  });
});
