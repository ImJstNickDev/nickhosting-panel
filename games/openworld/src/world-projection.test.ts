import { expect, it } from 'vitest';
import { projectOpenworldPosition } from './world-projection.js';

// Points returned by POST /api/live/checkpoints on an isolated a1.2.10 Earth.
it.each([
  [3, 6, 0, 771729.066667, 820093.550552],
  [68, 12, 1, 369786.844444, 931089.916522],
  [-160, 21, 2, 1045049.777778, 1080742.149083],
  [-103, -15, 3, 514486.044444, 476283.679766],
  [13, 68, 4, 1068975.374035, 806989.42992],
  [-41, -70, 5, 476545.36525, 507573.536302],
  [45, 0, 0, 1446992, 723496],
  [178, 88, 4, 691360.194516, 724618.661959],
])('projects longitude %s and latitude %s on the native face', (lon, lat, face, x, z) => {
  const point = projectOpenworldPosition(lon, lat, 1446992);
  expect(point?.face).toBe(face);
  expect(point?.x).toBeCloseTo(x, 4);
  expect(point?.z).toBeCloseTo(z, 4);
});
it('requires a measured planet size and valid geographic coordinates', () => {
  expect(projectOpenworldPosition(0, 0, 0)).toBeNull();
  expect(projectOpenworldPosition(45, 91, 400)).toBeNull();
  expect(projectOpenworldPosition(Infinity, 0, 400)).toBeNull();
});
