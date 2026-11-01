import { describe, expect, it } from 'vitest';
import { constrainPhotoCrop, initialPhotoCrop, photoCropRect } from './profile-photo-crop.js';

describe('profile photo crop geometry', () => {
  it('centers a square crop in portrait and landscape images without stretching', () => {
    expect(photoCropRect(1200, 800, initialPhotoCrop)).toEqual({ x: 200, y: 0, size: 800 });
    expect(photoCropRect(600, 1000, initialPhotoCrop)).toEqual({ x: 0, y: 200, size: 600 });
  });

  it('keeps every edge within the source after dragging far beyond the preview', () => {
    for (const [width, height] of [
      [1200, 800],
      [600, 1000],
      [256, 256],
    ] as const) {
      for (const x of [-10000, 10000]) {
        for (const y of [-10000, 10000]) {
          for (const zoom of [1, 1.75, 4]) {
            const rect = photoCropRect(width, height, { x, y, zoom });
            expect(rect.x).toBeGreaterThanOrEqual(0);
            expect(rect.y).toBeGreaterThanOrEqual(0);
            expect(rect.x + rect.size).toBeLessThanOrEqual(width);
            expect(rect.y + rect.size).toBeLessThanOrEqual(height);
          }
        }
      }
    }
  });

  it('preserves the selected center while zooming and clamps translation when zooming out', () => {
    const selection = { x: 75, y: -50, zoom: 2 };
    const before = photoCropRect(1000, 800, selection);
    const after = photoCropRect(1000, 800, { ...selection, zoom: 3 });
    expect(after.x + after.size / 2).toBeCloseTo(before.x + before.size / 2);
    expect(after.y + after.size / 2).toBeCloseTo(before.y + before.size / 2);
    expect(constrainPhotoCrop(1000, 800, { x: 400, y: 300, zoom: 1 })).toEqual({
      x: 100,
      y: 0,
      zoom: 1,
    });
  });
});
