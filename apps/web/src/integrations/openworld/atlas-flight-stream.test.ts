import { afterEach, expect, it, vi } from 'vitest';
import { AtlasCamera } from './atlas-camera.js';
import { AtlasStream, requestKey } from './atlas-stream.js';
import type { AtlasFrame, AtlasOptions, AtlasRequest } from './atlas-types.js';

type Mesh = Extract<AtlasRequest, { kind: 'mesh' }>;
const edge = 32000;
function camera(i: number, j: number, yaw = 0): AtlasFrame {
  const cam = new AtlasCamera(edge, { x: i * 16, z: j * 16, span: 64 });
  cam.width = 800;
  cam.height = 480;
  cam.setMode('fly');
  cam.pitch = 0;
  cam.yaw = yaw;
  cam.y = 32;
  cam.groundHeight = 32;
  // The fixture positions the eye, then derives the normal camera focal point.
  cam.x += Math.sin(yaw) * cam.distance;
  cam.z += Math.cos(yaw) * cam.distance;
  return cam.getFrame();
}
let current: AtlasStream | undefined;
type Surface = Extract<AtlasRequest, { kind: 'surface' }>;
function replay(
  surface?: (r: Surface) => Promise<ArrayBuffer | null>,
  occupied: (i: number, j: number) => boolean = () => true,
  meshByteLength = 16,
  faceEdge = edge,
  waitingForDecode?: (() => void)[],
) {
  const opaque = new Uint16Array(meshByteLength / 2);
  vi.stubGlobal(
    'Worker',
    class {
      onmessage?: (event: { data: unknown }) => void;
      postMessage({
        id,
        request,
        bytes,
      }: {
        id: number;
        request: AtlasRequest;
        bytes: ArrayBuffer;
      }) {
        const present =
          request.kind === 'surface'
            ? Uint8Array.from({ length: request.n * request.n }, (_, k) =>
                Number(
                  occupied(request.ci + (k % request.n), request.cj + Math.floor(k / request.n)),
                ),
              )
            : undefined;
        const decoded = () =>
          this.onmessage?.({
            data: {
              id,
              terrain:
                request.kind === 'surface'
                  ? {
                      kind: 'raster',
                      x: request.ci * 16,
                      z: request.cj * 16,
                      mpp: 16,
                      side: request.n,
                      minHeight: 64,
                      maxHeight: 65,
                      seed: false,
                      present,
                      presentColumns: present?.reduce((a, b) => a + b, 0),
                      pixels: new Uint16Array(request.n * request.n * 4),
                    }
                  : {
                      kind: 'quads',
                      materials: [2],
                      minY: 64,
                      maxY: 65,
                      regionX: 0,
                      regionZ: 0,
                      opaque: bytes.byteLength === 32 ? new Uint16Array(0) : opaque,
                      blend: new Uint16Array(0),
                    },
            },
          });
        if (waitingForDecode && request.kind === 'mesh') waitingForDecode.push(decoded);
        else queueMicrotask(decoded);
      }
      terminate() {}
    },
  );
  const batches: { requests: Mesh[]; signal: AbortSignal; finish: (faces?: number) => void }[] = [];
  const surfaces: AtlasRequest[] = [];
  const load: AtlasOptions['load'] = async (req) => {
    surfaces.push(req);
    return surface && req.kind === 'surface' ? surface(req) : null;
  };
  const s = new AtlasStream(
    {
      edge: faceEdge,
      face: 0,
      initialView: camera(128, 100),
      load,
      loadMeshes: (requests, signal) =>
        new Promise((resolve) =>
          batches.push({
            requests,
            signal,
            finish: (faces = 1) => resolve(requests.map(() => new ArrayBuffer(32 + faces * 16))),
          }),
        ),
    },
    () => {},
  );
  current = s;
  return { s, batches, surfaces };
}
afterEach(() => {
  current?.destroy();
  vi.unstubAllGlobals();
});
const cells = (i: number, j: number, n: number) =>
  Array.from({ length: n }, (_, k) => [i + k, j + 2] as const);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it('keeps the whole paid response across a partial camera change, while a changed native cell supersedes it', async () => {
  const { s, batches } = replay(),
    a = camera(128, 100);
  const near = cells(127, 100, 3);
  s.setCoverage(near, 1);
  s.update(a, 'fly');
  await settle();
  const group = batches[0];
  if (!group) throw Error('missing first batch');
  expect(group.requests).toHaveLength(3);
  const keep = near[0],
    edited = near[2];
  if (!keep || !edited) throw Error('missing fixture');
  // A moving window still needs only the first member, while the second arrived
  // in the same response and the third has a genuine world revision in flight.
  s.setCoverage([keep], 1);
  s.update(a, 'fly');
  s.invalidate([edited]);
  s.update(a, 'fly');
  expect(group.signal.aborted).toBe(false);
  group.finish();
  await settle();
  s.setCoverage(near, 1);
  s.update(a, 'fly');
  await settle();
  expect(batches).toHaveLength(2);
  expect(batches[1]?.requests.map((r) => [r.i, r.j])).toEqual([edited]);
  expect(s.visible.filter((e) => e.request.kind === 'mesh')).toHaveLength(2);
});

