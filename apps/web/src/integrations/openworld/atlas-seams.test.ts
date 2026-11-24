import { describe, expect, it } from 'vitest';
import { AtlasSeamCache } from './atlas-seams.js';
import type { Entry } from './atlas-stream.js';

let serial = 0;
function surface(i: number, j: number, lod: number, height: number, n = 1, missing = -1): Entry {
  const s = 64 >> lod,
    side = n * s;
  const pixels = new Uint16Array(side * side * 4);
  const present = new Uint8Array(n * n).fill(1);
  if (missing >= 0) present[missing] = 0;
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      if (!present[Math.floor(y / s) * n + Math.floor(x / s)]) continue;
      const k = (y * side + x) * 4;
      pixels[k] = height;
      pixels[k + 1] = 7;
      pixels[k + 3] = 0x8000;
    }
  return {
    key: String(++serial),
    serial,
    request: { kind: 'surface', ci: i, cj: j, n, lod },
    age: 0,
    bytes: pixels.byteLength,
    stale: false,
    value: {
      kind: 'raster',
      minHeight: height,
      maxHeight: height,
      seed: false,
      x: i * 16,
      z: j * 16,
      side,
      mpp: 16 / s,
      pixels,
      present,
    },
  };
}
function finish(cache: AtlasSeamCache) {
  while (cache.advance(10)) {
    /* finite synthetic world */
  }
}
describe('native surface joins', () => {
  it('prepares the exact shared edge at the finer grid resolution before turning', () => {
    const tiles = [surface(31, 0, 6, 200), surface(32, 0, 2, 280)];
    const cache = new AtlasSeamCache();
    cache.setResident(tiles);
    cache.setVisible([]);
    finish(cache);
    expect(cache.visiblePages()).toEqual([]);
    cache.setVisible(tiles);
    const [page] = cache.visiblePages();
    expect(page?.data.length).toBe(16 * 10);
    expect(page?.data.slice(0, 10)).toEqual(
      Float32Array.from([512, 0, 0, 1, 200, 280, 200, 280, 7, 0]),
    );
    cache.setVisible(tiles.slice(1));
    expect(cache.visiblePages()).toEqual([]);
    cache.setVisible(tiles);
    expect(cache.visiblePages()[0]).toBe(page);
  });
  it('leaves unknown columns, mesh replacements and flat joins open', () => {
    const cache = new AtlasSeamCache();
    const west = surface(0, 0, 6, 90),
      east = surface(1, 0, 6, 160),
      flat = surface(1, 0, 6, 90),
      gap = surface(1, 0, 6, 160, 1, 0);
    const mesh: Entry = {
      ...west,
      request: { kind: 'mesh', i: 1, j: 0, lod: 1 },
      value: {
        kind: 'quads',
        minY: 0,
        maxY: 160,
        regionX: 0,
        regionZ: 0,
        opaque: new Uint16Array(8),
        blend: new Uint16Array(),
        materials: [7],
      },
    };
    for (const tiles of [[west], [west, gap], [west, flat], [west, east, mesh]]) {
      cache.setVisible(tiles);
      finish(cache);
      expect(cache.visiblePages()).toEqual([]);
    }
    cache.setVisible([west, east]);
    finish(cache);
    expect(cache.visiblePages()).toHaveLength(1);
    cache.setVisible([west, { ...east, stale: true }]);
    expect(cache.visiblePages()).toEqual([]);
  });
});
