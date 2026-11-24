import { expect, it, vi } from 'vitest';
import { openworldMapDebugBatch } from '../../../../../games/openworld/src/map-debug.js';
import type { AtlasFrame } from './atlas-types.js';
import { readAtlasMeshes, readAtlasResource } from './map-atlas-data.js';
import { createMapDebugRecorder } from './map-debug-recorder.js';

function fixture() {
  const frame: AtlasFrame = {
    x: 120,
    z: 160,
    span: 900,
    yaw: 0,
    width: 1024,
    height: 576,
    bounds: { i0: 0, i1: 12, j0: 0, j1: 12 },
  };
  const terrain = {
    queued: 0,
    pending: 0,
    residentBytes: 0,
    residentMeshes: 0,
    residentSurfaces: 0,
    visibleMeshes: 0,
    visibleSurfaces: 0,
    middleReady: 0,
    middleWanted: 0,
    behindReady: 0,
    behindWanted: 0,
    middlePresentColumns: 0,
    behindPresentColumns: 0,
  };
  const state = () => ({ frame, mode: 'iso' as const, terrain });
  const time = { ms: 0 };
  const reportError = vi.fn();
  const send = vi.fn<Parameters<typeof createMapDebugRecorder>[1]>().mockResolvedValue(true);
  const active = createMapDebugRecorder(state, send, reportError, () => time.ms);
  return { active, send, reportError, frame, time };
}

it('includes reversals and HTTP outcomes in a final report on a sub-second debug session', async () => {
  const { active, send, time, frame } = fixture();
  active.sample();
  await Promise.resolve();
  time.ms = 240;
  active.draw(Math.PI / 2);
  active.draw(0);
  frame.yaw = 0;
  active.request('surface', 'aborted');
  active.request('surface', 'aborted');
  active.request('mesh', 'conflict');
  active.request('mesh', 'empty');
  active.stop(true);
  const last = send.mock.calls[1];
  expect(last?.[3]).toBe(true);
  expect(last?.[1]).toMatchObject([
    {
      ms: 240,
      turnDegrees: 180,
      draws: 2,
      terrainRequests: { aborted: 2 },
      meshRequests: { conflict: 1, empty: 1 },
    },
  ]);
  expect(
    openworldMapDebugBatch.safeParse({
      traceId: crypto.randomUUID(),
      batch: 1,
      processRef: 'f'.repeat(64),
      world: 'earth',
      face: 0,
      samples: last?.[1],
    }).success,
  ).toBe(true);
  active.sample();
  active.stop(true);
  expect(send).toHaveBeenCalledTimes(2);
});

it('bounds the samples buffered behind a slow request and stops when recording is disabled on the API', async () => {
  const { active, send, reportError, time } = fixture();
  let resolve!: (recorded: boolean) => void;
  send.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  active.sample();
  for (let i = 1; i <= 32; i++) {
    time.ms = i * 500;
    active.draw(0);
    active.sample();
  }
  expect(send).toHaveBeenCalledTimes(1);
  resolve(true);
  await new Promise((done) => setTimeout(done, 0));
  send.mockResolvedValue(false);
  active.sample();
  const samples = send.mock.calls[1]?.[1];
  expect(samples).toHaveLength(8);
  expect(samples?.[0]?.ms).toBeGreaterThanOrEqual(12500);
  await new Promise((done) => setTimeout(done, 0));
  expect(reportError).toHaveBeenLastCalledWith(true);
  time.ms += 60_000;
  active.sample();
  active.stop(true);
  expect(send).toHaveBeenCalledTimes(2);
});

it('distinguishes completed HTTP conflicts and empty responses from locally aborted HTTP reads', async () => {
  const debug = { request: vi.fn() };
  const read = (abort: AbortController) =>
    readAtlasResource(
      'server',
      'earth',
      'process',
      0,
      0,
      { kind: 'surface', ci: 0, cj: 0, n: 1, lod: 2 },
      abort.signal,
      debug,
    );
  const controller = new AbortController();
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await read(controller)).toBeNull();
    fetch.mockResolvedValueOnce(new Response('terrain'));
    await read(controller);
    fetch.mockResolvedValueOnce(Response.json({ error: { code: 'conflict' } }, { status: 409 }));
    await expect(
      readAtlasMeshes(
        'server',
        'earth',
        'process',
        0,
        0,
        [{ kind: 'mesh', i: 0, j: 0, lod: 1 }],
        controller.signal,
        debug,
      ),
    ).rejects.toMatchObject({ status: 409 });
    fetch.mockRejectedValueOnce(new TypeError('network'));
    await expect(read(controller)).rejects.toBeInstanceOf(TypeError);
    controller.abort();
    fetch.mockRejectedValueOnce(controller.signal.reason);
    await expect(read(controller)).rejects.toMatchObject({ name: 'AbortError' });
    expect(debug.request.mock.calls).toEqual([
      ['surface', 'empty'],
      ['surface', 'ok'],
      ['mesh', 'conflict'],
      ['surface', 'failed'],
      ['surface', 'aborted'],
    ]);
  } finally {
    fetch.mockRestore();
  }
});
