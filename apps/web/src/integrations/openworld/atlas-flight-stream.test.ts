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
) {
  vi.stubGlobal(
    'Worker',
    class {
      onmessage?: (event: { data: unknown }) => void;
      postMessage({ id, request }: { id: number; request: AtlasRequest }) {
        const present =
          request.kind === 'surface'
            ? Uint8Array.from({ length: request.n * request.n }, (_, k) =>
                Number(
                  occupied(request.ci + (k % request.n), request.cj + Math.floor(k / request.n)),
                ),
              )
            : undefined;
        queueMicrotask(() =>
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
                      pixels: new Uint16Array(request.n * request.n * 4),
                    }
                  : {
                      kind: 'quads',
                      materials: [2],
                      minY: 64,
                      maxY: 65,
                      regionX: 0,
                      regionZ: 0,
                      opaque: new Uint16Array(8),
                      blend: new Uint16Array(0),
                    },
            },
          }),
        );
      }
      terminate() {}
    },
  );
  const batches: { requests: Mesh[]; signal: AbortSignal; finish: () => void }[] = [];
  const surfaces: AtlasRequest[] = [];
  const load: AtlasOptions['load'] = async (req) => {
    surfaces.push(req);
    return surface && req.kind === 'surface' ? surface(req) : null;
  };
  const s = new AtlasStream(
    {
      edge,
      face: 0,
      initialView: camera(128, 100),
      load,
      loadMeshes: (requests, signal) =>
        new Promise((resolve) =>
          batches.push({
            requests,
            signal,
            finish: () => resolve(requests.map(() => new ArrayBuffer(32))),
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
  expect(surfaces.some((r) => r.kind === 'surface' && r.cj <= 2)).toBe(false);
  batches[0]?.finish();
  await settle();
  expect(batches[1]?.requests).toHaveLength(16);
  const visible: number[] = [];
  s.forEachColumn({ i0: 128, i1: 128, j0: 416, j1: 417 }, (i, j) => visible.push(i, j));
  expect(visible).toEqual([128, 416, 128, 417]);
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
