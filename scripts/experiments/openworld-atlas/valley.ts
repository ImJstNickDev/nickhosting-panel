import { crc32, deflateSync } from 'node:zlib';
import { readMeshBatch } from '../../../games/openworld/src/map-mesh-batch.js';

/**
 * Deterministic test-owned map shared by both renderers. Column coordinates are
 * in metres when first sampled and in native quarter-metre units on the wire.
 */
export const materialPalette = [
  { id: 0, key: 'air', color: '#000000', render: 'opaque' },
  { id: 1, key: 'grass', color: '#66974f', render: 'opaque' },
  { id: 2, key: 'stone', color: '#857d75', render: 'opaque' },
  { id: 3, key: 'water', color: '#599fea', render: 'blended', liquid: true },
  { id: 4, key: 'planks', color: '#b78753', render: 'opaque' },
  { id: 5, key: 'sand', color: '#d2bd84', render: 'opaque' },
  { id: 6, key: 'leaves', color: '#477943', render: 'opaque' },
  { id: 7, key: 'bark', color: '#715640', render: 'opaque' },
  { id: 8, key: 'stone_brick', color: '#a5a19a', render: 'opaque' },
  { id: 9, key: 'tall_grass', color: '#8ba957', render: 'cutout', plant: true },
].map((material) => ({
  ...material,
  tileMeters: 1,
  solid: material.id !== 0,
  textured: material.id !== 0,
}));
export const centre = { x: 256, z: 256 };
export const faceEdge = 8192;
export const bridgeY = 35,
  waterY = 17;
type Rect = [number, number, number, number, number, number, number];
const blocks = 32,
  cell = 4;
const groundHeight = new Float32Array(((blocks * 16) / cell) ** 2);
const groundMaterial = new Uint8Array(groundHeight.length);
const boxes = new Map<number, Rect[]>();
function ground(x: number, z: number) {
  const side = (blocks * 16) / cell;
  const i = Math.max(0, Math.min(side - 1, Math.floor(x / cell)));
  const j = Math.max(0, Math.min(side - 1, Math.floor(z / cell)));
  return j * side + i;
}
for (let z = 0; z < blocks * 16; z += cell) {
  for (let x = 0; x < blocks * 16; x += cell) {
    const river = Math.abs(z + 2 - (256 + 12 * Math.sin((x - 256) / 46)));
    const hill = 3 * Math.sin((x + 2) / 27) + 4 * Math.cos((z + 2) / 31);
    const height = Math.round(
      8 + Math.min(1, river / 29) * (26 + hill) + Math.min(29, Math.max(0, river - 62) / 2),
    );
    const k = ground(x, z);
    groundHeight[k] = height;
    groundMaterial[k] = height <= 19 ? 5 : river < 24 ? 2 : 1;
  }
}
function box(
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  length: number,
  mat: number,
) {
  const shape: Rect = [x, y, z, x + width, y + height, z + length, mat];
  for (let j = Math.floor(z / 16); j <= Math.floor((z + length - 0.001) / 16); j++)
    for (let i = Math.floor(x / 16); i <= Math.floor((x + width - 0.001) / 16); i++) {
      const key = j * blocks + i;
      const list = boxes.get(key) ?? [];
      list.push(shape);
      boxes.set(key, list);
    }
}
// Deck and railings span the river; gaps between the piers remain physically open.
box(251, bridgeY - 1.5, 222, 10, 1.5, 68, 4);
for (const x of [251, 260]) {
  box(x, bridgeY + 1, 222, 0.75, 0.75, 68, 4);
  for (let z = 223; z <= 287; z += 8) box(x, bridgeY, z, 0.75, 1.5, 0.75, 4);
  for (const z of [236, 258, 278]) box(x - 0.75, 6, z, 2.25, bridgeY - 7.5, 2.5, 8);
}
for (let j = 1; j < blocks - 1; j++)
  for (let i = 1; i < blocks - 1; i++) {
    const x = i * 16 + 1 + ((i * 7 + j * 3) % 8),
      z = j * 16 + 1 + ((j * 5 + i * 3) % 8);
    const h = groundHeight[ground(x, z)] ?? 0;
    if (h < 26 || (x > 238 && x < 274 && z > 214 && z < 304)) continue;
    if ((i + j * 7) % 11 === 0) {
      box(x, h, z, 4, 11, 4, 8);
      box(x - 1, h + 10.5, z - 1, 6, 1.25, 6, 4);
    } else if ((i + j) % 3 !== 0) {
      box(x, h, z, 1, 5, 1, 7);
      box(x - 2, h + 4, z - 2, 5, 3.5, 5, 6);
    }
  }

