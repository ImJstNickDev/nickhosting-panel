import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'games/**/*.test.ts',
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
      'scripts/m4-live.test.ts',
      'scripts/m4-live-installation.test.ts',
    ],
    testTimeout: 20000,
  },
});
