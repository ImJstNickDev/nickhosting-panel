import { expect, it } from 'vitest';
import { backupIgnoredSchema } from './backup-limits.js';

it('counts UTF-8 bytes while retaining the existing character limit', () => {
  expect(backupIgnoredSchema.safeParse('a'.repeat(16_384)).success).toBe(true);
  expect(backupIgnoredSchema.safeParse('a'.repeat(16_385)).success).toBe(false);
  expect(backupIgnoredSchema.safeParse('界'.repeat(10_922)).success).toBe(true);
  expect(backupIgnoredSchema.safeParse('界'.repeat(10_923)).success).toBe(false);
});

it('ignores blank/comment lines, but counts escaped comments as patterns', () => {
  const limit = Array.from({ length: 256 }, (_, index) => `file-${index}`).join('\n');
  expect(backupIgnoredSchema.safeParse(`${limit}\n# comment\r\n   \r\n`).success).toBe(true);
  expect(backupIgnoredSchema.safeParse(`${limit}\n\\#literal`).success).toBe(false);
  expect(backupIgnoredSchema.safeParse(`${limit}\n #not-a-comment`).success).toBe(false);
});

it('limits only unescaped wildcards in each pattern', () => {
  expect(backupIgnoredSchema.safeParse('*a'.repeat(16)).success).toBe(true);
  expect(backupIgnoredSchema.safeParse('*a'.repeat(17)).success).toBe(false);
  expect(backupIgnoredSchema.safeParse('\\*a'.repeat(40)).success).toBe(true);
  expect(backupIgnoredSchema.safeParse('\\\\*a'.repeat(17)).success).toBe(false);
});
