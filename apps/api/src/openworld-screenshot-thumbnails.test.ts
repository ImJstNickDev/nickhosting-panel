import { randomFillSync } from 'node:crypto';
import { PNG } from 'pngjs';
import { expect, it } from 'vitest';
import { resizeOpenworldScreenshot } from './openworld-screenshot-thumbnails.js';

it('resizes a full-size native-style capture over 512 KiB in a worker, preserving landscape proportions', async () => {
  const source = new PNG({ width: 1280, height: 720 });
  randomFillSync(source.data);
  const original = PNG.sync.write(source);
  expect(original.length).toBeGreaterThan(512 * 1024);
  const miniature = await resizeOpenworldScreenshot(Uint8Array.from(original));
  expect(PNG.sync.read(Buffer.from(miniature))).toMatchObject({ width: 320, height: 180 });
  expect(miniature.byteLength).toBeLessThan(320 * 180 * 4);
});

it('rejects truncated files and unsupported headers before decoding', async () => {
  const original = PNG.sync.write(new PNG({ width: 8, height: 8 }));
  await expect(
    resizeOpenworldScreenshot(Uint8Array.from(original.subarray(0, -4))),
  ).rejects.toMatchObject({ code: 'integration_unavailable' });
  original[28] = 1;
  await expect(resizeOpenworldScreenshot(Uint8Array.from(original))).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
});

it('reconstructs each native PNG row filter and preserves exact pixels at native scale', async () => {
  const source = new PNG({ width: 13, height: 7 });
  randomFillSync(source.data);
  for (const filterType of [0, 1, 2, 3, 4] as const) {
    const original = PNG.sync.write(source, { filterType });
    const thumbnail = await resizeOpenworldScreenshot(Uint8Array.from(original));
    expect(PNG.sync.read(Buffer.from(thumbnail)).data.equals(source.data)).toBe(true);
  }
});
