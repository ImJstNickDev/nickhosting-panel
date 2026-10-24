import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'games/**/*.test.ts',
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
      'scripts/*.test.ts',
    ],
    testTimeout: 20000,
  },
});
