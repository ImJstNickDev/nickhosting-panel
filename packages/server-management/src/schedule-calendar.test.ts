import { describe, expect, it } from 'vitest';
import { calendarOccurrence, nextCalendarRun, previewScheduleRuns } from './schedule-calendar.js';
import { scheduleSchema } from './schedules.js';

describe('local calendar schedules', () => {
  it('shifts a nonexistent spring time by the gap, preserving subsequent local time', () => {
    expect(
      previewScheduleRuns(
        { kind: 'daily', localTime: '02:30' },
        'Europe/Rome',
        new Date('2026-03-28T03:00:00Z'),
        3,
      ),
    ).toEqual(['2026-03-29T01:30:00.000Z', '2026-03-30T00:30:00.000Z', '2026-03-31T00:30:00.000Z']);
  });
  it('runs a repeated autumn time once, at the earlier instant', () => {
    const timing = { kind: 'daily' as const, localTime: '02:30' };
    expect(
      nextCalendarRun(timing, 'Europe/Rome', new Date('2026-10-25T00:29:59Z')).toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z');
    expect(
      nextCalendarRun(timing, 'Europe/Rome', new Date('2026-10-25T00:30:00Z')).toISOString(),
    ).toBe('2026-10-26T01:30:00.000Z');
  });
  it('uses ISO weekdays across UTC dates and handles non-hour offsets', () => {
    expect(
      previewScheduleRuns(
        { kind: 'weekly', localTime: '00:15', weekdays: [1, 5] },
        'Asia/Kathmandu',
        new Date('2026-10-16T00:00:00Z'),
        2,
      ),
    ).toEqual(['2026-10-18T18:30:00.000Z', '2026-10-22T18:30:00.000Z']);
    expect(
      nextCalendarRun(
        { kind: 'daily', localTime: '02:15' },
        'Australia/Lord_Howe',
        new Date('2026-10-03T12:00:00Z'),
      ).toISOString(),
    ).toBe('2026-10-03T15:45:00.000Z');
  });
  it('coalesces weeks of missed slots without replaying them', () => {
    const timing = { kind: 'weekly' as const, localTime: '10:00', weekdays: [1, 3, 5] };
    expect(
      calendarOccurrence(
        timing,
        'UTC',
        new Date('2026-10-02T10:00:00Z'),
        new Date('2026-10-16T10:01:00Z'),
      ),
    ).toEqual({
      due: new Date('2026-10-16T10:00:00Z'),
      next: new Date('2026-10-19T10:00:00Z'),
      missed: 6,
      late: false,
    });
  });
  it('previews future fixed intervals and no past one-shot', () => {
    expect(
      previewScheduleRuns(
        { kind: 'once', at: '2026-10-01T10:00:00Z' },
        'UTC',
        new Date('2026-10-02T00:00:00Z'),
      ),
    ).toEqual([]);
    expect(
      previewScheduleRuns(
        { kind: 'interval', firstAt: '2026-10-01T10:00:00Z', everySeconds: 3600 },
        'UTC',
        new Date('2026-10-01T11:30:00Z'),
        2,
      ),
    ).toEqual(['2026-10-01T12:00:00.000Z', '2026-10-01T13:00:00.000Z']);
  });
  it('rejects duplicate weekdays, empty recurrence and invalid local times', () => {
    const input = { name: 'Backup', action: 'backup', timeZone: 'Europe/Rome', enabled: true };
    for (const timing of [
      { kind: 'weekly', localTime: '03:00', weekdays: [] },
      { kind: 'weekly', localTime: '03:00', weekdays: [1, 1] },
      { kind: 'daily', localTime: '24:00' },
      { kind: 'daily', localTime: '3:00' },
    ])
      expect(scheduleSchema.safeParse({ ...input, timing }).success).toBe(false);
  });
});
