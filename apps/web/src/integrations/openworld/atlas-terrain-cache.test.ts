import { expect, it, vi } from 'vitest';
import { AtlasCamera } from './atlas-camera.js';
import type { QuadBatch, Terrain } from './atlas-geometry.js';
import { AtlasStream, type Entry } from './atlas-stream.js';
import { AtlasTerrainCache, requestKey, terrainBytes } from './atlas-terrain-cache.js';
import type { AtlasRequest } from './atlas-types.js';

type Surface = Extract<AtlasRequest, { kind: 'surface' }>;
const makeSurface = (ci: number, cj: number, n: number, lod: number): Surface => ({
  kind: 'surface',
  ci,
  cj,
  n,
  lod,
});
function raster(r: Surface): Terrain {
  const side = r.n * (64 >> r.lod);
  return {
    kind: 'raster',
    x: r.ci * 16,
    z: r.cj * 16,
    mpp: 16 / (64 >> r.lod),
    side,
    minHeight: 0,
    maxHeight: 200,
    seed: false,
    pixels: new Uint16Array(side * side * 4),
    present: new Uint8Array(r.n * r.n).fill(1),
    presentColumns: r.n * r.n,
  };
}
function entry(r: AtlasRequest, value: Terrain | null, serial: number): Entry {
  return {
    key: requestKey(r),
    request: r,
    value,
    serial,
    bytes: terrainBytes(value),
    stale: false,
    age: serial,
  };
}

it('keeps every native preview across coarse/detail tier count and voxel byte pressure', () => {
  const c = new AtlasTerrainCache();
  const visible = new Set<Entry>();
  const wanted = new Map<string, { priority: number }>();
  const evicted: string[] = [];
  function store(e: Entry) {
    c.store(e);
    if (c.needsTrim) c.trim(wanted, visible, undefined, (key) => evicted.push(key));
  }
  const samples: Entry[] = [];
  for (let k = 0; k < 2304; k++) {
    const lod = 3 + (k % 4);
    const r = makeSurface((k % 64) * 8, Math.floor(k / 64) * 8, lod === 3 ? 4 : 8, lod);
    const e = entry(r, raster(r), k);
    store(e);
    samples.push(e);
  }
  // Detail metadata alone used to evict geometry even at very low byte usage.
  for (let k = 0; k < 2400; k++) store(entry({ kind: 'mesh', i: k, j: 0, lod: 4 }, null, k));
  const geometry: QuadBatch = {
    kind: 'quads',
    minY: 10,
    maxY: 20,
    regionX: 0,
    regionZ: 0,
    materials: [1],
    opaque: new Uint16Array(256 * 1024),
    blend: new Uint16Array(),
  };
  for (let k = 0; k < 300; k++) {
    const e = entry({ kind: 'mesh', i: k, j: 0, lod: 1 }, geometry, k);
    wanted.set(e.key, { priority: 1000 + k });
    store(e);
  }
  expect(c.bytes).toBeLessThanOrEqual(96 * 1024 * 1024);
  expect(c.surfaces).toBe(samples.length);
  expect(evicted.length).toBeGreaterThan(0);
  const reversed = [...c.inBounds({ i0: 0, i1: 63, j0: 0, j1: 63 })];
  for (const e of samples) {
    expect(c.get(e.key)).toBe(e);
    const r = e.request as Surface;
    if (r.ci < 64 && r.cj < 64) expect(reversed).toContain(e);
  }
});

it('bounds both sparse and dense previews while protecting the all-around base under pressure', () => {
  const c = new AtlasTerrainCache();
  const local = { i0: 0, j0: 0, i1: 63, j1: 63 };
  const visible = new Set<Entry>();
  const wanted = new Map<string, { priority: number }>();
  const r = makeSurface(0, 0, 32, 6);
  const hiddenParent = entry(r, raster(r), 0);
  c.store(hiddenParent);
  // The camera wants smaller child keys and the parent is behind it when eviction runs.
  wanted.set(requestKey(makeSurface(8, 8, 8, 6)), { priority: 12 });
  function store(e: Entry) {
    c.store(e);
    if (c.needsTrim) c.trim(wanted, visible, local, () => {});
  }
  for (let k = 0; k < 9000; k++) store(entry(makeSurface(k * 8, 512, 8, 6), null, k));
  expect(c.size).toBeLessThanOrEqual(8192);
  for (let k = 0; k < 3500; k++) {
    const r = makeSurface(k * 4, 1024, 4, 3);
    store(entry(r, raster(r), k));
  }
  expect(c.bytes).toBeLessThanOrEqual(24 * 1024 * 1024);
  expect(c.get(hiddenParent.key)).toBe(hiddenParent);
  expect(c.coveringSurface(makeSurface(8, 8, 8, 6))).toBe(hiddenParent);
  expect([...c.inBounds(local)]).toEqual([hiddenParent]);
});

