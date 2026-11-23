import type { QuadBatch } from './atlas-geometry.js';
import type { AtlasMaterial } from './atlas-types.js';

// OWM1 encodes these as voxel boundary faces. Their pack images depict an upright
// object, including when the material also participates in collision (kelp).
export function usesVoxelSprite(m: AtlasMaterial) {
  return m.render === 'cutout' && (m.key === 'torch' || m.key === 'kelp' || m.key === 'seagrass');
}

const materialLook = new Map([
  ['water', { opacity: 0.6, kind: 2 }],
  ['oil', { opacity: 0.93, kind: 3 }],
  ['lava', { opacity: 1, kind: 3 }],
  ['kelp', { opacity: 1, kind: 4 }],
  ['seagrass', { opacity: 1, kind: 5 }],
]);

export function materialAppearance(m: AtlasMaterial) {
  const key = m.key ?? '';
  const look = materialLook.get(key);
  return {
    opacity: look?.opacity ?? (key.includes('glass') ? 0.35 : 0.75),
    glow: m.key === 'lava' ? 1.35 : m.key === 'torch' ? 1.25 : 0,
    // Palette alpha is a presence and surface-kind tag, independent of texture alpha.
    surfaceKind: look?.kind ?? (m.liquid ? 3 : 1),
  };
}

type Column = {
  material: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  spans: [number, number, number][];
};

/** Collect exposed cells, merge vertical runs, then emit just two upright planes per run.
 * Shared faces, top caps and bottoms can all describe the same object. */
export function voxelSprites(
  batch: QuadBatch,
  lod: number,
  sprites: ReadonlySet<number>,
): QuadBatch {
  if (!batch.materials.some((id) => sprites.has(id))) return batch;
  const faces = batch.opaque;
  const columns = new Map<number, Column>();
  let removed = 0;
  // Bound the expansion of exceptionally dense, merged stands. Ordinary voxel
  // faces and native plant markers never require subdivision.
  let surfaceCells = 0;
  for (let p = 0; p < faces.length; p += 8) {
    if (!sprites.has(faces[p + 6] ?? 0) || (faces[p + 7] ?? 0) >= 6) continue;
    removed++;
    surfaceCells +=
      Math.max(1, ((faces[p + 3] ?? 0) - (faces[p] ?? 0)) / lod) *
      Math.max(1, ((faces[p + 5] ?? 0) - (faces[p + 2] ?? 0)) / lod);
  }
  if (!removed) return batch;
  const budget = Math.max(16384, removed * 2);
  let spacing = lod;
  while (spacing < 64 && (surfaceCells * lod) / spacing > budget) spacing *= 2;
  for (let p = 0; p < faces.length; p += 8) {
    const material = faces[p + 6] ?? 0,
      direction = faces[p + 7] ?? 0;
    if (!sprites.has(material) || direction >= 6) continue;
    let x0 = faces[p] ?? 0,
      y0 = faces[p + 1] ?? 0,
      z0 = faces[p + 2] ?? 0;
    let x1 = faces[p + 3] ?? 0,
      y1 = faces[p + 4] ?? 0,
      z1 = faces[p + 5] ?? 0;
    // Extrude each boundary one native sampling cell towards the occupied side.
    switch (direction) {
      case 0:
        x0 = Math.max(0, x0 - lod);
        break;
      case 1:
        x1 += lod;
        break;
      case 2:
        y0 = Math.max(0, y0 - lod);
        break;
      case 3:
        y1 = Math.min(65535, y1 + lod);
        break;
      case 4:
        z0 = Math.max(0, z0 - lod);
        break;
      case 5:
        z1 += lod;
        break;
    }
    for (let z = z0; z < z1; z += spacing) {
      for (let x = x0; x < x1; x += spacing) {
        const key = (material * 512 + x) * 512 + z;
        const col = columns.get(key);
        if (col) col.spans.push([y0, y1, direction]);
        else
          columns.set(key, {
            material,
            x,
            z,
            width: Math.min(spacing, x1 - x),
            depth: Math.min(spacing, z1 - z),
            spans: [[y0, y1, direction]],
          });
      }
    }
  }
  let runs = 0;
  for (const col of columns.values()) {
    col.spans.sort((a, b) => a[0] - b[0] || b[2] - a[2]);
    // A merged stand's interior cells may expose only their bottom and top.
    // Pair consecutive entering/exiting caps at this x,z. An unpaired cap
    // supplies only its own occupied voxel.
    let bottom: [number, number, number] | undefined;
    for (const span of col.spans) {
      if (span[2] === 3) bottom = span;
      if (span[2] === 2 && bottom) {
        bottom[1] = span[1];
        bottom = undefined;
      }
    }
    let length = 0;
    for (const span of col.spans) {
      const last = col.spans[length - 1];
      if (last && last[1] >= span[0]) last[1] = Math.max(last[1], span[1]);
      else col.spans[length++] = span;
    }
    col.spans.length = length;
    runs += length;
  }
  const opaque = new Uint16Array(faces.length - removed * 8 + runs * 16);
  let out = 0,
    start = 0;
  for (let p = 0; p < faces.length; p += 8) {
    if (!sprites.has(faces[p + 6] ?? 0) || (faces[p + 7] ?? 0) >= 6) continue;
    if (p > start) opaque.set(faces.subarray(start, p), out);
    out += p - start;
    start = p + 8;
  }
  opaque.set(faces.subarray(start), out);
  out += faces.length - start;
  for (const { material, x, z, width, depth, spans } of columns.values()) {
    for (const [base, top] of spans) {
      for (const direction of [8, 9]) {
        opaque.set([x, base, z, x + width, top, z + depth, material, direction], out);
        out += 8;
      }
    }
  }
  return { ...batch, opaque };
}
