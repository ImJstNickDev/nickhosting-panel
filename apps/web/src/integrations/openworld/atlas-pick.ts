import { clamp, type Vec3 } from './atlas-camera.js';
import { type QuadBatch, type Raster, sampleRaster } from './atlas-geometry.js';
import type { Entry } from './atlas-stream.js';
import type { AtlasPoint } from './atlas-types.js';

type Ray = { origin: Vec3; dir: Vec3 };
type Range = { near: number; far: number };
const eps = 1e-7;
function slab(range: Range, origin: number, direction: number, lo: number, hi: number) {
  if (Math.abs(direction) < eps) return origin >= lo - eps && origin <= hi + eps;
  const a = (lo - origin) / direction,
    b = (hi - origin) / direction;
  range.near = Math.max(range.near, Math.min(a, b));
  range.far = Math.min(range.far, Math.max(a, b));
  return range.far >= range.near - eps;
}
function intersectQuads(q: QuadBatch, ray: Ray, voxel: number, clip: Range) {
  const x0 = q.regionX * 16,
    z0 = q.regionZ * 16;
  const origin: Vec3 = [
    (ray.origin[0] - x0) / voxel,
    ray.origin[1] / voxel,
    (ray.origin[2] - z0) / voxel,
  ];
  const dir: Vec3 = [ray.dir[0] / voxel, ray.dir[1] / voxel, ray.dir[2] / voxel];
  let nearest = Infinity;
  for (const data of [q.opaque, q.blend]) {
    for (let p = 0; p < data.length; p += 8) {
      const face = data[p + 7] ?? 0;
      if (face >= 6) continue; // Decorative crossed plants don't supply a checkpoint surface.
      const axis = face < 2 ? 0 : face < 4 ? 1 : 2;
      if (Math.abs(dir[axis]) < eps) continue;
      const t = ((data[p + axis] ?? 0) - origin[axis]) / dir[axis];
      if (t < clip.near - eps || t > clip.far + eps || t >= nearest) continue;
      const a = axis === 0 ? 2 : 0,
        b = axis === 1 ? 2 : 1;
      const x = origin[a] + t * dir[a],
        y = origin[b] + t * dir[b];
      if (
        x >= (data[p + a] ?? 0) - eps &&
        x <= (data[p + a + 3] ?? 0) + eps &&
        y >= (data[p + b] ?? 0) - eps &&
        y <= (data[p + b + 3] ?? 0) + eps
      )
        nearest = t;
    }
  }
  return nearest;
}
function vertexHeight(r: Raster, i: number, j: number, scale: number, voxel: number) {
  const x = clamp(Math.floor(i * scale), 0, r.side - 1),
    z = clamp(Math.floor(j * scale), 0, r.side - 1);
  let p = 4 * (z * r.side + x);
  if (!r.pixels[p + 3]) {
    for (const [di, dj] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const) {
      const n = 4 * (clamp(z + dj, 0, r.side - 1) * r.side + clamp(x + di, 0, r.side - 1));
      if (r.pixels[n + 3]) {
        p = n;
        break;
      }
    }
  }
  const h = r.pixels[p] ?? 0;
  return r.seed ? (h - 32768) * 0.1 : h * voxel;
}
function intersectRaster(
  r: Raster,
  ray: Ray,
  voxel: number,
  clip: Range,
  accept: (x: number, z: number) => boolean,
) {
  // Walk just the grid cells crossed by the ray. Use the exact two triangles submitted by the GPU.
  const size = Math.min(128, Math.max(8, r.side)),
    scale = r.side / size,
    cell = r.mpp * scale;
  const [x, y, z] = ray.origin,
    [dx, dy, dz] = ray.dir;
  const at = (o: number, d: number, base: number) =>
    clamp(Math.floor((o + d * (clip.near + eps) - base) / cell), 0, size - 1);
  let i = at(x, dx, r.x),
    j = at(z, dz, r.z),
    t = clip.near;
  const stepX = Math.sign(dx),
    stepZ = Math.sign(dz);
  const next = (o: number, d: number, base: number, c: number) =>
    Math.abs(d) < eps ? Infinity : (base + (c + (d > 0 ? 1 : 0)) * cell - o) / d;
  let nextX = next(x, dx, r.x, i),
    nextZ = next(z, dz, r.z, j);
  for (let steps = 0; steps <= 2 * size + 2 && t <= clip.far + eps; steps++) {
    const end = Math.min(clip.far, nextX, nextZ);
    const a = vertexHeight(r, i, j, scale, voxel),
      b = vertexHeight(r, i, j + 1, scale, voxel),
      c = vertexHeight(r, i + 1, j, scale, voxel),
      d = vertexHeight(r, i + 1, j + 1, scale, voxel);
    const x0 = r.x + i * cell,
      z0 = r.z + j * cell;
    let nearest = Infinity;
    for (const upper of [false, true]) {
      const gx = upper ? (d - b) / cell : (c - a) / cell,
        gz = upper ? (d - c) / cell : (b - a) / cell,
        base = upper ? b + c - d : a;
      const denom = dy - gx * dx - gz * dz;
      if (Math.abs(denom) < eps) continue;
      const hit = (base + gx * (x - x0) + gz * (z - z0) - y) / denom;
      if (hit < t - eps || hit > end + eps || hit >= nearest) continue;
      const hx = x + dx * hit,
        hz = z + dz * hit,
        diag = (hx - x0 + hz - z0) / cell;
      if (
        (upper ? diag >= 1 - eps : diag <= 1 + eps) &&
        sampleRaster(r, hx, hz, voxel) &&
        accept(hx, hz)
      )
        nearest = hit;
    }
    if (Number.isFinite(nearest)) return nearest;
    if (end >= clip.far || !Number.isFinite(end)) break;
    if (nextX <= end + eps) {
      i += stepX;
      nextX += cell / Math.abs(dx);
    }
    if (nextZ <= end + eps) {
      j += stepZ;
      nextZ += cell / Math.abs(dz);
    }
    if (i < 0 || i >= size || j < 0 || j >= size) break;
    t = end;
  }
  return Infinity;
}

