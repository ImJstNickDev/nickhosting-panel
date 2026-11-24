import { expect, it } from 'vitest';

import { changedMaskArea } from './atlas-mask.js';

it('uploads just the changed column ranks, including removal at the opposite edge', () => {
  const width = 48;
  const before = new Uint8Array(width * 32);
  before[20 * width + 37] = 15;
  const after = before.slice();
  expect(changedMaskArea(before, after, width)).toBeNull();
  after[20 * width + 37] = 0;
  after[12 * width + 8] = 16;
  expect(changedMaskArea(before, after, width)).toEqual({ x: 8, y: 12, width: 32, height: 9 });
  after.set(before);
  after[after.length - 1] = 1;
  expect(changedMaskArea(before, after, width)).toEqual({ x: 44, y: 31, width: 4, height: 1 });
});