it('serves a different flight direction before the old prefix returns, then presents its warm geometry without planning a fetch', async () => {
  const { s, batches } = replay();
  const a = camera(128, 100),
    b = camera(512, 100);
  s.setCoverage([...cells(127, 100, 3), ...cells(511, 100, 3)], 1);
  s.update(a, 'fly');
  await settle();
  const initial = batches[0];
  if (!initial) throw Error('missing initial batch');
  s.update(b, 'fly');
  await settle();
  expect(initial.signal.aborted).toBe(false);
  expect(batches).toHaveLength(2);
  expect(batches[1]?.requests.every((r) => r.i >= 511)).toBe(true);
  initial.finish();
  batches[1]?.finish();
  await settle();
  s.present(b, 'fly');
  expect(s.visible.filter((e) => e.request.kind === 'mesh')).toHaveLength(3);
  s.present(a, 'fly');
  expect(
    s.visible
      .filter((e) => e.request.kind === 'mesh')
      .map((e) => e.key)
      .sort(),
  ).toEqual(initial.requests.map(requestKey).sort());
  s.update(a, 'fly');
  await settle();
  expect(batches).toHaveLength(2);
});

it('puts detailed ground first and coalesces a distant dense ridge, leaving an isolated outcrop inexpensive', async () => {
  const { s, batches, surfaces } = replay(),
    a = camera(128, 100);
  const near = Array.from(
    { length: 144 },
    (_, k) => [122 + (k % 12), 102 + Math.floor(k / 12)] as const,
  );
  const ridge = Array.from(
    { length: 1024 },
    (_, k) => [128 + (k % 32), 416 + Math.floor(k / 32)] as const,
  );
  const rear = [128, 2] as const;
  s.setCoverage([...near, ...ridge, [111, 459], rear], 1);
  s.update(a, 'fly');
  await settle();
  expect(batches[0]?.requests).toHaveLength(3);
  expect(batches[0]?.requests.every((r) => r.lod === 1 && r.j < 112)).toBe(true);
  const wide = surfaces.findIndex(
    (r) => r.kind === 'surface' && r.lod === 6 && r.n === 32 && r.cj === 416,
  );
  expect(wide).toBeGreaterThanOrEqual(0);
  expect(wide).toBeLessThan(32);
  expect(
    surfaces.some((r) => r.kind === 'surface' && r.ci === 104 && r.cj === 456 && r.n === 8),
  ).toBe(true);
  // Spare native capacity prepares the rear only after the foreground ridge.
  expect(surfaces.findIndex((r) => r.kind === 'surface' && r.cj <= 2)).toBeGreaterThan(wide);
  batches[0]?.finish();
  await settle();
  expect(batches[1]?.requests).toHaveLength(16);
  const visible: number[] = [];
  s.forEachColumn({ i0: 128, i1: 128, j0: 416, j1: 417 }, (i, j) => visible.push(i, j));
  expect(visible).toEqual([128, 416, 128, 417]);
});