it('invalidates every covering shape at a changed column, including empty results and split tiles', () => {
  const c = new AtlasTerrainCache();
  const shapes = [
    makeSurface(0, 0, 32, 6),
    makeSurface(8, 8, 8, 6),
    makeSurface(12, 12, 4, 6),
    makeSurface(8, 8, 8, 4),
    makeSurface(12, 12, 4, 4),
  ];
  const [parent, ...rest] = shapes.map((r, k) => entry(r, k % 2 ? null : raster(r), k));
  if (!parent) throw new Error('missing parent');
  for (const e of [parent, ...rest]) c.store(e);
  const right = makeSurface(16, 8, 8, 6);
  const neighbor = entry(right, raster(right), 100);
  c.store(neighbor);
  const small = makeSurface(12, 12, 2, 6);
  expect(c.coveringSurface(small)).toBe(rest[1]);
  expect(c.coveringSurface(makeSurface(8, 8, 4, 6))?.value).toBeNull();
  expect(c.coveringSurface(makeSurface(0, 0, 32, 5))).toBeUndefined();
  c.invalidateColumn(13, 13);
  expect([parent, ...rest].every((e) => e.stale)).toBe(true);
  expect(c.coveringSurface(small)).toBeUndefined();
  expect(c.coveringSurface(right)).toBe(neighbor);
  const freshParent = entry(shapes[0] as Surface, null, 99);
  c.store(freshParent);
  expect(c.coveringSurface(small)).toBe(freshParent);
  c.delete(freshParent.key);
  expect(c.coveringSurface(small)).toBeUndefined();
  c.clear();
  expect([...c.inBounds({ i0: 0, j0: 0, i1: 50, j1: 50 })]).toEqual([]);
  expect([c.bytes, c.size, c.surfaces, c.meshes]).toEqual([0, 0, 0, 0]);
});

function voxels(bytes: number): QuadBatch {
  return {
    kind: 'quads',
    minY: 10,
    maxY: 20,
    regionX: 0,
    regionZ: 0,
    materials: [],
    opaque: new Uint16Array(bytes / 2),
    blend: new Uint16Array(),
  };
}

it.each([
  { columns: 144, bytes: 128, retained: 128 },
  { columns: 18, bytes: 2 * 1024 * 1024, retained: 6 },
])(
  'retains only the latest inspected drawable LOD1 within both limits (column payload $bytes bytes)',
  ({ columns, bytes, retained }) => {
    const c = new AtlasTerrainCache();
    const old: Entry[] = [];
    const tile = voxels(bytes);
    c.focusOn(5000, 0);
    const unusable = [
      entry({ kind: 'mesh', i: 5000, j: 0, lod: 1 }, voxels(0), 0),
      entry({ kind: 'mesh', i: 5000, j: 1, lod: 2 }, tile, 0),
      entry({ kind: 'mesh', i: 4999, j: 0, lod: 1 }, tile, 0),
    ];
    for (const e of unusable) c.store(e);
    c.invalidateColumn(4999, 0);
    for (let k = 0; k < columns; k += 9) {
      const i = k * 10;
      // At each stop some neighbors existed before the camera arrived and others arrive later.
      for (let n = 0; n < 9; n++) {
        if (n === 3) c.focusOn(i, 8);
        const e = entry(
          { kind: 'mesh', i: i - 1 + (n % 3), j: 7 + Math.floor(n / 3), lod: 1 },
          tile,
          k + n,
        );
        c.store(e);
        old.push(e);
      }
    }
    c.focusOn();
    // Current and recently observed peripheral meshes saturate the viewport's cache.
    const fresh = voxels(256 * 1024);
    const now = Date.now();
    for (let n = 0; n < 500; n++) {
      c.store({ ...entry({ kind: 'mesh', i: n, j: 3000, lod: 1 }, fresh, n), age: now });
      if (c.needsTrim) c.trim(new Map(), new Set(), undefined, () => {});
    }
    expect(old.filter((e) => c.get(e.key)).map((e) => e.key)).toEqual(
      old.slice(-retained).map((e) => e.key),
    );
    expect(unusable.every((e) => !c.get(e.key))).toBe(true);
    expect(c.bytes).toBeLessThanOrEqual(96 * 1024 * 1024);
  },
);

it('records a stop inside the presentation tolerance on an already warm frame', () => {
  vi.stubGlobal(
    'Worker',
    class {
      terminate() {}
    },
  );
  const camera = new AtlasCamera(32000, { x: 1600, z: 1600, span: 64 });
  camera.setMode('fly');
  const stopped = camera.getFrame();
  if (!stopped.flight) throw new Error('missing flight camera');
  const stream = new AtlasStream(
    { edge: 32000, face: 0, initialView: stopped, load: async () => null },
    () => {},
  );
  const focus = vi.spyOn(AtlasTerrainCache.prototype, 'focusOn');
  try {
    stream.present({ ...stopped, flight: { ...stopped.flight, leadX: 1 } }, 'fly');
    stream.present(stopped, 'fly');
    expect(focus.mock.calls).toEqual([
      [],
      [Math.floor(stopped.x / 16), Math.floor(stopped.z / 16)],
    ]);
  } finally {
    stream.destroy();
    focus.mockRestore();
    vi.unstubAllGlobals();
  }
});
