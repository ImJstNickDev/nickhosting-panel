import { describe, expect, it, vi } from 'vitest';
import { createUploadTiming } from './upload-timing.js';

describe('request-local bounded upload timing', () => {
  it('aggregates repeated spans, rounds only snapshots and ends a manual span once', async () => {
    let now = 0;
    const trace = createUploadTiming(true, () => now);
    expect(
      trace.measureSync('access.read', () => {
        now = 1.23456;
        return 'value';
      }),
    ).toBe('value');
    await expect(
      trace.measure('access.read', async () => {
        now += 2.34567;
        return 3;
      }),
    ).resolves.toBe(3);
    const stop = trace.start('admission.lock');
    now += 3;
    stop();
    now += 99;
    stop();
    expect(trace.snapshot()).toEqual({
      'access.read': { count: 2, totalMs: 3.58, maxMs: 2.346 },
      'admission.lock': { count: 1, totalMs: 3, maxMs: 3 },
    });
    const copy = trace.snapshot();
    const observed = copy['access.read'];
    if (!observed) throw new Error('Missing fixture timing');
    observed.count = 100;
    expect(trace.snapshot()['access.read']?.count).toBe(2);
  });

  it('isolates concurrent request traces and overlapping spans', async () => {
    let now = 0;
    const first = createUploadTiming(true, () => now),
      second = createUploadTiming(true, () => now);
    const finishA = Promise.withResolvers<void>(),
      finishB = Promise.withResolvers<void>();
    const a = first.measure('admission.lock', () => finishA.promise);
    now = 2;
    const b = second.measure('admission.lock', () => finishB.promise);
    const overlapping = first.start('access.query');
    now = 5;
    finishA.resolve();
    await a;
    overlapping();
    now = 9;
    finishB.resolve();
    await b;
    expect(first.snapshot()).toEqual({
      'admission.lock': { count: 1, totalMs: 5, maxMs: 5 },
      'access.query': { count: 1, totalMs: 3, maxMs: 3 },
    });
    expect(second.snapshot()).toEqual({
      'admission.lock': { count: 1, totalMs: 7, maxMs: 7 },
    });
  });

  it('records failed spans without retaining error details and never masks an original error', async () => {
    let now = 0;
    const error = new Error('private fixture payload');
    const trace = createUploadTiming(true, () => now);
    await expect(
      trace.measure('admission.query', async () => {
        now = 4;
        throw error;
      }),
    ).rejects.toBe(error);
    expect(() =>
      trace.measureSync('admission.validation', () => {
        now = 5;
        throw error;
      }),
    ).toThrow(error);
    expect(trace.snapshot()).toEqual({
      'admission.query': { count: 1, totalMs: 4, maxMs: 4 },
      'admission.validation': { count: 1, totalMs: 1, maxMs: 1 },
    });
    expect(JSON.stringify(trace.snapshot())).not.toContain('private');
    const brokenClock = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockImplementation(() => {
        throw new Error('diagnostics unavailable');
      });
    const degraded = createUploadTiming(true, brokenClock);
    await expect(
      degraded.measure('phase', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(degraded.measureSync('phase', () => 42)).toBe(42);
  });

  it('bounds the label set and ignores unsafe labels without affecting work', async () => {
    let now = 0;
    const trace = createUploadTiming(true, () => ++now);
    for (const name of ['a'.repeat(65), 'SELECT * FROM users', '/world/a', 'phase:id', '__proto__'])
      expect(trace.measureSync(name, () => 1)).toBe(1);
    expect(trace.snapshot()).toEqual({});
    for (let i = 0; i < 100; i++) await trace.measure(`phase${i}`, async () => {});
    expect(Object.keys(trace.snapshot())).toHaveLength(64);
    expect(trace.snapshot().phase64).toBeUndefined();
    trace.measureSync('phase0', () => {});
    expect(trace.snapshot().phase0?.count).toBe(2);
  });

  it('does no clock work when disabled and preserves synchronous and asynchronous failures', async () => {
    const clock = vi.fn<() => number>();
    const trace = createUploadTiming(false, clock);
    const error = new Error('original');
    trace.start('phase')();
    expect(trace.measureSync('phase', () => 7)).toBe(7);
    await expect(trace.measure('phase', async () => 8)).resolves.toBe(8);
    expect(() =>
      trace.measureSync('phase', () => {
        throw error;
      }),
    ).toThrow(error);
    await expect(
      trace.measure('phase', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(trace.snapshot()).toEqual({});
    expect(clock).not.toHaveBeenCalled();
  });
});