it('keeps a drawable mesh when its replacement LOD contains zero faces', async () => {
  const { s, batches } = replay();
  const close = camera(128, 100);
  const farther = camera(128, 83);
  s.setCoverage([[128, 102]], 1);
  s.update(farther, 'fly');
  await settle();
  expect(batches[0]?.requests[0]?.lod).toBe(2);
  batches[0]?.finish(0);
  await settle();
  s.update(close, 'fly');
  await settle();
  expect(batches[1]?.requests[0]?.lod).toBe(1);
  batches[1]?.finish();
  await settle();
  s.present(farther, 'fly');
  expect(s.visible.filter((e) => e.request.kind === 'mesh').map((e) => e.request)).toEqual([
    { kind: 'mesh', i: 128, j: 102, lod: 1 },
  ]);
});

it('retains far resident voxels until a current native surface actually covers the column', async () => {
  const waiting: { r: Surface; finish: () => void }[] = [];
  const { s, batches } = replay(
    (r) =>
      new Promise((resolve) => waiting.push({ r, finish: () => resolve(new ArrayBuffer(32)) })),
  );
  const a = camera(128, 100),
    far = camera(128, 40);
  s.setCoverage([[128, 102]], 1);
  s.update(a, 'fly');
  await settle();
  batches[0]?.finish();
  await settle();
  s.present(a, 'fly');
  expect(s.visible.some((e) => e.request.kind === 'mesh')).toBe(true);
  s.update(far, 'fly');
  await settle();
  expect(s.visible.some((e) => e.request.kind === 'mesh')).toBe(true);
  const pending = waiting.at(-1);
  if (!pending) throw Error('no distant surface');
  pending.finish();
  await settle();
  s.present(far, 'fly');
  expect(s.visible.some((e) => e.request.kind === 'surface' && e.value?.kind === 'raster')).toBe(
    true,
  );
  expect(s.visible.some((e) => e.request.kind === 'mesh')).toBe(false);
});

it('discovers a known occupied cell in the outer quadrant of a coarse native index bucket', async () => {
  const { s, batches, surfaces } = replay(
    async () => new ArrayBuffer(32),
    (i, j) => i === 48 && j === 48,
  );
  s.setCoverage([[0, 0]], 64);
  const f = camera(48, 45);
  s.update(f, 'fly');
  await settle();
  s.update(f, 'fly');
  await settle();
  expect(
    surfaces.filter(
      (r) =>
        r.kind === 'surface' &&
        r.lod === 6 &&
        r.ci <= 48 &&
        r.cj <= 48 &&
        r.ci + r.n > 48 &&
        r.cj + r.n > 48,
    ).length,
  ).toBeGreaterThan(0);
  expect(batches.flatMap((b) => b.requests.map((r) => [r.i, r.j]))).toEqual([[48, 48]]);
});

it('delivers the column under the crosshair in the first mesh group when looking down', async () => {
  const { s, batches } = replay();
  const camera = new AtlasCamera(edge, { x: 1600, z: 1600, span: 248 });
  camera.width = 800;
  camera.height = 480;
  camera.setMode('fly');
  camera.yaw = 0;
  camera.pitch = Math.PI / 6;
  camera.y = 30;
  camera.groundHeight = 30;
  s.setCoverage(
    Array.from({ length: 15 }, (_, k) => [100, 89 + k] as const),
    1,
  );
  s.update(camera.getFrame(), 'fly');
  await settle();
  expect(batches[0]?.requests[0]).toMatchObject({ i: 100, j: 100 });
});

