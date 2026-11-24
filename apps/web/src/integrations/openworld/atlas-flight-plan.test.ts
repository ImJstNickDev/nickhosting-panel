import { describe, expect, it, vi } from 'vitest';
import { AtlasCamera } from './atlas-camera.js';
import {
  flightBoxVisible,
  flightDemand,
  flightDepthBands,
  flightDepthSplit,
  flightIntersects,
} from './atlas-flight-plan.js';

function camera(width = 1280, height = 720) {
  const cam = new AtlasCamera(256000, { x: 96000, z: 96000, span: 100 });
  cam.width = width;
  cam.height = height;
  cam.y = 380;
  cam.setMode('fly');
  cam.yaw = 0;
  cam.pitch = 0;
  return cam;
}
function flying(cam: AtlasCamera) {
  const f = cam.getFrame().flight;
  if (!f) throw new Error('Expected perspective camera');
  return f;
}
function at(f: ReturnType<typeof flying>, angle: number, metres: number): [number, number] {
  return [
    Math.floor((f.eyeX + Math.sin(angle) * metres) / 16),
    Math.floor((f.eyeZ + Math.cos(angle) * metres) / 16),
  ];
}

describe('perspective terrain planning', () => {
  it('loads a deep native skyline, a guard wider than the lens, and a graded turn halo', () => {
    const cam = camera(),
      f = flying(cam);
    expect(f.horizon).toBe(8192);
    const far = at(f, 0, 7600);
    const frame = cam.getFrame();
    expect(frame.bounds.j1).toBeGreaterThanOrEqual(far[1]);
    expect(frame.detailBounds?.j1).toBeLessThan(far[1]);
    expect(flightDemand(f, ...far)).toMatchObject({ surfaceLod: 6, meshLod: null });
    expect(flightDemand(f, ...at(f, 0, 240))?.meshLod).toBe(1);
    expect(flightDemand(f, ...at(f, 0, 570))?.meshLod).toBe(2);
    const shoulder = at(f, f.halfDraw + 0.2, 400);
    expect(flightIntersects(f, ...shoulder, 1, 'draw')).toBe(false);
    expect(flightDemand(f, ...shoulder)?.meshLod).toBe(2);
    expect(flightDemand(f, ...at(f, Math.PI, 40))?.meshLod).toBe(1);
    expect(flightDemand(f, ...at(f, Math.PI, 84))?.meshLod).toBe(2);
    expect(flightDemand(f, ...at(f, Math.PI, 240))).toMatchObject({ surfaceLod: 6, meshLod: null });
    expect(flightDemand(f, ...at(f, Math.PI, 600))).toBeNull();
    const eye = cam.ray(cam.width / 2, cam.height / 2).origin;
    cam.look(Math.PI, 0);
    const after = flying(cam);
    for (const [axis, coordinate] of cam.ray(cam.width / 2, cam.height / 2).origin.entries())
      expect(coordinate).toBeCloseTo(eye[axis] ?? 0, 8);
    expect(flightDemand(after, ...far)).toBeNull();
    expect(flightDemand(after, ...at(f, Math.PI, 7600))?.surfaceLod).toBe(6);
  });

  it('assigns both sides of a sloping region to their proper depth projection', () => {
    const cam = camera();
    const f = flying(cam),
      plane = f.eyeZ + flightDepthSplit;
    const bands = (z0: number, z1: number) =>
      flightDepthBands(f, f.eyeX - 8, z0, f.eyeX + 8, z1, f.eyeY - 8, f.eyeY + 8);
    expect(bands(plane - 32, plane - 2)).toBe(1);
    expect(bands(plane + 2, plane + 32)).toBe(2);
    expect(bands(plane - 32, plane + 32)).toBe(3);
    const eye = cam.ray(cam.width / 2, cam.height / 2).origin;
    expect(cam.project(eye[0], eye[2] + cam.near / 2, eye[1]).visible).toBe(false);
    expect(cam.project(eye[0], eye[2] + cam.near * 2, eye[1]).visible).toBe(true);
    expect(cam.project(eye[0], eye[2] + cam.far + 1, eye[1]).visible).toBe(false);
    cam.look(0, Math.PI / 3);
    const tilted = flying(cam);
    const point = cam.ray(cam.width / 2, cam.height / 2);
    const x = point.origin[0] + point.dir[0] * flightDepthSplit;
    const z = point.origin[2] + point.dir[2] * flightDepthSplit;
    const y = point.origin[1] + point.dir[1] * flightDepthSplit;
    expect(flightDepthBands(tilted, x - 1, z - 1, x + 1, z + 1, y - 40, y + 40)).toBe(3);
  });
  it('uses screen scale and does not fetch voxel meshes directly below a high eye', () => {
    const cam = camera();
    cam.pitch = Math.PI / 2 - 0.01;
    const near = flying(cam);
    expect(near.horizon).toBeLessThan(2000);
    expect(near.halfDraw).toBe(Math.PI);
    cam.seedTerrain = true;
    expect(flying(cam).horizon).toBeGreaterThan(near.horizon + 3000);
    cam.seedTerrain = false;
    for (const yaw of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      expect(flightDemand(near, ...at(near, yaw, 40))?.meshLod).toBe(1);
    }
    cam.y += 3500;
    cam.groundHeight = 350;
    const high = flying(cam);
    expect(high.horizon).toBeGreaterThan(near.horizon);
    expect(flightDemand(high, ...at(high, 0, 0))?.meshLod).toBe(null);
    expect(flightDemand(high, ...at(high, 0, 0))?.surfaceLod).toBeGreaterThan(3);
    cam.setView({ x: 130000, z: 130000, span: 100 });
    expect(cam.groundHeight).toBeUndefined();
  });

  it('agrees with camera projection and keeps every frustum-intersecting terrain box', () => {
    const cam = camera();
    for (const aspect of [0.5, 1.78, 3.2]) {
      cam.width = 720 * aspect;
      for (const pitch of [-1.5, -0.6, 0, 0.5, 1.54]) {
        cam.pitch = pitch;
        cam.yaw = 2.7;
        const f = flying(cam);
        for (const depth of [1, 100, 1400]) {
          for (const [px, py] of [
            [0, 0],
            [cam.width, 0],
            [cam.width, cam.height],
            [0, cam.height],
            [cam.width / 2, cam.height / 2],
          ] as const) {
            const { origin, dir } = cam.ray(px, py);
            const x = origin[0] + depth * dir[0],
              y = origin[1] + depth * dir[1],
              z = origin[2] + depth * dir[2];
            expect(flightBoxVisible(f, x, z, x, z, y, y)).toBe(true);
            if (y >= 0 && Math.hypot(x - f.eyeX, z - f.eyeZ) < f.horizon) {
              expect(flightIntersects(f, Math.floor(x / 16), Math.floor(z / 16), 1, 'draw')).toBe(
                true,
              );
            }
          }
        }
        const { origin, dir } = cam.ray(cam.width / 2, cam.height / 2);
        for (const depth of [-48, cam.far + 48]) {
          const x = origin[0] + depth * dir[0],
            y = origin[1] + depth * dir[1],
            z = origin[2] + depth * dir[2];
          expect(flightBoxVisible(f, x - 1, z - 1, x + 1, z + 1, y - 1, y + 1)).toBe(false);
        }
      }
    }
  });

  it('adds a bounded movement lead, clears it at rest, and gives containing blocks conservative LOD', () => {
    let tick = 10;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => tick);
    try {
      const cam = camera();
      cam.move(4, 0, 0);
      tick += 16;
      cam.move(4, 0, 0);
      const f = flying(cam);
      expect(f.leadX).toBeLessThan(-50);
      expect(f.leadZ).toBe(0);
      const leadCell = at(f, -Math.PI / 2, 136);
      expect(flightDemand(f, ...leadCell)?.meshLod).not.toBeNull();
      tick += 500;
      expect(flightDemand(flying(cam), ...leadCell)?.meshLod).toBeNull();
      cam.groundHeight = cam.y - 540;
      for (const altitude of [undefined, cam.y - 540, cam.y - 1250]) {
        cam.groundHeight = altitude;
        tick += 16;
        cam.move(0, 4, 0);
        tick += 16;
        cam.move(0, 4, 0);
        const v = flying(cam);
        let actualChecks = 0;
        for (let i = Math.floor(v.eyeX / 16) - 64; i <= Math.floor(v.eyeX / 16) + 64; i += 3) {
          for (let j = Math.floor(v.eyeZ / 16) - 64; j <= Math.floor(v.eyeZ / 16) + 64; j += 3) {
            const child = flightDemand(v, i, j);
            if (!child) continue;
            const parent = flightDemand(v, Math.floor(i / 8) * 8, Math.floor(j / 8) * 8, 8);
            expect(parent).not.toBeNull();
            if (child.meshLod) {
              expect(parent?.meshLod ?? Infinity).toBeLessThanOrEqual(child.meshLod);
              actualChecks++;
            }
          }
        }
        expect(actualChecks).toBeGreaterThan(0);
      }
    } finally {
      clock.mockRestore();
    }
  });
});
