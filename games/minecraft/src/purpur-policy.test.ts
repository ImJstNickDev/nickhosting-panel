import { expect, it } from 'vitest';
import { purpurJavaMajor } from './purpur-policy.js';

it.each([
  ['1.14.1', 11],
  ['1.16.5', 16],
  ['1.17.1', 17],
  ['1.20.1', 21],
  ['1.21.11', 21],
  ['26.1.2', 25],
  ['26.3', 25],
] as const)('uses Paper baseline for Purpur %s', (release, java) =>
  expect(purpurJavaMajor(release)).toBe(java),
);
it('respects newer official requirements and rejects unknown inputs', () => {
  expect(purpurJavaMajor('26.3', 26)).toBe(26);
  expect(() => purpurJavaMajor('latest')).toThrow();
  expect(() => purpurJavaMajor('26.3', Number.NaN)).toThrow();
});