it('prepares the entire populated transition band at rest and presents it immediately on a reversal', async () => {
  const columns = Array.from({ length: 64 }, (_, k) => {
    const angle = ((k % 16) * 2 * Math.PI) / 16,
      radius = 25 + Math.floor(k / 16) * 16;
    return [
      Math.round(200 + Math.sin(angle) * radius),
      Math.round(200 + Math.cos(angle) * radius),
    ] as const;
  });
  const { s, surfaces } = replay(async () => new ArrayBuffer(32));
  const north = camera(200, 200);
  s.setCoverage(columns, 1);
  s.update(north, 'fly');
  await settle();
  const stats = s.getDebugTerrain();
  expect(stats.middleWanted).toBeGreaterThan(28);
  expect(stats.middleReady).toBe(stats.middleWanted);
  expect(stats.behindReady).toBe(stats.behindWanted);
  expect(stats.behindWanted).toBeGreaterThan(12);
  expect(stats.middlePresentColumns).toBeGreaterThan(0);
  const readCount = surfaces.length;
  for (const yaw of [Math.PI, Math.PI / 2, -Math.PI / 2]) {
    const frame = camera(200, 200, yaw);
    s.present(frame, 'fly');
    for (const radius of [25, 41, 57, 73]) {
      const i = Math.round(200 + Math.sin(yaw) * radius),
        j = Math.round(200 + Math.cos(yaw) * radius);
      expect(
        s.visible.some(
          ({ request: r, value }) =>
            r.kind === 'surface' &&
            value?.kind === 'raster' &&
            r.ci <= i &&
            r.ci + r.n > i &&
            r.cj <= j &&
            r.cj + r.n > j,
        ),
      ).toBe(true);
    }
  }
  expect(surfaces).toHaveLength(readCount);
});

it('covers middle terrain behind a stationary eye inside a wide native index bucket without inventing mesh columns', async () => {
  const i = 381,
    j = 324;
  const { s, surfaces, batches } = replay(
    async () => new ArrayBuffer(32),
    (x, z) => x === i && z === j,
  );
  s.setCoverage([[256, 256]], 256);
  const north = camera(384, 384);
  s.update(north, 'fly');
  await settle();
  s.update(north, 'fly');
  await settle();
  expect(surfaces.length).toBeLessThan(180);
  expect(
    surfaces.some(
      (r) => r.kind === 'surface' && r.ci <= i && r.ci + r.n > i && r.cj <= j && r.cj + r.n > j,
    ),
  ).toBe(true);
  expect(batches).toHaveLength(0);
  expect(s.getDebugTerrain().behindPresentColumns).toBe(1);
  s.present(camera(384, 384, Math.PI), 'fly');
  expect(
    s.visible.some(
      ({ request: r, value: v }) =>
        r.kind === 'surface' &&
        v?.kind === 'raster' &&
        i >= r.ci &&
        j >= r.cj &&
        i < r.ci + r.n &&
        j < r.cj + r.n &&
        v.present?.[(j - r.cj) * r.n + i - r.ci],
    ),
  ).toBe(true);
});

it.each([
  [0.25, 1],
  [1, 2],
])(
  'prepares real 3D mesh columns behind the 2D surface at %s metres per pixel',
  async (mpp, expected) => {
    const { s, batches } = replay(
      async () => new ArrayBuffer(32),
      (x, z) => x === 180 && z === 180,
    );
    const cam = new AtlasCamera(edge, { x: 180 * 16, z: 180 * 16, span: 800 * mpp });
    cam.width = 800;
    cam.height = 480;
    const plan = cam.getFrame();
    // A sample authorizes a presence query only. The native response determines which voxel is real.
    s.setCoverage([[180, 180]], 4);
    for (let n = 0; n < 4; n++) {
      s.update(plan, 'plan');
      await settle();
    }
    expect(batches.flatMap((b) => b.requests)).toEqual([
      { kind: 'mesh', i: 180, j: 180, lod: expected },
    ]);
    batches[0]?.finish();
    await settle();
    s.present(plan, 'plan');
    expect(s.visible.some((e) => e.request.kind === 'mesh')).toBe(false);
    cam.setMode('iso');
    s.update(cam.getFrame(), 'iso');
    await settle();
    expect(s.visible.some((e) => e.request.kind === 'mesh' && e.request.lod === expected)).toBe(
      true,
    );
    expect(batches).toHaveLength(1);
  },
);

