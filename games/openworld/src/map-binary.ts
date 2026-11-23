import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { OpenworldTokenExpired } from './dashboard-api.js';
import { type OpenworldMapNative, readNativeMapBytes } from './map-terrain.js';
import { readNativeBytes, readNativePng } from './native-response.js';
import { type OpenworldMapWorld, openworldMapWorldKey } from './world-map.js';

type Native = OpenworldMapNative;
type Surface = { world: string; face: number; ci: number; cj: number; lod: number; n: number };
type Mesh = { world: string; face: number; i: number; j: number; lod: number };
type SeedTile = { face: number; x: number; y: number; z: number };
const invalid = () => new DomainError('integration_unavailable');
const unsupported = () => new DomainError('game_request_unsupported');
const uint16 = z.int().min(0).max(65535);
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const text = z.string().min(1).max(256);
const faceMeters = z.number().positive().max(0x7fffffff);
const texture = z
  .string()
  .max(256)
  .regex(/^\/pack\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.png$/);
const schema = z.object({
  planet: openworldMapWorldKey,
  seed: z.string().min(1).max(1024),
  fixedSeed: z.boolean().optional(),
  version: z.uint32(),
  seedScheme: z.uint32().optional(),
  voxelSize: z.number().positive().max(16),
  fullChunkMeters: z.number().positive().max(1024),
  tileSize: z.int().min(1).max(1024),
  maxZoom: z.int().min(0).max(30),
  faceEdgeMeters: faceMeters,
  planets: z.array(z.object({ key: openworldMapWorldKey })).max(256),
  featureKinds: z
    .array(
      z.object({
        key: openworldMapWorldKey,
        name: text,
        color,
        category: text,
        cellMeters: z.number().positive().max(100000),
      }),
    )
    .max(512),
  biomes: z.array(z.object({ id: uint16, name: text, color })).max(256),
  materials: z
    .array(
      z.object({
        id: uint16,
        key: text,
        color,
        render: z.enum(['opaque', 'cutout', 'blended']).default('opaque'),
        plant: z.boolean().default(false),
        liquid: z.boolean().default(false),
        tileMeters: z.number().positive().max(8192).default(1),
        texture: texture.nullish().catch(null),
      }),
    )
    .max(4096),
});
function parse<S extends z.ZodType>(schema: S, bytes: Uint8Array | null): z.output<S> {
  try {
    if (!bytes) throw invalid();
    return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw invalid();
  }
}

async function generationResponse(
  native: Native,
  path: '/api/info' | '/api/tile' | '/api/features',
  query: Record<string, string | number>,
) {
  const url = new URL(path, native.origin);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const response = await native.fetcher(url, {
    redirect: 'error',
    signal: native.signal,
    headers: { 'X-OW-Token': native.token },
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) throw new OpenworldTokenExpired();
    if (response.status === 404 || response.status === 400) throw unsupported();
    if (response.status === 503) throw new DomainError('game_not_ready');
    throw invalid();
  }
  return response;
}

export async function readMapCatalog(native: Native, binding: OpenworldMapWorld) {
  const response = await generationResponse(native, '/api/info', { planet: binding.key });
  const catalog = parse(schema, await readNativeBytes(response, 2 * 1024 * 1024));
  // A world name can select an unknown planet and receive the default catalogue.
  // Accept only an exact, advertised native planet (and matching live extent when supplied).
  if (
    catalog.planet !== binding.key ||
    !catalog.planets.some((p) => p.key === binding.key) ||
    (binding.faceEdgeMeters != null && catalog.faceEdgeMeters !== binding.faceEdgeMeters) ||
    catalog.fullChunkMeters !== 16 ||
    catalog.voxelSize !== 0.25 ||
    new Set(catalog.materials.map((m) => m.id)).size !== catalog.materials.length
  )
    throw unsupported();
  return catalog;
}
export type MapCatalog = Awaited<ReturnType<typeof readMapCatalog>>;
export function mapPalette(catalog: MapCatalog) {
  return {
    voxelSize: catalog.voxelSize,
    faceEdgeMeters: catalog.faceEdgeMeters,
    materials: catalog.materials.map(({ texture, ...material }) => ({
      ...material,
      textured: !!texture,
    })),
  };
}
export function seedLegend(catalog: MapCatalog) {
  if (catalog.fixedSeed !== true || catalog.tileSize !== 256) throw unsupported();
  return {
    faceEdgeMeters: catalog.faceEdgeMeters,
    maxZoom: catalog.maxZoom,
    version: catalog.version,
    biomes: catalog.biomes,
    featureKinds: catalog.featureKinds.filter(
      (k) => k.category === 'structure' || k.category === 'deposit',
    ),
  };
}
export async function readMapTexture(native: Native, catalog: MapCatalog, id: number) {
  const path = catalog.materials.find((material) => material.id === id)?.texture;
  if (!path) return null;
  const response = await native.fetcher(new URL(path, native.origin), {
    redirect: 'error',
    signal: native.signal,
    headers: { 'X-OW-Token': native.token },
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) return null;
    if (response.status === 401) throw new OpenworldTokenExpired();
    throw invalid();
  }
  return readNativePng(response, 512 * 1024, 1024, 1024 * 1024);
}

