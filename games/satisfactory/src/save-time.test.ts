import { expect, it } from 'vitest';
import { satisfactorySaveTime } from './save-time.js';

it('interprets the real native dotted time in UTC, matching an explicit offset', () => {
  expect(satisfactorySaveTime('2026.11.02-14.06.26')).toBe(Date.parse('2026-11-02T14:06:26Z'));
  expect(satisfactorySaveTime('2026-11-02T15:06:26+01:00')).toBe(
    satisfactorySaveTime('2026.11.02-14.06.26'),
  );
});
it('orders native and ISO save headers by the same instant and retains precision', () => {
  const values = ['2026.11.02-14.06.26', '2026-11-02T15:06:26.250+01:00', '2026.11.02-14.07.00'];
  expect(
    values.toReversed().sort((a, b) => satisfactorySaveTime(a) - satisfactorySaveTime(b)),
  ).toEqual(values);
});
it.each([
  '',
  '2026.11.32-14.06.26',
  '2026.02.30-14.06.26',
  '2026.11.02-24.06.26',
  '2026-11-02T14:06:26',
  '2026-02-30T14:06:26Z',
  '2 Nov 2026',
])('rejects ambiguous or invalid native time %s', (value) => {
  expect(satisfactorySaveTime(value)).toBeNaN();
});
