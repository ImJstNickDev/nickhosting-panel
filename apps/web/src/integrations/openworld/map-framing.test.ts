import { expect, it } from 'vitest';
import { AtlasCamera } from './atlas-camera.js';
import { footprintWindow } from './map-framing.js';

it('reuses the same native column query through a stationary turn and steep tilt', () => {
  const camera = new AtlasCamera(1_000_000, { x: 83_100, z: 54_700, span: 96 });
  camera.width = 1280;
  camera.height = 720;
  camera.y = 250;
  camera.setMode('fly');
  const readView = () => {
    const { flight, coverageBounds } = camera.getFrame();
    if (!flight || !coverageBounds) throw Error('Expected free-flight index bounds');
    return { horizon: flight.horizon, window: footprintWindow(coverageBounds) };
  };
  const level = readView();
  camera.look(Math.PI, Math.PI / 3);
  const downward = readView();
  expect(downward.horizon).toBeLessThan(level.horizon / 2);
  expect(downward.window).toEqual(level.window);
  camera.look(-Math.PI, -Math.PI / 2);
  expect(readView().window).toEqual(level.window);
  camera.move(12_000, 0, 0);
  expect(readView().window).not.toEqual(level.window);
});

it('covers the view and keeps padded, aligned requests within the dense index budget', () => {
  for (const [start, span] of [
    [63, 96],
    [32, 48],
    [513, 97],
    [17000, 1500],
    [5167077, 40000],
  ] as const) {
    const end = start + span - 1;
    const w = footprintWindow({ i0: start, i1: end, j0: start, j1: end });
    expect(w.i0).toBeLessThanOrEqual(start);
    expect(w.i1).toBeGreaterThanOrEqual(end);
    const cols = Math.floor(w.i1 / w.stride) - Math.floor(w.i0 / w.stride) + 1;
    const rows = Math.floor(w.j1 / w.stride) - Math.floor(w.j0 / w.stride) + 1;
    expect(cols * rows).toBeLessThanOrEqual(32768);
  }
});
