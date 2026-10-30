import { expect, it } from 'vitest';
import {
  forgeEnhancedSupportedRelease,
  forgeJavaMajor,
  forgeUsesArguments,
} from './forge-policy.js';

it.each([
  ['1.7.2', 8, false],
  ['1.7.10', 8, false],
  ['1.12.2', 8, false],
  ['1.16.5', 8, false],
  ['1.17', 16, true],
  ['1.17.1', 16, true],
  ['1.18', 17, true],
  ['1.20.4', 17, true],
  ['1.20.5', 21, true],
  ['1.21.11', 21, true],
] as const)('declares Forge Enhanced %s Java%s and arguments=%s', (release, java, args) => {
  expect(forgeEnhancedSupportedRelease(release)).toBe(true);
  expect(forgeJavaMajor(release)).toBe(java);
  expect(forgeUsesArguments(release)).toBe(args);
});
it.each(['1.5.2', '1.6.4', '1.7', '26.1', '1.22', 'latest', '1.21-snapshot', 'invalid'])(
  'does not promote unsupported egg layout %s',
  (release) => {
    expect(forgeEnhancedSupportedRelease(release)).toBe(false);
    expect(() => forgeJavaMajor(release)).toThrow();
  },
);
it('respects explicit stronger metadata without guessing an absent Java tag', () => {
  expect(forgeJavaMajor('1.17.1', 21)).toBe(21);
  expect(() => forgeJavaMajor('1.17.1', Number.NaN)).toThrow();
});
