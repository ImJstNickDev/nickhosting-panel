import type { ScheduleTiming } from '@nickhosting/database';

type CalendarTiming = Extract<ScheduleTiming, { kind: 'daily' | 'weekly' }>;
const dayMs = 86_400_000;

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}
function localEpoch(format: Intl.DateTimeFormat, instant: number) {
  const parts = Object.fromEntries(format.formatToParts(instant).map((p) => [p.type, p.value]));
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}
function dayOf(instant: number, format: Intl.DateTimeFormat) {
  return Math.floor(localEpoch(format, instant) / dayMs);
}
function eligible(day: number, timing: CalendarTiming) {
  const weekday = new Date(day * dayMs).getUTCDay() || 7;
  return timing.kind === 'daily' || timing.weekdays.includes(weekday);
}

/** Resolve local time using the zone's ICU rules. Like Temporal's compatible
 * disambiguation: repeated times run once at the earlier instant; missing times
 * move forward by the gap. No browser locale or process TZ is involved. */
function instantFor(day: number, timing: CalendarTiming, format: Intl.DateTimeFormat) {
  const [hour = 0, minute = 0] = timing.localTime.split(':').map(Number);
  const local = day * dayMs + (hour * 60 + minute) * 60_000;
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const sample = local + delta * 3_600_000;
    offsets.add(localEpoch(format, sample) - sample);
  }
  const candidates = [...offsets].map((offset) => local - offset).sort((a, b) => a - b);
  const exact = candidates.find((candidate) => localEpoch(format, candidate) === local);
  if (exact !== undefined) return exact;
  const shifted = candidates
    .map((instant) => ({ instant, gap: localEpoch(format, instant) - local }))
    .filter(({ gap }) => gap > 0)
    .sort((a, b) => a.gap - b.gap)[0];
  if (!shifted) throw new RangeError('Unable to resolve schedule calendar time');
  return shifted.instant;
}

export function nextCalendarRun(timing: CalendarTiming, timeZone: string, after: Date) {
  const format = formatter(timeZone);
  const firstDay = dayOf(after.getTime(), format);
  for (let day = firstDay; day <= firstDay + 8; day++) {
    if (!eligible(day, timing)) continue;
    const instant = instantFor(day, timing, format);
    if (instant > after.getTime()) return new Date(instant);
  }
  throw new RangeError('No next calendar occurrence');
}

/** Count civil slots in O(weekdays), including long worker outages. */
function slotsBetween(first: number, last: number, timing: CalendarTiming) {
  if (last <= first) return 0;
  if (timing.kind === 'daily') return last - first;
  const span = last - first;
  let count = Math.floor(span / 7) * timing.weekdays.length;
  for (let i = 1; i <= span % 7; i++) if (eligible(first + i, timing)) count++;
  return count;
}

export function calendarOccurrence(
  timing: CalendarTiming,
  timeZone: string,
  next: Date,
  now: Date,
) {
  const format = formatter(timeZone);
  const lastDay = dayOf(now.getTime(), format);
  let due = next;
  let dueDay = dayOf(next.getTime(), format);
  for (let day = lastDay; day >= lastDay - 8; day--) {
    if (!eligible(day, timing)) continue;
    const instant = instantFor(day, timing, format);
    if (instant <= now.getTime() && instant >= next.getTime()) {
      due = new Date(instant);
      dueDay = day;
      break;
    }
  }
  return {
    due,
    missed: slotsBetween(dayOf(next.getTime(), format), dueDay, timing),
    next: nextCalendarRun(timing, timeZone, due),
    late: now.getTime() - due.getTime() > 300_000,
  };
}

export function firstScheduleRun(timing: ScheduleTiming, timeZone: string, now = new Date()) {
  return timing.kind === 'once'
    ? new Date(timing.at)
    : timing.kind === 'interval'
      ? new Date(timing.firstAt)
      : nextCalendarRun(timing, timeZone, now);
}

export function previewScheduleRuns(
  timing: ScheduleTiming,
  timeZone: string,
  now = new Date(),
  count = 5,
) {
  let next = firstScheduleRun(timing, timeZone, now);
  if (timing.kind === 'interval' && next <= now)
    next = new Date(
      next.getTime() +
        (Math.floor((now.getTime() - next.getTime()) / (timing.everySeconds * 1000)) + 1) *
          timing.everySeconds *
          1000,
    );
  const runs: string[] = [];
  for (let i = 0; i < count && next > now; i++) {
    runs.push(next.toISOString());
    if (timing.kind === 'once') break;
    next =
      timing.kind === 'interval'
        ? new Date(next.getTime() + timing.everySeconds * 1000)
        : nextCalendarRun(timing, timeZone, next);
  }
  return runs;
}