it('gives new foreground work a lane while the previous speculative batch is in flight', async () => {
  const { s, batches } = replay(async () => new ArrayBuffer(32));
  const north = camera(200, 200),
    east = camera(400, 200);
  s.setCoverage([...cells(199, 190, 3), ...cells(399, 200, 3)], 1);
  s.update(north, 'fly');
  await settle();
  const warm = batches[0];
  expect(warm?.requests.length).toBeLessThanOrEqual(2);
  if (!warm) throw Error('expected rear preparation');
  s.update(east, 'fly');
  await settle();
  expect(batches[1]?.requests).toHaveLength(3);
  expect(batches[1]?.requests.every((r) => r.i >= 399)).toBe(true);
  expect(warm.signal.aborted).toBe(false);
  warm.finish();
  batches[1]?.finish();
  await settle();
});

it('extends idle preparation to indexed terrain five kilometres behind, with locality for unindexed survey space', async () => {
  const north = camera(600, 600),
    south = camera(600, 600, Math.PI);
  const { s, surfaces } = replay(
    async () => new ArrayBuffer(32),
    (i, j) => i === 600 && j === 280,
  );
  s.setCoverage([[600, 280]], 1);
  s.setSurvey({ i0: 0, i1: 1600, j0: 0, j1: 1600 });
  s.update(north, 'fly');
  await settle();
  const farRear = surfaces.filter((r) => r.kind === 'surface' && r.cj < 400);
  expect(farRear).toEqual([{ kind: 'surface', ci: 600, cj: 280, n: 8, lod: 6 }]);
  s.present(south, 'fly');
  expect(
    s.visible.some(
      (e) => e.key === requestKey(farRear[0] as Surface) && e.value?.kind === 'raster',
    ),
  ).toBe(true);
});

it('keeps preparing after a full flight cache, protecting the new visible ground and suppressing churn at rest', async () => {
  const { s, batches } = replay(
    async () => new ArrayBuffer(32),
    () => true,
    4 * 1024 * 1024,
  );
  const old = camera(200, 200),
    latest = camera(1450, 1450);
  const oldArea = Array.from(
    { length: 26 },
    (_, k) => [198 + (k % 5), 201 + Math.floor(k / 5)] as const,
  );
  const rear = [
      [1449, 1442],
      [1450, 1442],
    ] as const,
    front = [1450, 1452] as const;
  s.setCoverage([...oldArea, ...rear, front], 1);
  s.update(old, 'fly');
  for (let n = 0; n < 4; n++) {
    await settle();
    batches.at(-1)?.finish();
    await settle();
    s.update(old, 'fly');
  }
  expect(s.getDebugTerrain().residentBytes).toBeGreaterThan(96 * 1024 * 1024 * 0.85);
  s.update(latest, 'fly');
  for (let n = 0; n < 5; n++) {
    await settle();
    batches.at(-1)?.finish();
    await settle();
    s.update(latest, 'fly');
  }
  expect(
    s.visible.some(
      (e) => e.request.kind === 'mesh' && e.request.i === front[0] && e.request.j === front[1],
    ),
  ).toBe(true);
  const reads = batches.length;
  s.present(camera(1450, 1450, Math.PI), 'fly');
  for (const [i, j] of rear) {
    expect(
      s.visible.some((e) => e.request.kind === 'mesh' && e.request.i === i && e.request.j === j),
    ).toBe(true);
    expect(
      batches.flatMap((batch) => batch.requests).filter((r) => r.i === i && r.j === j),
    ).toHaveLength(1);
  }
  s.update(latest, 'fly');
  await settle();
  expect(batches).toHaveLength(reads);
  expect(s.getDebugTerrain().residentBytes).toBeLessThanOrEqual(96 * 1024 * 1024);
});

