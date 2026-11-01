import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('loads the catalog as a native Node ESM entry point without a source-store initialization cycle', () => {
  // Vitest's module transform can hide ESM temporal-dead-zone errors. Exercise
  // the same TS loader as the API/worker without opening any service or database.
  const entry = new URL('./minecraft-world-catalog.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(entry)})`],
    { encoding: 'utf8', timeout: 15_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 20_000);
