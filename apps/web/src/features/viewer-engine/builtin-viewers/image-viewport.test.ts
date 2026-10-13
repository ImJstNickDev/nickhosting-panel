import { describe, expect, it } from 'vitest';
import { fitImage, initialImageTransform, parseImagePercent, zoomImage } from './image-viewport.js';

describe('Frame viewport geometry', () => {
  it('fits natural pixels, preserves small images and allows sub-one-percent fits', () => {
    expect(fitImage({ width: 4000, height: 2000 }, { width: 1000, height: 800 }).scale).toBe(0.25);
    expect(fitImage({ width: 400, height: 200 }, { width: 1000, height: 800 }).scale).toBe(1);
    expect(fitImage({ width: 100_000, height: 10 }, { width: 300, height: 500 }).scale).toBe(0.003);
  });
  it('keeps the same image point at the center or pointer after zooming a panned image', () => {
    const view = { scale: 0.25, x: 120, y: -75, fit: false };
    for (const anchor of [
      { x: 0, y: 0 },
      { x: 210, y: -65 },
    ]) {
      const next = zoomImage(view, 2, anchor);
      expect((anchor.x - next.x) / next.scale).toBeCloseTo((anchor.x - view.x) / view.scale);
      expect((anchor.y - next.y) / next.scale).toBeCloseTo((anchor.y - view.y) / view.scale);
      expect(next.fit).toBe(false);
      expect(zoomImage(next, view.scale, anchor)).toEqual(view);
    }
  });
  it('uses the effective clamped ratio and validates percentage drafts without lossy parsing', () => {
    expect(zoomImage(initialImageTransform, 1e20).scale).toBe(1_000_000);
    expect(zoomImage(initialImageTransform, 1e-20).scale).toBe(0.000001);
    expect(parseImagePercent('125,5 %')).toBe(1.255);
    expect(parseImagePercent(' 12.5 ')).toBe(0.125);
    for (const value of ['', ' ', '0', '-20', 'NaN', 'Infinity', '100oops', '1,2.3'])
      expect(parseImagePercent(value)).toBeUndefined();
  });
});
