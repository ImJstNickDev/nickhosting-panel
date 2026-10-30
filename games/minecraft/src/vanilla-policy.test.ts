import { describe, expect, it } from 'vitest';
import { vanillaJavaMajor } from './vanilla-policy.js';

describe('Vanilla Java ranges', () => {
  it.each([
    ['1.0', 8],
    ['1.16.5', 8],
    ['1.17', 16],
    ['1.17.1', 16],
    ['1.18', 17],
    ['1.20.4', 17],
    ['1.20.5', 21],
    ['1.21.11', 21],
    ['26.1', 25],
    ['26.2', 25],
  ] as const)('resolves %s to Java %i', (release, major) => {
    expect(vanillaJavaMajor(release, 'release', major)).toBe(major);
    expect(vanillaJavaMajor(release, 'release')).toBe(major);
  });
  it('uses snapshot metadata without guessing ranges, and rejects unknown metadata and drift', () => {
    expect(vanillaJavaMajor('25w03a', 'snapshot', 21)).toBe(21);
    expect(() => vanillaJavaMajor('future', 'snapshot')).toThrow();
    expect(() => vanillaJavaMajor('26.2', 'release', 26)).toThrow();
    expect(vanillaJavaMajor('b1.7.3', 'old_beta')).toBe(8);
  });
});
