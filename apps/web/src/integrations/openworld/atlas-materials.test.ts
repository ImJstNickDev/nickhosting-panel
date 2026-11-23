import { describe, expect, it } from 'vitest';
import { decodeAtlas, type QuadBatch } from './atlas-geometry.js';
import { materialAppearance, usesVoxelSprite, voxelSprites } from './atlas-materials.js';
import { pickAtlas } from './atlas-pick.js';

function prism(
  material: number,
  x: number,
  bottom: number,
  z: number,
  width: number,
  height: number,
  depth: number,
) {
  const right = x + width,
    top = bottom + height,
    back = z + depth;
  return [
    [512, material, right, bottom, z, right, top, back],
    [513, material, x, bottom, z, x, top, back],
    [514, material, x, top, z, right, top, back],
    [515, material, x, bottom, z, right, bottom, back],
    [516, material, x, bottom, back, right, top, back],
    [517, material, x, bottom, z, right, top, z],
  ];
}
function decode(records: number[][], lod = 1): QuadBatch {
  const bytes = new ArrayBuffer(32 + 16 * records.length);
  const header = new DataView(bytes);
  header.setUint32(0, 0x4f574d31);
  header.setUint32(4, records.length, true);
  header.setUint16(20, lod, true);
  new Uint16Array(bytes, 32).set(records.flat());
  const batch = decodeAtlas({ kind: 'mesh', i: 0, j: 0, lod }, 0, bytes);
  if (batch.kind !== 'quads') throw Error();
  return batch;
}
const sprites = new Set([10, 26, 57]);

describe('Openworld map material geometry', () => {
  it('distinguishes cutout sprites, collision-bearing cutouts and blended liquids by their catalogued material', () => {
    const material = { id: 26, color: '#337733', render: 'cutout' };
    for (const key of ['kelp', 'seagrass', 'torch'])
      expect(usesVoxelSprite({ ...material, key })).toBe(true);
    for (const key of ['leaves', 'grate', 'door', 'glass', 'water'])
      expect(usesVoxelSprite({ ...material, key })).toBe(false);
    expect(materialAppearance({ ...material, key: 'water', liquid: true })).toMatchObject({
      surfaceKind: 2,
      opacity: 0.6,
    });
    expect(materialAppearance({ ...material, key: 'oil', liquid: true })).toMatchObject({
      surfaceKind: 3,
      opacity: 0.93,
    });
  });
  it('turns six cutout faces into one crossed pair and leaves native plant, liquid and grate records intact', () => {
    const source = decode([
      ...prism(10, 8, 1608, 28, 1, 1, 1),
      [1026, 76, 9, 1608, 28, 10, 1609, 29],
      [258, 6, 0, 1608, 0, 64, 1608, 64],
      [514, 100, 0, 1607, 0, 64, 1607, 64],
    ]);
    const result = voxelSprites(source, 1, sprites);
    expect(result.blend).toBe(source.blend);
    expect([...result.opaque.slice(0, 24)]).toEqual([...source.opaque.slice(-24)]);
    expect([...result.opaque.slice(24)]).toEqual([
      8, 1608, 28, 9, 1609, 29, 10, 8, 8, 1608, 28, 9, 1609, 29, 10, 9,
    ]);
  });
  it.each([1, 2, 4])(
    'reconstructs stacked kelp through merged caps and preserves a gap at stride %i',
    (lod) => {
      const source = decode(
        [...prism(26, 8, 628, 28, 4, 8, 4), ...prism(26, 8, 644, 28, 4, 4, 4)],
        lod,
      );
      const result = voxelSprites(source, lod, sprites);
      expect(result.opaque.length).toBe((4 / lod) ** 2 * 2 * 2 * 8);
      for (let p = 0; p < result.opaque.length; p += 8) {
        const [x = 0, base = 0, z = 0, right = 0, top = 0, back = 0, mat, direction] =
          result.opaque.subarray(p, p + 8);
        expect([right - x, back - z, mat]).toEqual([lod, lod, 26]);
        expect([8, 9]).toContain(direction);
        expect([
          [628, 636],
          [644, 648],
        ]).toContainEqual([base, top]);
      }
    },
  );
  it('keeps a tall wall in a single vertical span and an unpaired top cap in its own cell', () => {
    const source = decode([
      [512, 26, 1, 8, 0, 1, 65000, 1],
      [514, 26, 0, 65500, 0, 1, 65500, 1],
    ]);
    expect([...voxelSprites(source, 1, sprites).opaque]).toEqual([
      0, 8, 0, 1, 65000, 1, 26, 8, 0, 8, 0, 1, 65000, 1, 26, 9, 0, 65499, 0, 1, 65500, 1, 26, 8, 0,
      65499, 0, 1, 65500, 1, 26, 9,
    ]);
  });
  it('picks the ground beneath a torch in both 3D modes', () => {
    const value = voxelSprites(
      decode([...prism(10, 8, 1608, 28, 1, 1, 1), [2, 1, 0, 1608, 0, 64, 1608, 64]]),
      1,
      sprites,
    );
    const terrain = {
      key: 'mesh',
      request: { kind: 'mesh', i: 0, j: 0, lod: 1 } as const,
      value,
      age: 0,
      bytes: value.opaque.byteLength,
      serial: 1,
      stale: false,
    };
    expect(
      pickAtlas([terrain], { origin: [2.125, 410, 7.125], dir: [0, -1, 0] }, 0.25, 100, () => 15),
    ).toMatchObject({ x: 2.125, y: 402, z: 7.125, source: 'live' });
  });
});