/** Click-only ray cast through drawn native geometry. The visibility mask matches the terrain shader. */
export function pickAtlas(
  entries: readonly Entry[],
  ray: Ray,
  voxel: number,
  far: number,
  maskAt: (x: number, z: number) => number | null,
  near = 0,
): AtlasPoint | null {
  const candidates: { e: Entry; clip: Range }[] = [];
  for (const e of entries) {
    const v = e.value,
      req = e.request;
    if (!v) continue;
    const clip = { near, far };
    if (v.kind === 'quads' && req.kind === 'mesh') {
      if (
        !slab(clip, ray.origin[0], ray.dir[0], req.i * 16, (req.i + 1) * 16) ||
        !slab(clip, ray.origin[2], ray.dir[2], req.j * 16, (req.j + 1) * 16) ||
        !slab(clip, ray.origin[1], ray.dir[1], v.minY * voxel, v.maxY * voxel)
      )
        continue;
    } else if (v.kind === 'raster') {
      const side = v.mpp * v.side;
      if (
        !slab(clip, ray.origin[0], ray.dir[0], v.x, v.x + side) ||
        !slab(clip, ray.origin[2], ray.dir[2], v.z, v.z + side)
      )
        continue;
    } else continue;
    candidates.push({ e, clip });
  }
  candidates.sort((a, b) => a.clip.near - b.clip.near);
  let nearest = far,
    result: AtlasPoint | null = null;
  for (const { e, clip } of candidates) {
    if (clip.near > nearest) break;
    clip.far = Math.min(clip.far, nearest);
    const v = e.value,
      req = e.request;
    if (!v) continue;
    const t =
      v.kind === 'quads'
        ? intersectQuads(v, ray, voxel, clip)
        : intersectRaster(v, ray, voxel, clip, (x, z) => {
            const mask = maskAt(x, z);
            return req.kind === 'seed'
              ? mask !== null && !(mask & 16)
              : req.kind === 'surface' && ((mask ?? 0) & 15) <= 7 - req.lod;
          });
    if (t >= nearest) continue;
    nearest = t;
    const x = ray.origin[0] + ray.dir[0] * t,
      y = ray.origin[1] + ray.dir[1] * t,
      z = ray.origin[2] + ray.dir[2] * t;
    result = {
      x,
      y,
      z,
      source: req.kind === 'seed' ? 'seed' : 'live',
      biome: v.kind === 'raster' ? sampleRaster(v, x, z, voxel)?.biome : undefined,
    };
  }
  return result;
}