export function known(i: number, j: number, radius = 16) {
  return i >= 16 - radius && i < 16 + radius && j >= 16 - radius && j < 16 + radius;
}
export function columns(radius = 16): [number, number][] {
  const result: [number, number][] = [];
  for (let j = 0; j < blocks; j++)
    for (let i = 0; i < blocks; i++) if (known(i, j, radius)) result.push([i, j]);
  return result;
}
function sample(x: number, z: number) {
  const k = ground(x, z),
    bottom = groundHeight[k] ?? 0;
  let h = bottom,
    m = groundMaterial[k] ?? 1;
  if (bottom < waterY) {
    h = waterY;
    m = 3;
  }
  for (const [x0, , z0, x1, y1, z1, mat] of boxes.get(
    Math.floor(z / 16) * blocks + Math.floor(x / 16),
  ) ?? []) {
    if (x >= x0 && x < x1 && z >= z0 && z < z1 && y1 > h) {
      h = y1;
      m = mat;
    }
  }
  return { h, m, water: m === 3 ? Math.round((waterY - bottom) * 4) : 0 };
}
export function surface(
  ci: number,
  cj: number,
  n: number,
  lod: number,
  radius = 16,
  face = 0,
): Buffer {
  const side = 64 >> lod,
    count = side * side;
  const columnBytes = Math.ceil((4 + 6 * count) / 4) * 4;
  const data = Buffer.alloc(32 + (4 + columnBytes) * n * n);
  data.write('OWMS');
  data.writeUInt16LE(2, 4);
  data.writeUInt16LE(lod, 6);
  data.writeInt32LE(face, 8);
  data.writeInt32LE(ci, 12);
  data.writeInt32LE(cj, 16);
  data.writeUInt16LE(n, 20);
  data.writeUInt16LE(side, 22);
  data.writeUInt32LE(7, 24);
  let offset = 32;
  for (let j = cj; j < cj + n; j++)
    for (let i = ci; i < ci + n; i++) {
      if (face !== 0 || !known(i, j, radius)) {
        offset += 4;
        continue;
      }
      data.writeUInt32LE(7, offset);
      let index = 0;
      for (let z = 0; z < side; z++)
        for (let x = 0; x < side; x++, index++) {
          const pt = sample(i * 16 + ((x + 0.5) * 16) / side, j * 16 + ((z + 0.5) * 16) / side);
          data.writeUInt16LE(Math.round(pt.h * 4), offset + 4 + index * 2);
          data.writeUInt16LE(pt.m, offset + 4 + 2 * count + index * 2);
          data[offset + 4 + 4 * count + index] = pt.water;
        }
      offset += columnBytes;
    }
  return data.subarray(0, offset);
}
export function mesh(i: number, j: number, lod: number, radius = 16, face = 0): Buffer {
  const records: number[] = [];
  const originX = i * 16,
    originZ = j * 16;
  function quad(
    dir: number,
    mat: number,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ) {
    records.push(
      dir | (mat === 3 ? 256 : 0),
      mat,
      (x0 - originX) * 4,
      y0 * 4,
      (z0 - originZ) * 4,
      (x1 - originX) * 4,
      y1 * 4,
      (z1 - originZ) * 4,
    );
  }
  if (known(i, j, radius) && face === 0) {
    for (let z = originZ; z < originZ + 16; z += cell)
      for (let x = originX; x < originX + 16; x += cell) {
        const k = ground(x, z),
          h = groundHeight[k] ?? 0,
          mat = groundMaterial[k] ?? 1;
        quad(2, mat, x, h, z, x + cell, h, z + cell);
        if (h < waterY) quad(2, 3, x, waterY, z, x + cell, waterY, z + cell);
        const east = groundHeight[ground(x + cell, z)] ?? 0,
          west = groundHeight[ground(x - cell, z)] ?? 0;
        const south = groundHeight[ground(x, z + cell)] ?? 0,
          north = groundHeight[ground(x, z - cell)] ?? 0;
        if (h > east) quad(0, 2, x + cell, east, z, x + cell, h, z + cell);
        if (h > west) quad(1, 2, x, west, z, x, h, z + cell);
        if (h > south) quad(4, 2, x, south, z + cell, x + cell, h, z + cell);
        if (h > north) quad(5, 2, x, north, z, x + cell, h, z);
      }
    for (const [x0, y0, z0, x1, y1, z1, mat] of boxes.get(j * blocks + i) ?? []) {
      const xa = Math.max(x0, originX),
        xb = Math.min(x1, originX + 16);
      const za = Math.max(z0, originZ),
        zb = Math.min(z1, originZ + 16);
      quad(2, mat, xa, y1, za, xb, y1, zb);
      quad(3, mat, xa, y0, za, xb, y0, zb);
      if (xb === x1) quad(0, mat, xb, y0, za, xb, y1, zb);
      if (xa === x0) quad(1, mat, xa, y0, za, xa, y1, zb);
      if (zb === z1) quad(4, mat, xa, y0, zb, xb, y1, zb);
      if (za === z0) quad(5, mat, xa, y0, za, xb, y1, za);
    }
  }
  const data = Buffer.alloc(32 + 2 * records.length);
  data.write('OWM1');
  data.writeUInt32LE(records.length / 8, 4);
  data.writeInt32LE(face, 8);
  data.writeInt32LE(i, 12);
  data.writeInt32LE(j, 16);
  data.writeUInt16LE(lod, 20);
  data.writeFloatLE(5, 24);
  data.writeFloatLE(88, 28);
  for (let k = 0; k < records.length; k++) data.writeUInt16LE(records[k] ?? 0, 32 + k * 2);
  return data;
}

