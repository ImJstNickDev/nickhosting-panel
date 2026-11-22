import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasBackoff } from './atlas-backoff.js';
import { AtlasCamera } from './atlas-camera.js';
import { decodeAtlas, sampleRaster } from './atlas-geometry.js';
import { pickAtlas } from './atlas-pick.js';
import type { Entry } from './atlas-stream.js';
import { AtlasStream } from './atlas-stream.js';
import type { AtlasFrame, AtlasOptions } from './atlas-types.js';

describe('Openworld atlas coordinates and geometry', () => {
  it('preserves focus and scale across modes and keeps the eye fixed when looking under an overhang', () => {
    const c = new AtlasCamera(32000, { x: 250, z: 250, span: 20 });
    c.width = 800;
    c.height = 480;
    c.y = 25;
    for (const mode of ['plan', 'iso', 'fly'] as const) {
      c.setMode(mode);
      const target = c.project(250, 250, 25);
      expect([target.x, target.y]).toEqual([400, 240]);
      const p = c.project(255, 252, 26),
        hit = c.atHeight(p.x, p.y, 26);
      expect(hit?.x).toBeCloseTo(255, 7);
      expect(hit?.z).toBeCloseTo(252, 7);
    }
    const before = c.ray(400, 240).origin;
    expect(before[1]).toBeLessThan(35);
    c.look(0, -Math.PI / 3);
    const ray = c.ray(400, 240);
    for (const [i, v] of ray.origin.entries()) expect(v).toBeCloseTo(before[i] ?? 0, 8);
    expect(ray.dir[1]).toBeGreaterThan(0);
    const underside = c.atHeight(400, 240, 35);
    expect(underside).not.toBeNull();
    const all = c.getFrame().bounds,
      near = c.getFrame().detailBounds;
    expect(all.i1 - all.i0).toBeGreaterThan((near?.i1 ?? 0) - (near?.i0 ?? 0));
  });
  it('keeps native voxel underside, translucent faces and crossed plants as separate instances', () => {
    const b = new ArrayBuffer(32 + 3 * 16),
      v = new DataView(b);
    v.setUint32(0, 0x4f574d31);
    v.setUint32(4, 3, true);
    v.setInt32(12, 9, true);
    v.setUint16(20, 1, true);
    new Uint16Array(b, 32).set([
      3, 50, 0, 140, 0, 64, 140, 64, 258, 6, 0, 60, 0, 64, 60, 64, 1026, 7, 1, 64, 1, 2, 66, 2,
    ]);
    const data = decodeAtlas({ kind: 'mesh', i: 9, j: 0, lod: 1 }, 0, b);
    if (data.kind !== 'quads') throw Error();
    expect([data.regionX, data.regionZ]).toEqual([8, 0]);
    expect([...data.opaque.slice(0, 8)]).toEqual([64, 140, 0, 128, 140, 64, 50, 3]);
    expect([data.opaque[15], data.opaque[23]]).toEqual([6, 7]);
    expect([...data.blend.slice(6, 8)]).toEqual([6, 2]);
    v.setUint16(32 + 10, 65, true);
    expect(() => decodeAtlas({ kind: 'mesh', i: 9, j: 0, lod: 1 }, 0, b)).toThrow();
  });
  it('picks the native underside, wall and a nearer visible surface at their drawn heights', () => {
    // Deliberately place this bridge outside the origin region to exercise the shader's region basis.
    const b = new ArrayBuffer(64),
      v = new DataView(b);
    v.setUint32(0, 0x4f574d31);
    v.setUint32(4, 2, true);
    v.setInt32(12, 9, true);
    v.setInt32(16, 12, true);
    v.setUint16(20, 1, true);
    new Uint16Array(b, 32).set([3, 50, 0, 134, 0, 64, 134, 64, 0, 50, 48, 90, 0, 48, 134, 64]);
    const request = { kind: 'mesh', i: 9, j: 12, lod: 1 } as const;
    const deck: Entry = {
      request,
      value: decodeAtlas(request, 0, b),
      key: 'v',
      age: 0,
      serial: 1,
      stale: false,
      bytes: 32,
    };
    const underside = pickAtlas(
      [deck],
      { origin: [151, 27, 199], dir: [0, 1, 0] },
      0.25,
      80,
      () => 15,
    );
    expect(underside).toMatchObject({ x: 151, y: 33.5, z: 199, source: 'live' });
    const pillar = pickAtlas(
      [deck],
      { origin: [145, 27, 199], dir: [1, 0, 0] },
      0.25,
      80,
      () => 15,
    );
    expect(pillar).toMatchObject({ x: 156, y: 27, z: 199, source: 'live' });
    expect(
      pickAtlas([deck], { origin: [151, 27, 199], dir: [0, -1, 0] }, 0.25, 80, () => 15),
    ).toBeNull();
    const pixels = new Uint16Array(8 * 8 * 4);
    for (let n = 0; n < 64; n++) {
      pixels[n * 4] = 120;
      pixels[n * 4 + 3] = 0x8000;
    }
    const terrain: Entry = {
      ...deck,
      key: 't',
      request: { kind: 'surface', ci: 9, cj: 12, n: 1, lod: 3 },
      value: { kind: 'raster', x: 144, z: 192, mpp: 2, side: 8, seed: false, pixels },
    };
    const ray = { origin: [151, 27, 199], dir: [0, 1, 0] } as const;
    expect(
      pickAtlas([deck, terrain], { origin: [...ray.origin], dir: [...ray.dir] }, 0.25, 80, () => 4)
        ?.y,
    ).toBe(30);
    expect(
      pickAtlas([deck, terrain], { origin: [...ray.origin], dir: [...ray.dir] }, 0.25, 80, () => 31)
        ?.y,
    ).toBe(33.5);
  });
  it('reads signed procedural metres, real origin and biome without exposing the native seed', () => {
    const b = new ArrayBuffer(40),
      v = new DataView(b);
    v.setUint32(0, 0x4e485354);
    v.setUint16(4, 1, true);
    v.setFloat64(8, 64000, true);
    v.setFloat64(16, 28000, true);
    v.setFloat32(24, 4, true);
    v.setInt16(32, -82, true);
    v.setInt16(34, -50, true);
    v.setUint16(36, 4, true);
    v.setUint8(38, 215);
    const data = decodeAtlas({ kind: 'seed', x: 0, y: 0, z: 0 }, 0, b);
    if (data.kind !== 'raster') throw Error();
    expect(sampleRaster(data, 64001, 28003, 0.25)).toEqual({ y: -5, biome: 215 });
    expect(sampleRaster(data, 63999, 28003, 0.25)).toBeUndefined();
  });
});
type Mesh = Extract<Parameters<AtlasOptions['load']>[0], { kind: 'mesh' }>;
const bounds = { i0: 0, i1: 32, j0: 0, j1: 32 };
const frame: AtlasFrame = { x: 256, z: 256, span: 96, width: 800, height: 480, bounds, yaw: 0 };
const streams: AtlasStream[] = [];
function stream(options: Partial<AtlasOptions> = {}) {
  vi.stubGlobal(
    'Worker',
    class {
      terminate() {}
    },
  );
  const s = new AtlasStream(
    { edge: 512, face: 0, load: async () => null, initialView: frame, ...options },
    () => {},
  );
  streams.push(s);
  return s;
}
afterEach(() => {
  for (const s of streams.splice(0)) s.destroy();
  vi.unstubAllGlobals();
});
describe('Openworld atlas streaming', () => {
  it('publishes arrivals and edits while small camera movements reuse the displayed geometry', async () => {
    const load = vi.fn<AtlasOptions['load']>(async () => null);
    const s = stream({ load });
    s.setCoverage([[16, 16]], 1);
    s.setSeed(true, 512, 4);
    s.update(frame, 'iso');
    await new Promise((resolve) => setTimeout(resolve, 0));
    s.update(frame, 'iso');
    const recorded = s.visible;
    // Missing surface responses still carry coverage information for the seed layer.
    expect(recorded.some((e) => e.request.kind === 'surface')).toBe(true);
    const count = load.mock.calls.length;
    s.update({ ...frame, x: 256.5 }, 'iso');
    expect(s.visible).toBe(recorded);
    expect(load).toHaveBeenCalledTimes(count);
    s.invalidate([[16, 16]]);
    s.update(frame, 'iso');
    await new Promise((resolve) => setTimeout(resolve, 0));
    s.update(frame, 'iso');
    expect(s.visible).not.toBe(recorded);
    expect(load.mock.calls.length).toBeGreaterThan(count);
  });
  it('honors Retry-After once per family, pauses in background and stops automatic retries', async () => {
    vi.useFakeTimers();
    try {
      const resume = vi.fn(),
        report = vi.fn(),
        b = new AtlasBackoff(resume, report);
      const error = { status: 429, retryAfterSeconds: 2 };
      b.fail(error);
      b.fail(error);
      await vi.advanceTimersByTimeAsync(1999);
      expect(resume).not.toHaveBeenCalled();
      b.pause(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(resume).not.toHaveBeenCalled();
      b.pause(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(resume).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 2; i++) {
        b.fail(error);
        await vi.advanceTimersByTimeAsync(2500);
      }
      expect(resume).toHaveBeenCalledTimes(3);
      b.fail(error);
      expect(report).toHaveBeenCalledExactlyOnceWith(error);
      b.reset();
      b.fail(error);
      b.reset();
      await vi.advanceTimersByTimeAsync(3000);
      expect(resume).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it('caps long rate-limit windows and immediately reports a concurrent permission change', async () => {
    vi.useFakeTimers();
    try {
      const resume = vi.fn(),
        report = vi.fn(),
        b = new AtlasBackoff(resume, report);
      const limited = { status: 429, retryAfterSeconds: 60 };
      for (let k = 0; k < 3; k++) {
        b.fail(limited);
        await vi.advanceTimersByTimeAsync(60200);
      }
      b.fail(limited);
      expect(resume).toHaveBeenCalledTimes(3);
      expect(report).toHaveBeenCalledExactlyOnceWith(limited);
      b.reset();
      report.mockClear();
      b.fail(limited);
      const denied = { status: 403 };
      b.fail(denied);
      b.fail(denied);
      expect(report).toHaveBeenCalledExactlyOnceWith(denied);
      await vi.advanceTimersByTimeAsync(60500);
      expect(resume).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it('holds predictions behind unverified index coverage, then allows measured holes only', async () => {
    const s = stream();
    s.setSeed(true, 512, 3);
    expect(s.seedAllowed(1, 1)).toBe(false);
    s.setCoverage([[0, 0]], 2, bounds);
    expect(s.seedAllowed(0, 0)).toBe(false);
    expect(s.seedAllowed(31, 31)).toBe(true);
    expect(s.seedAllowed(33, 31)).toBe(false);
    s.update(frame, 'plan');
    await vi.waitFor(() => expect(s.seedAllowed(0, 1)).toBe(true));
    s.setCoverage([[0, 0]], 1, bounds);
    expect(s.seedAllowed(0, 0)).toBe(false);
    s.setSeed(false, 512, 3);
    expect(s.seedAllowed(31, 31)).toBe(false);
  });
  it('skips fully masked seed tiles and requests exactly the newly uncovered tile after an edit', async () => {
    const seeds: string[] = [];
    const s = stream({
      load: async (req) => {
        if (req.kind === 'seed') seeds.push([req.x, req.y, req.z].join('/'));
        return null;
      },
    });
    const view = { ...frame, bounds: { i0: 4, i1: 11, j0: 4, j1: 7 } };
    const all = Array.from({ length: 32 }, (_, k) => [4 + (k % 8), 4 + Math.floor(k / 8)] as const);
    s.setCoverage(all, 1);
    s.setSeed(true, 512, 4);
    s.update(view, 'plan');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seeds).toEqual([]);
    s.setCoverage(all.slice(1), 1);
    s.update(view, 'plan');
    await vi.waitFor(() => expect(seeds).toEqual(['1/1/3']));
  });
  it('groups up to sixteen nearby meshes, cancels upstream only once all members leave the camera', async () => {
    const batches: { requests: Mesh[]; signal: AbortSignal; done: (out: null[]) => void }[] = [];
    const s = stream({
      loadMeshes: (requests, signal) =>
        new Promise((resolve) => batches.push({ requests, signal, done: resolve })),
    });
    const cells = Array.from({ length: 32 }, (_, i) => [i, 15] as const);
    s.setCoverage(cells, 1);
    s.update(frame, 'iso');
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    const first = batches[0];
    if (!first) throw Error();
    expect(first.requests).toHaveLength(16);
    expect(new Set(first.requests.map((r) => r.lod)).size).toBe(1);
    const kept = first.requests[0];
    if (!kept) throw Error();
    s.setCoverage([[kept.i, kept.j]], 1);
    s.update(frame, 'iso');
    expect(first.signal.aborted).toBe(false);
    s.setCoverage([], 1);
    s.update(frame, 'iso');
    expect(first.signal.aborted).toBe(true);
    first.done(first.requests.map(() => null));
    await Promise.resolve();
    s.setCoverage(cells, 1);
    s.update(frame, 'iso');
    await vi.waitFor(() => expect(batches).toHaveLength(2));
    batches[1]?.done(batches[1].requests.map(() => null));
  });
  it('a failure in seed requests does not stop verified live terrain or fan out across more seed tiles', async () => {
    let seedReads = 0,
      surfaceReads = 0;
    const s = stream({
      load: async (req) => {
        if (req.kind === 'seed') {
          seedReads++;
          throw new Error('429');
        }
        surfaceReads++;
        return null;
      },
    });
    s.setCoverage([], 1);
    s.setSeed(true, 512, 4);
    s.update(frame, 'plan');
    await vi.waitFor(() => expect(seedReads).toBe(1));
    s.setCoverage(
      [
        [12, 12],
        [13, 13],
      ],
      1,
    );
    s.update(frame, 'plan');
    await vi.waitFor(() => expect(surfaceReads).toBeGreaterThan(0));
    expect(seedReads).toBe(1);
  });
});
