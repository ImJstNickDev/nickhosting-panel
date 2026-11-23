import type { AtlasRequest } from './atlas-types.js';

export type Raster = {
  kind: 'raster';
  x: number;
  z: number;
  mpp: number;
  side: number;
  /** Native voxel heights for surfaces, decimetres for seed tiles. */
  minHeight: number;
  maxHeight: number;
  seed: boolean;
  /** 16-bit RGBA: native altitude, material, water depth, presence | native light (or seed biome). */
  pixels: Uint16Array;
  present?: Uint8Array;
};
export type QuadBatch = {
  kind: 'quads';
  minY: number;
  maxY: number;
  regionX: number;
  regionZ: number;
  opaque: Uint16Array;
  blend: Uint16Array;
  materials: number[];
};
export type Terrain = Raster | QuadBatch;
export const regionColumns = 8;
export const validSample = 0x8000;
const wordsPerQuad = 8;

function fail(): never {
  throw new Error('Invalid Openworld terrain response');
}

function surface(
  req: Extract<AtlasRequest, { kind: 'surface' }>,
  face: number,
  bytes: ArrayBuffer,
): Raster {
  const v = new DataView(bytes);
  if (bytes.byteLength < 32 || v.getUint32(0) !== 0x4f574d53) fail();
  const version = v.getUint16(4, true),
    n = v.getUint16(20, true),
    s = v.getUint16(22, true);
  const side = n * s;
  if (
    (version !== 1 && version !== 2) ||
    v.getUint16(6, true) !== req.lod ||
    v.getInt32(8, true) !== face ||
    v.getInt32(12, true) !== req.ci ||
    v.getInt32(16, true) !== req.cj ||
    n !== req.n ||
    s !== 64 >> req.lod ||
    side > 512 ||
    !side
  )
    fail();
  const pixels = new Uint16Array(side * side * 4);
  const present = new Uint8Array(n * n);
  const columnSamples = s * s;
  const length = columnSamples * (version === 2 ? 6 : 5);
  let pos = 32;
  let minHeight = 65535;
  let maxHeight = 0;
  for (let cz = 0; cz < n; cz++) {
    for (let cx = 0; cx < n; cx++) {
      if (pos + 4 > bytes.byteLength) fail();
      const revision = v.getUint32(pos, true);
      pos += 4;
      if (!revision) continue;
      present[cz * n + cx] = 1;
      if (pos + length > bytes.byteLength) fail();
      for (let rz = 0; rz < s; rz++) {
        let out = 4 * ((cz * s + rz) * side + cx * s);
        for (let rx = 0; rx < s; rx++, out += 4) {
          const p = rz * s + rx;
          const height = v.getUint16(pos + 2 * p, true);
          pixels[out] = height;
          minHeight = Math.min(minHeight, height);
          maxHeight = Math.max(maxHeight, height);
          pixels[out + 1] = v.getUint16(pos + 2 * columnSamples + 2 * p, true);
          pixels[out + 2] = v.getUint8(pos + 4 * columnSamples + p);
          pixels[out + 3] =
            validSample | (version === 2 ? v.getUint8(pos + 5 * columnSamples + p) : 0);
        }
      }
      pos = Math.ceil((pos + length) / 4) * 4;
    }
  }
  if (pos !== bytes.byteLength) fail();
  return {
    kind: 'raster',
    x: req.ci * 16,
    z: req.cj * 16,
    side,
    mpp: 16 / s,
    pixels,
    present,
    // At a hole the surface shader can interpolate toward a missing neighbour at zero.
    minHeight: present.includes(0) ? 0 : minHeight,
    maxHeight,
    seed: false,
  };
}

function seed(bytes: ArrayBuffer): Raster {
  const v = new DataView(bytes);
  if (bytes.byteLength < 32 || v.getUint32(0) !== 0x4e485354) fail();
  const side = v.getUint16(4, true),
    x = v.getFloat64(8, true),
    z = v.getFloat64(16, true),
    mpp = v.getFloat32(24, true);
  const count = side * side;
  if (
    !side ||
    side > 512 ||
    bytes.byteLength !== 32 + 8 * count ||
    !Number.isFinite(x + z + mpp) ||
    mpp <= 0
  )
    fail();
  const pixels = new Uint16Array(count * 4);
  let minHeight = 32767;
  let maxHeight = -32768;
  for (let p = 0; p < count; p++) {
    const ground = v.getInt16(32 + 2 * p, true),
      water = v.getInt16(32 + 2 * count + 2 * p, true);
    const level = Math.max(water, ground);
    minHeight = Math.min(minHeight, level);
    maxHeight = Math.max(maxHeight, level);
    pixels[p * 4] = level + 32768;
    pixels[p * 4 + 1] = v.getUint16(32 + 4 * count + 2 * p, true);
    pixels[p * 4 + 2] = Math.max(0, water - ground);
    pixels[p * 4 + 3] = validSample | v.getUint8(32 + 6 * count + p);
  }
  return { kind: 'raster', x, z, mpp, side, minHeight, maxHeight, seed: true, pixels };
}