/** Small original test texture, varied by material; includes alpha for the cutout plant. */
export function texture(id: number): Buffer {
  const material = materialPalette.find((m) => m.id === id);
  if (!material) throw Error('Unknown synthetic material');
  const size = 32,
    rgb = Number.parseInt(material.color.slice(1), 16);
  const pixel = Buffer.alloc(size * (1 + 4 * size));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const at = y * (1 + size * 4) + 1 + x * 4;
      const n = ((x * 11 + y * 31 + id * 13) % 19) - 9 + (id === 4 && y % 8 === 0 ? -30 : 0);
      for (let c = 0; c < 3; c++)
        pixel[at + c] = Math.min(255, Math.max(0, ((rgb >> ((2 - c) * 8)) & 255) + n));
      // The a1.2.9 water albedo has alpha 61 even in the middle of a river.
      pixel[at + 3] = id === 3 ? 61 : id === 9 && (x + y) % 6 < 2 ? 0 : 255;
    }
  const pack = (tag: string, data: Buffer) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length);
    b.write(tag, 4);
    data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pack('IHDR', header),
    pack('IDAT', deflateSync(pixel)),
    pack('IEND', Buffer.alloc(0)),
  ]);
}

export async function meshBundle(
  cells: readonly (readonly [number, number])[],
  lod: number,
  radius = 16,
  face = 0,
  load = (i: number, j: number) => mesh(i, j, lod, radius, face),
) {
  const { body } = await readMeshBatch(cells, new AbortController().signal, async ([i, j]) =>
    known(i, j, radius) && face === 0 ? new Uint8Array(load(i, j)) : null,
  );
  return Buffer.from(await new Response(body).arrayBuffer());
}
