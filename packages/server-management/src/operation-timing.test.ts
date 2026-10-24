import { createLogger } from '@nickhosting/core';
import { describe, expect, it, vi } from 'vitest';
import { createOperationTiming } from './operation-timing.js';

describe('bounded operation timeline', () => {
  it('shares children, aggregate samples and overlapping offsets without double counting wall time', async () => {
    let clock = 0;
    const trace = createOperationTiming(true, () => clock);
    const complete = Promise.withResolvers<number>();
    const first = trace.child('directory').measure('request', () => complete.promise);
    clock = 2;
    const stop = trace.child('file').start('read');
    clock = 5;
    complete.resolve(42);
    expect(await first).toBe(42);
    clock = 7;
    stop();
    clock = 8;
    stop();
    expect(trace.report()).toEqual({
      totalMs: 8,
      stages: {
        'directory.request': { count: 1, totalMs: 5, maxMs: 5 },
        'file.read': { count: 1, totalMs: 5, maxMs: 5 },
      },
      spanGroups: [
        [
          { name: 'directory.request', startMs: 0, durationMs: 5 },
          { name: 'file.read', startMs: 2, durationMs: 5 },
        ],
      ],
      droppedSpans: 0,
      droppedStageLabels: 0,
    });
    const copy = trace.report();
    const firstSpan = copy.spanGroups[0]?.[0];
    if (!firstSpan) throw new Error('Missing recorded span');
    firstSpan.name = 'changed';
    expect(trace.report().spanGroups[0]?.[0]?.name).toBe('directory.request');
  });

  it('preserves return values and errors without retaining their private contents', async () => {
    let clock = 0;
    const trace = createOperationTiming(true, () => ++clock);
    const error = new Error('private filename /world/server.properties');
    const value = { secret: 'not-a-timing-field' };
    expect(trace.measureSync('prepare', () => value)).toBe(value);
    await expect(
      trace.measure('dispatch', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(() =>
      trace.measureSync('parse', () => {
        throw error;
      }),
    ).toThrow(error);
    const summary = JSON.stringify(trace.report());
    expect(summary).not.toContain('private');
    expect(summary).not.toContain('properties');
    expect(summary).not.toContain('not-a-timing-field');
    expect(trace.snapshot().dispatch?.count).toBe(1);
  });

  it('retains late timeline stages beyond the aggregate budget and survives logger array limits', () => {
    let clock = 0;
    const trace = createOperationTiming(true, () => ++clock);
    for (let i = 0; i < 128; i++) trace.measureSync(`stage${i}`, () => {});
    for (let i = 0; i < 130; i++) trace.measureSync('stage0', () => {});
    trace.measureSync('overflow', () => {});
    const report = trace.report();
    expect(Object.keys(report.stages)).toHaveLength(64);
    expect(report.spanGroups.map((group) => group.length)).toEqual([96, 96, 64]);
    expect(report.spanGroups.flat().some((span) => span.name === 'stage127')).toBe(true);
    expect(report.droppedStageLabels).toBe(64);
    expect(report.droppedSpans).toBe(3);
    let logged: unknown;
    createLogger(
      (record) => {
        logged = record.data;
      },
      { level: 'debug' },
    ).log('debug', 'servers.world_selection_timing', report);
    expect(logged).toEqual(report);
  });

  it('ignores unsafe labels and broken clocks without changing execution', async () => {
    let clock = 0;
    const trace = createOperationTiming(true, () => ++clock);
    for (const label of ['/private/file', 'query with values', '__proto__', 'a'.repeat(65)])
      expect(trace.measureSync(label, () => 42)).toBe(42);
    expect(trace.report().spanGroups).toEqual([]);
    const brokenClock = vi.fn(() => {
      throw new Error('broken clock');
    });
    const disabled = createOperationTiming(true, brokenClock);
    expect(disabled.child('phase').measureSync('work', () => 3)).toBe(3);
    const afterStart = createOperationTiming(
      true,
      vi
        .fn<() => number>()
        .mockReturnValueOnce(1)
        .mockImplementation(() => {
          throw new Error('broken');
        }),
    );
    await expect(afterStart.measure('work', async () => 4)).resolves.toBe(4);
    expect(afterStart.report().totalMs).toBe(0);
  });

  it('performs no clock work when disabled, including child spans and reports', async () => {
    const clock = vi.fn(() => 0);
    const trace = createOperationTiming(false, clock);
    const failure = new Error('unchanged');
    trace.child('file').start('read')();
    expect(trace.measureSync('work', () => 7)).toBe(7);
    await expect(
      trace.measure('work', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(trace.report()).toEqual({
      totalMs: 0,
      stages: {},
      spanGroups: [],
      droppedSpans: 0,
      droppedStageLabels: 0,
    });
    expect(clock).not.toHaveBeenCalled();
  });
});