/** Pack a native merged face as one GPU instance. Vertices are expanded by the vertex shader. */
function mesh(
  req: Extract<AtlasRequest, { kind: 'mesh' }>,
  face: number,
  bytes: ArrayBuffer,
): QuadBatch {
  const v = new DataView(bytes);
  if (bytes.byteLength < 32 || v.getUint32(0) !== 0x4f574d31) fail();
  const count = v.getUint32(4, true);
  if (
    count > 1_000_000 ||
    bytes.byteLength !== 32 + 16 * count ||
    v.getInt32(8, true) !== face ||
    v.getInt32(12, true) !== req.i ||
    v.getInt32(16, true) !== req.j ||
    v.getUint16(20, true) !== req.lod
  )
    fail();
  const regionX = Math.floor(req.i / regionColumns) * regionColumns;
  const regionZ = Math.floor(req.j / regionColumns) * regionColumns;
  const ox = (req.i - regionX) * 64,
    oz = (req.j - regionZ) * 64;
  const words = new Uint16Array(bytes, 32);
  let solidCount = 0,
    blendCount = 0;
  for (let p = 0; p < words.length; p += wordsPerQuad) {
    const flags = (words[p] ?? 0) >> 8;
    if (flags & 4) solidCount += 2;
    else if (flags & 1) blendCount++;
    else solidCount++;
  }
  const opaque = new Uint16Array(solidCount * wordsPerQuad),
    blend = new Uint16Array(blendCount * wordsPerQuad);
  const materials = new Set<number>();
  let minY = 65535,
    maxY = 0;
  let solidPos = 0,
    blendPos = 0;
  for (let p = 0; p < words.length; p += wordsPerQuad) {
    const face = words[p] ?? 0,
      mat = words[p + 1] ?? 0,
      flags = face >> 8;
    const plant = Boolean(flags & 4),
      translucent = !plant && Boolean(flags & 1);
    const dst = translucent ? blend : opaque,
      start = translucent ? blendPos : solidPos;
    const loX = words[p + 2] ?? 0,
      loY = words[p + 3] ?? 0,
      loZ = words[p + 4] ?? 0,
      hiX = words[p + 5] ?? 0,
      hiY = words[p + 6] ?? 0,
      hiZ = words[p + 7] ?? 0;
    minY = Math.min(minY, loY, hiY);
    maxY = Math.max(maxY, loY, hiY);
    // A column spans 64 horizontal voxels. Refuse broken packets before assigning offsets.
    if (Math.max(loX, loZ, hiX, hiZ) > 64 || (!plant && (face & 255) > 5)) fail();
    dst[start] = ox + Math.min(loX, hiX);
    dst[start + 1] = Math.min(loY, hiY);
    dst[start + 2] = oz + Math.min(loZ, hiZ);
    dst[start + 3] = ox + Math.max(loX, hiX);
    dst[start + 4] = Math.max(loY, hiY);
    dst[start + 5] = oz + Math.max(loZ, hiZ);
    dst[start + 6] = mat;
    dst[start + 7] = plant ? 6 : face & 255;
    if (plant) {
      dst.copyWithin(start + 8, start, start + 8);
      dst[start + 15] = 7;
    }
    if (translucent) blendPos += 8;
    else solidPos += plant ? 16 : 8;
    materials.add(mat);
  }
  return { kind: 'quads', minY, maxY, regionX, regionZ, opaque, blend, materials: [...materials] };
}
export function decodeAtlas(request: AtlasRequest, face: number, bytes: ArrayBuffer): Terrain {
  if (request.kind === 'mesh') return mesh(request, face, bytes);
  if (request.kind === 'seed') return seed(bytes);
  return surface(request, face, bytes);
}
export function buffers(value: Terrain): ArrayBuffer[] {
  return value.kind === 'raster'
    ? [
        value.pixels.buffer as ArrayBuffer,
        ...(value.present ? [value.present.buffer as ArrayBuffer] : []),
      ]
    : [value.opaque.buffer as ArrayBuffer, value.blend.buffer as ArrayBuffer];
}
export function sampleRaster(r: Raster, x: number, z: number, voxelSize: number) {
  const i = Math.floor((x - r.x) / r.mpp),
    j = Math.floor((z - r.z) / r.mpp);
  if (i < 0 || j < 0 || i >= r.side || j >= r.side) return;
  const p = 4 * (j * r.side + i),
    flags = r.pixels[p + 3] ?? 0;
  if (!(flags & validSample)) return;
  return {
    y: r.seed ? ((r.pixels[p] ?? 0) - 32768) / 10 : (r.pixels[p] ?? 0) * voxelSize,
    biome: r.seed ? flags & 255 : undefined,
  };
}
