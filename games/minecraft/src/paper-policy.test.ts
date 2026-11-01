import { describe, expect, it } from 'vitest';
import { paperJavaMajor } from './paper-policy.js';

describe('Paper Java recommendations', () => {
  it.each([
    ['1.7.10', 6, 8],
    ['1.11.2', 8, 8],
    ['1.12', 8, 11],
    ['1.16.4', 8, 11],
    ['1.16.5', 8, 16],
    ['1.17', 16, 17],
    ['1.19.4', 17, 17],
    ['1.20.4', 17, 21],
    ['1.21.11', 21, 21],
    ['26.1', 25, 25],
    ['26.2', 25, 25],
  ] as const)('uses the Paper baseline for %s', (version, minimum, expected) => {
    expect(paperJavaMajor(version, minimum)).toBe(expected);
  });
  it('retains higher upstream requirements and uses metadata for opaque snapshots', () => {
    expect(paperJavaMajor('1.20.4', 25)).toBe(25);
    expect(paperJavaMajor('1.20.4', 17, 25)).toBe(25);
    expect(paperJavaMajor('1.21.11-pre3', 21)).toBe(21);
    expect(paperJavaMajor('future', 26)).toBe(26);
    for (const minimum of [0, 5, 101, Number.NaN, 8.1])
      expect(() => paperJavaMajor('1.7.10', minimum)).toThrow();
  });
});