it('retries a failed speculative tile while stationary and keeps its backoff out of the foreground lane', async () => {
  vi.useFakeTimers();
  try {
    const rear = [200, 150] as const;
    let attempts = 0;
    const { s, surfaces } = replay(async (r) => {
      if (r.cj <= rear[1] && r.cj + r.n > rear[1] && ++attempts < 3) throw { status: 503 };
      return new ArrayBuffer(32);
    });
    s.setCoverage([rear], 1);
    const north = camera(200, 200);
    s.update(north, 'fly');
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    s.setCoverage([rear, [200, 205]], 1);
    s.update(north, 'fly');
    await vi.advanceTimersByTimeAsync(4999);
    expect(surfaces.some((r) => r.kind === 'surface' && r.cj <= 205 && r.cj + r.n > 205)).toBe(
      true,
    );
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(14999);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    s.present(camera(200, 200, Math.PI), 'fly');
    expect(
      s.visible.some(
        (e) =>
          e.request.kind === 'surface' &&
          e.request.cj <= 150 &&
          e.request.cj + e.request.n > 150 &&
          e.value?.kind === 'raster',
      ),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('bounds a dense 2D inspection to the nearest 192 unique mesh columns, with at most two per speculative batch', async () => {
  const { s, batches } = replay(async () => new ArrayBuffer(32));
  const cam = new AtlasCamera(edge, { x: 200.5 * 16, z: 200.5 * 16, span: 448 });
  cam.width = 896;
  cam.height = 896;
  const plan = cam.getFrame();
  s.setCoverage(
    Array.from({ length: 28 * 28 }, (_, k) => [187 + (k % 28), 187 + Math.floor(k / 28)] as const),
    1,
  );
  s.update(plan, 'plan');
  await settle();
  s.update(plan, 'plan');
  await settle();
  let done = 0;
  while (done < batches.length && done <= 192) {
    batches[done++]?.finish();
    await settle();
  }
  const requests = batches.flatMap((b) => b.requests);
  expect(new Set(requests.map(requestKey)).size).toBe(192);
  expect(requests).toHaveLength(192);
  expect(batches.every((b) => b.requests.length <= 2)).toBe(true);
  expect(requests.some((r) => r.i === 200 && r.j === 200)).toBe(true);
  expect(Math.max(...requests.map((r) => Math.hypot(r.i - 200, r.j - 200)))).toBeLessThan(8);
  expect(s.getDebugTerrain().residentMeshes).toBe(192);
});

it('uses occupied columns from a refined raster before any coarse survey completes', async () => {
  const { s, batches, surfaces } = replay(
    (r) => (r.lod === 6 ? new Promise(() => {}) : Promise.resolve(new ArrayBuffer(24))),
    (i, j) => i === 128 && j === 104,
  );
  const frame = camera(128, 100);
  s.setCoverage([[128, 104]], 4);
  s.update(frame, 'fly');
  await settle();
  expect(surfaces.some((r) => r.kind === 'surface' && r.lod < 6)).toBe(true);
  s.update(frame, 'fly');
  await settle();
  expect(batches[0]?.requests).toContainEqual({ kind: 'mesh', i: 128, j: 104, lod: 1 });
});

it('dispatches a small visible preview and a full-detail group before broad native terrain reads on cold entry', async () => {
  const { s, batches, surfaces } = replay(() => new Promise(() => {}));
  const frame = camera(128, 100);
  s.setCoverage([...cells(127, 100, 15), ...cells(127, 360, 30)], 1);
  s.update(frame, 'fly');
  await settle();
  expect(surfaces[0]).toMatchObject({ kind: 'surface', n: 2, lod: 6 });
  expect(batches[0]?.requests).toHaveLength(3);
  expect(batches[0]?.requests.every((r) => r.lod === 1)).toBe(true);
  expect(surfaces.length).toBeLessThanOrEqual(5);
});

it('adapts the next group to observed dense geometry including after a turn', async () => {
  const { s, batches } = replay();
  const here = camera(128, 100),
    there = camera(512, 100);
  const area = (i: number) =>
    Array.from({ length: 48 }, (_, k) => [i + (k % 6), 102 + Math.floor(k / 6)] as const);
  s.setCoverage([...area(128), ...area(512)], 1);
  s.update(here, 'fly');
  await settle();
  expect(batches[0]?.requests).toHaveLength(3);
  // A 3 MiB mesh is valid. Three such records exceed the combined 8 MiB route.
  // The transport can split that first response; subsequent admissions learn its size.
  batches[0]?.finish((3 * 1024 * 1024) / 16);
  await settle();
  expect(batches[1]?.requests).toHaveLength(1);
  s.update(there, 'fly');
  await settle();
  expect(batches[2]?.requests).toHaveLength(1);
  expect(batches[2]?.requests[0]?.i).toBeGreaterThanOrEqual(512);
});

it('promotes adjacent observed voxels on distant rows when the face size is still unknown', async () => {
  const i = 128,
    j = 2 ** 22;
  const { s, batches } = replay(
    async () => new ArrayBuffer(32),
    (x, z) => (x === i || x === i + 1) && z === j,
    16,
    2 ** 35,
  );
  s.setCoverage([[i, j]], 4);
  const frame = {
    x: i * 16,
    z: j * 16,
    span: 64,
    width: 800,
    height: 480,
    yaw: 0,
    bounds: { i0: i, i1: i + 3, j0: j, j1: j + 3 },
  };
  s.update(frame, 'iso');
  await settle();
  s.update(frame, 'iso');
  await settle();
  expect(batches.flatMap((batch) => batch.requests)).toEqual([
    { kind: 'mesh', i, j, lod: 1 },
    { kind: 'mesh', i: i + 1, j, lod: 1 },
  ]);
});

it('holds at most two mesh groups across a returning request and a stalled decoder', async () => {
  const decoding: (() => void)[] = [];
  const { s, batches } = replay(undefined, undefined, 16, edge, decoding);
  s.setCoverage([...cells(127, 100, 3), ...cells(507, 100, 12)], 1);
  s.update(camera(128, 100), 'fly');
  await settle();
  s.update(camera(512, 100), 'fly');
  await settle();
  expect(batches).toHaveLength(2);
  batches[1]?.finish();
  await settle();
  expect(decoding).toHaveLength(3);
  expect(batches).toHaveLength(2);
  batches[0]?.finish();
  await settle();
  expect(decoding).toHaveLength(6);
  expect(batches).toHaveLength(2);
  for (const done of decoding.splice(0, 3)) done();
  await settle();
  expect(batches).toHaveLength(3);
});

it('lets new focal detail overtake a large batch still serving visible peripheral voxels', async () => {
  const { s, batches } = replay();
  const old = Array.from(
    { length: 48 },
    (_, k) => [125 + (k % 6), 103 + Math.floor(k / 6)] as const,
  );
  s.setCoverage(old, 1);
  s.update(camera(128, 100), 'fly');
  await settle();
  batches[0]?.finish();
  await settle();
  const peripheral = batches[1];
  expect(peripheral?.requests.length).toBeGreaterThan(3);
  s.setCoverage([...old, ...cells(127, 92, 3)], 1);
  s.update(camera(128, 92), 'fly');
  await settle();
  expect(peripheral?.signal.aborted).toBe(false);
  expect(batches[2]?.requests[0]).toMatchObject({ j: 94, lod: 1 });
});
