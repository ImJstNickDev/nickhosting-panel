import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { OpenworldTokenExpired } from './dashboard-api.js';
import { readNativeBytes } from './native-response.js';
import { maxOpenworldMapColumn } from './world-map.js';

export type OpenworldMapNative = {
  origin: string;
  token: string;
  signal: AbortSignal;
  fetcher: typeof fetch;
};
const faceId = z.int().min(0).max(5);
const column = z.int().min(0).max(maxOpenworldMapColumn);
const stamp = z.uint32();
const worldKey = z.string().min(1).max(128);
const tileOrigin = column.multipleOf(8);
const faceSummary = z.object({
  face: faceId,
  count: z.uint32(),
  i0: column.nullish(),
  j0: column.nullish(),
  i1: column.nullish(),
  j1: column.nullish(),
});
const invalid = () => new DomainError('integration_unavailable');

// The surface endpoint may reject a column that the same game included in its index.
// Match only its coordinate-range error for this request. Other 400s remain errors.
async function outsideFace(response: Response, params: Record<string, string | number>) {
  const body = json(
    await readNativeBytes(response, 1024),
    z.object({ error: z.string().max(400) }),
  );
  const match = /^paramètre « (ci|cj|i|j) » hors de \[0, (\d{1,10})\] : (\d{1,10})$/u.exec(
    body.error,
  );
  if (!match) return false;
  const [, axis, max, requested] = match;
  return !!axis && Number(requested) === params[axis] && Number(requested) > Number(max);
}

export async function readNativeMapBytes(
  native: OpenworldMapNative,
  path:
    | 'map/index'
    | 'map/columns'
    | 'map/surface'
    | 'map/changes'
    | 'map/mesh'
    | 'players'
    | 'info',
  params: Record<string, string | number>,
  limit: number,
  mode: 'required' | 'optional-tile' | 'stream-geometry' = 'required',
) {
  if (!native.token) throw invalid();
  const url = new URL(`/api/live/${path}`, native.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  try {
    const res = await native.fetcher(url, {
      redirect: 'error',
      signal: native.signal,
      headers: { 'X-OW-Token': native.token },
    });
    if (!res.ok) {
      if (res.status === 400 && mode !== 'required') {
        if (await outsideFace(res, params)) return null;
        throw invalid();
      }
      await res.body?.cancel();
      if (mode === 'stream-geometry') {
        if (res.status === 504) throw new DomainError('game_request_timeout');
        if (res.status === 503) throw new DomainError('game_not_ready', 503);
        if (res.status === 429) throw new DomainError('rate_limited');
        if (res.status === 403) throw new DomainError('game_authentication_failed', 403);
      }
      if (res.status === 401) throw new OpenworldTokenExpired();
      if (res.status === 404 && mode !== 'required') return null;
      throw new DomainError(res.status === 503 ? 'game_not_ready' : 'integration_unavailable');
    }
    return await readNativeBytes(res, limit);
  } catch (e) {
    if (e instanceof DomainError) throw e;
    if (
      mode === 'stream-geometry' &&
      native.signal.aborted &&
      native.signal.reason?.name === 'TimeoutError'
    )
      throw new DomainError('game_request_timeout');
    throw invalid();
  }
}
function json<S extends z.ZodType>(bytes: Uint8Array | null, schema: S): z.output<S> {
  if (!bytes) throw invalid();
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw invalid();
  }
}
function validate(world: string, face?: number) {
  if (!worldKey.safeParse(world).success || (face !== undefined && !faceId.safeParse(face).success))
    throw new DomainError('validation_failed');
}
export async function readMapIndex(native: OpenworldMapNative, world: string) {
  validate(world);
  const raw = json(
    await readNativeMapBytes(native, 'map/index', { world }, 32768),
    z.object({ stamp, faces: z.array(faceSummary).max(6) }),
  );
  const seen = new Set<number>();
  return {
    stamp: raw.stamp,
    faces: raw.faces.map((f) => {
      if (seen.has(f.face)) throw invalid();
      seen.add(f.face);
      const { i0 = null, j0 = null, i1 = null, j1 = null } = f;
      if (
        f.count &&
        (i0 === null || j0 === null || i1 === null || j1 === null || i1 < i0 || j1 < j0)
      )
        throw invalid();
      return { face: f.face, count: f.count, i0, j0, i1, j1 };
    }),
  };
}
export async function readMapColumns(native: OpenworldMapNative, world: string, face: number) {
  validate(world, face);
  const bytes = await readNativeMapBytes(native, 'map/columns', { world, face }, 8 * 262144);
  if (!bytes || bytes.byteLength % 8) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const columns: [number, number][] = [];
  for (let offset = 0; offset < view.byteLength; offset += 8) {
    const i = view.getInt32(offset, true),
      j = view.getInt32(offset + 4, true);
    if (i < 0 || j < 0) throw invalid();
    columns.push([i, j]);
  }
  return { columns };
}
const changeTuple = z
  .tuple([faceId, column, column])
  .rest(z.unknown())
  .transform(([f, i, j]): [number, number, number] => [f, i, j]);
