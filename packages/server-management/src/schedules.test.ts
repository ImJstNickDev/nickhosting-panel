import { describe, expect, it } from 'vitest';
import { scheduleOccurrence, scheduleSchema } from './schedules.js';

describe('explicit schedule timing', () => {
  it('validates time zones, bounded intervals and supported non-destructive actions', () => {
    const input = {
      name: 'Backup',
      action: 'backup',
      timing: { kind: 'interval', firstAt: '2030-01-01T09:00:00Z', everySeconds: 3600 },
      timeZone: 'Europe/Rome',
      enabled: true,
    };
    expect(scheduleSchema.safeParse(input).success).toBe(true);
    for (const patch of [
      { action: 'wipe' },
      { timeZone: 'unknown/place' },
      { timing: { ...input.timing, everySeconds: 1 } },
      { timing: { ...input.timing, firstAt: '2030-01-01T09:00:00' } },
    ]) {
      expect(scheduleSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
  });

  it('coalesces outages to one latest occurrence without wall-clock/DST ambiguity', () => {
    const timing = {
      kind: 'interval' as const,
      firstAt: '2030-03-31T00:30:00Z',
      everySeconds: 3600,
    };
    const result = scheduleOccurrence(
      timing,
      new Date(timing.firstAt),
      new Date('2030-03-31T03:31:00Z'),
    );
    expect(result).toEqual({
      due: new Date('2030-03-31T03:30:00Z'),
      next: new Date('2030-03-31T04:30:00Z'),
      missed: 3,
      late: false,
    });
    expect(
      scheduleOccurrence(timing, new Date(timing.firstAt), new Date('2030-03-31T03:36:00Z')).late,
    ).toBe(true);
  });

  it('consumes late one-shots instead of running old intent after recovery', () => {
    expect(
      scheduleOccurrence(
        { kind: 'once', at: '2030-01-01T00:00:00Z' },
        new Date('2030-01-01T00:00:00Z'),
        new Date('2030-01-02T00:00:00Z'),
      ),
    ).toEqual({ due: new Date('2030-01-01T00:00:00Z'), next: null, missed: 0, late: true });
  });
});
