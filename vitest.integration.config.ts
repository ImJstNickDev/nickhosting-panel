import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'games/**/*.integration.test.ts',
      'packages/**/*.integration.test.ts',
      'apps/**/*.integration.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