export async function readMapChanges(native: OpenworldMapNative, world: string, since: number) {
  validate(world);
  if (!stamp.safeParse(since).success) throw new DomainError('validation_failed');
  return json(
    await readNativeMapBytes(native, 'map/changes', { world, since }, 1024 * 1024),
    z.object({ stamp, reset: z.boolean(), columns: z.array(changeTuple).max(65536) }),
  );
}

export interface OpenworldMapTile {
  side: 32;
  samples: number[];
}
function emptyTile(): OpenworldMapTile {
  return { side: 32, samples: Array<number>(32 * 32).fill(-1) };
}

// OWMS is little endian. A block has 8 x 8 columns at LOD 4, each carrying
// 4 x 4 heights, materials and water depths. Version 2 also carries lighting.
export function decodeMapTile(
  bytes: Uint8Array,
  face: number,
  ci: number,
  cj: number,
): OpenworldMapTile {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength < 32 || v.getUint32(0) !== 0x4f574d53) throw invalid();
  const version = v.getUint16(4, true);
  if (
    (version !== 1 && version !== 2) ||
    v.getUint16(6, true) !== 4 ||
    v.getInt32(8, true) !== face ||
    v.getInt32(12, true) !== ci ||
    v.getInt32(16, true) !== cj ||
    v.getUint16(20, true) !== 8 ||
    v.getUint16(22, true) !== 4
  )
    throw invalid();
  const tile = emptyTile();
  let offset = 32;
  for (let k = 0; k < 64; k++) {
    if (offset + 4 > v.byteLength) throw invalid();
    const revision = v.getUint32(offset, true);
    offset += 4;
    if (!revision) continue;
    const length = version === 2 ? 96 : 80;
    if (offset + length > v.byteLength) throw invalid();
    for (let n = 0; n < 16; n++) {
      const elevation = v.getUint16(offset + 2 * n, true),
        water = v.getUint8(offset + 64 + n);
      // Relief colors use measured height and water depth; material IDs vary with the game data.
      const neighbor = v.getUint16(offset + 2 * (n % 4 ? n - 1 : n), true);
      const slope = Math.max(-28, Math.min(28, (elevation - neighbor) * 2));
      const altitude = Math.min(75, Math.round(elevation / 24));
      const d = Math.min(48, water);
      const rgb = water
        ? (48 << 16) + ((130 - d) << 8) + 165 - d
        : ((82 + altitude + slope) << 16) + ((110 + altitude + slope) << 8) + 74 + altitude + slope;
      const x = (k % 8) * 4 + (n % 4),
        y = Math.floor(k / 8) * 4 + Math.floor(n / 4);
      tile.samples[y * tile.side + x] = rgb;
    }
    offset += length;
  }
  if (offset !== v.byteLength) throw invalid();
  return tile;
}
export async function readMapTile(
  native: OpenworldMapNative,
  world: string,
  face: number,
  ci: number,
  cj: number,
) {
  validate(world, face);
  if (!tileOrigin.safeParse(ci).success || !tileOrigin.safeParse(cj).success)
    throw new DomainError('validation_failed');
  const bytes = await readNativeMapBytes(
    native,
    'map/surface',
    { world, face, ci, cj, n: 8, lod: 4 },
    32 + 64 * (4 + 96),
    'optional-tile',
  );
  return bytes ? decodeMapTile(bytes, face, ci, cj) : emptyTile();
}

const roster = z.object({ players: z.array(z.unknown()).max(1024) });
const locatedPlayer = z.object({
  id: z.uint32(),
  name: z.string().min(1).max(256),
  world: worldKey,
  inSpace: z.boolean().optional(),
  connectedS: z.number().nonnegative(),
  pos: z.object({ face: faceId, x: z.number(), z: z.number() }),
});
export type MapPlayer = {
  id: number;
  name: string;
  world: string;
  joinedAt: number;
  face: number;
  x: number;
  z: number;
};
export async function readMapPlayers(native: OpenworldMapNative) {
  const data = json(await readNativeMapBytes(native, 'players', {}, 4 * 1024 * 1024), roster);
  const time = Date.now();
  const players: MapPlayer[] = [];
  for (const row of data.players) {
    const parsed = locatedPlayer.safeParse(row);
    if (!parsed.success || parsed.data.inSpace) continue;
    const { id, name, world, connectedS, pos } = parsed.data;
    players.push({ id, name, world, ...pos, joinedAt: Math.round(time - connectedS * 1000) });
  }
  return { players };
}