export async function readMapSurfaceBinary(native: Native, q: Surface) {
  const { world, face, ci, cj, lod, n } = q;
  const s = 64 >> lod;
  const limit = 32 + n * n * (4 + Math.ceil((6 * s * s) / 4) * 4);
  const bytes = await readNativeMapBytes(
    native,
    'map/surface',
    { world, face, ci, cj, lod, n },
    limit,
    'stream-geometry',
  );
  if (!bytes) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    v.byteLength < 32 ||
    v.getUint32(0) !== 0x4f574d53 ||
    v.getUint16(6, true) !== lod ||
    v.getInt32(8, true) !== face ||
    v.getInt32(12, true) !== ci ||
    v.getInt32(16, true) !== cj ||
    v.getUint16(20, true) !== n ||
    v.getUint16(22, true) !== s
  )
    throw invalid();
  const version = v.getUint16(4, true);
  if (version !== 1 && version !== 2) throw unsupported();
  const stride = Math.ceil(((version === 2 ? 6 : 5) * s * s) / 4) * 4;
  let offset = 32;
  for (let col = 0; col < n * n; col++) {
    if (offset + 4 > v.byteLength) throw invalid();
    const present = v.getUint32(offset, true);
    offset += 4 + (present ? stride : 0);
  }
  if (offset !== v.byteLength) throw invalid();
  return bytes;
}

export async function readMapMeshBinary(native: Native, q: Mesh) {
  const { world, face, i, j, lod } = q;
  const bytes = await readNativeMapBytes(
    native,
    'map/mesh',
    { world, face, i, j, lod },
    4 * 1024 * 1024,
    'stream-geometry',
  );
  if (!bytes) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    v.byteLength < 32 ||
    v.getUint32(0) !== 0x4f574d31 ||
    v.getInt32(8, true) !== face ||
    v.getInt32(12, true) !== i ||
    v.getInt32(16, true) !== j ||
    v.getUint16(20, true) !== lod ||
    32 + 16 * v.getUint32(4, true) !== v.byteLength ||
    !Number.isFinite(v.getFloat32(24, true)) ||
    !Number.isFinite(v.getFloat32(28, true))
  )
    throw invalid();
  for (let pos = 32; pos < v.byteLength; pos += 16) {
    const direction = v.getUint8(pos),
      flags = v.getUint8(pos + 1);
    if (
      (!(flags & 4) && direction > 5) ||
      v.getUint16(pos + 4, true) > 64 ||
      v.getUint16(pos + 8, true) > 64 ||
      v.getUint16(pos + 10, true) > 64 ||
      v.getUint16(pos + 14, true) > 64
    )
      throw invalid();
  }
  return bytes;
}

export async function readMapSeedTile(native: Native, catalog: MapCatalog, q: SeedTile) {
  seedLegend(catalog);
  const { face, x, y, z } = q;
  if (z > catalog.maxZoom || x >= 2 ** z || y >= 2 ** z) throw new DomainError('validation_failed');
  const response = await generationResponse(native, '/api/tile', {
    planet: catalog.planet,
    seed: catalog.seed,
    face,
    x,
    y,
    z,
  });
  const side = catalog.tileSize,
    pixels = side ** 2;
  const bytes = await readNativeBytes(response, 32 + 16 * pixels);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const span = catalog.faceEdgeMeters / 2 ** z;
  if (
    v.byteLength !== 32 + 16 * pixels ||
    v.getUint32(0) !== 0x4f575431 ||
    v.getUint16(4, true) !== side ||
    v.getFloat64(8, true) !== x * span ||
    v.getFloat64(16, true) !== y * span ||
    v.getFloat32(24, true) !== Math.fround(span / side)
  )
    throw invalid();
  // Forward only ground, water, material, biome and water kind. Climate and other
  // generator fields belong to the inspector. Rebuild the header without spare native bytes.
  const data = new Uint8Array(32 + 8 * pixels);
  const h = new DataView(data.buffer);
  h.setUint32(0, 0x4e485354);
  h.setUint16(4, side, true);
  h.setFloat64(8, x * span, true);
  h.setFloat64(16, y * span, true);
  h.setFloat32(24, span / side, true);
  data.set(bytes.subarray(32, data.byteLength), 32);
  return data;
}

export async function readMapSeedFeatures(
  native: Native,
  catalog: MapCatalog,
  q: SeedTile & { kind: string },
) {
  seedLegend(catalog);
  const kind = catalog.featureKinds.find(
    (k) => k.key === q.kind && (k.category === 'structure' || k.category === 'deposit'),
  );
  if (!kind || q.z > catalog.maxZoom || q.x >= 2 ** q.z || q.y >= 2 ** q.z)
    throw new DomainError('validation_failed');
  const width = catalog.faceEdgeMeters / 2 ** q.z;
  if (width > 2048 || width / kind.cellMeters > 64) throw new DomainError('validation_failed');
  const x0 = q.x * width,
    z0 = q.y * width;
  const res = await generationResponse(native, '/api/features', {
    planet: catalog.planet,
    seed: catalog.seed,
    face: q.face,
    x0,
    z0,
    x1: x0 + width,
    z1: z0 + width,
    kinds: kind.key,
    limit: 256,
  });
  const features = z.object({
    truncated: z.boolean().optional(),
    features: z
      .array(z.object({ kind: openworldMapWorldKey, x: z.number(), y: z.number(), z: z.number() }))
      .max(256),
  });
  const result = parse(features, await readNativeBytes(res, 512 * 1024));
  return {
    features: result.features.filter(
      (f) => f.kind === q.kind && f.x >= x0 && f.x < x0 + width && f.z >= z0 && f.z < z0 + width,
    ),
    truncated: !!result.truncated,
  };
}
