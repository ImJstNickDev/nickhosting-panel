import {
  flightBounds,
  flightHalfFov,
  flightNearClip,
  makeFlightView,
} from './atlas-flight-plan.js';
import type { AtlasFrame, AtlasMode, AtlasView } from './atlas-types.js';

export type Vec3 = [number, number, number];
export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const tanHalfFov = Math.tan(flightHalfFov);
const isoPitch = Math.PI / 6;
const isoYaw = (3 * Math.PI) / 4;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class AtlasCamera {
  mode: AtlasMode = 'plan';
  width = 1;
  height = 1;
  x = 0;
  z = 0;
  y = 0;
  span = 128;
  yaw = isoYaw;
  pitch = isoPitch;
  groundHeight: number | undefined;
  seedTerrain = false;
  private translatedAt = Number.NEGATIVE_INFINITY;
  private leadX = 0;
  private leadZ = 0;

  constructor(
    readonly edge: number,
    start: AtlasView,
  ) {
    this.setView(start);
  }
  setView(view: AtlasView) {
    this.translatedAt = Number.NEGATIVE_INFINITY;
    this.groundHeight = undefined;
    this.x = clamp(view.x, 0, this.edge);
    this.z = clamp(view.z, 0, this.edge);
    this.span = clamp(view.span, 4, Math.max(128, this.edge * 2));
  }
  get basis() {
    if (this.mode === 'plan')
      return { right: [-1, 0, 0] as Vec3, up: [0, 0, 1] as Vec3, forward: [0, -1, 0] as Vec3 };
    const sx = Math.sin(this.yaw),
      sz = Math.cos(this.yaw);
    const pitch = this.mode === 'iso' ? isoPitch : this.pitch;
    const sp = Math.sin(pitch),
      cp = Math.cos(pitch);
    return {
      right: [-sz, 0, sx] as Vec3,
      up: [sp * sx, cp, sp * sz] as Vec3,
      forward: [cp * sx, -sp, cp * sz] as Vec3,
    };
  }
  get distance() {
    return (this.span * this.height) / (this.width * 2 * tanHalfFov);
  }
  get near() {
    return flightNearClip(this.distance);
  }
  get far() {
    return Math.max(4096, this.span * 6, Math.abs(this.y) + 20000);
  }
  setMode(mode: AtlasMode) {
    this.translatedAt = Number.NEGATIVE_INFINITY;
    this.mode = mode;
    if (mode === 'fly') this.pitch = isoPitch;
  }
  look(dx: number, dy: number) {
    if (this.mode === 'plan') return;
    const old = this.basis.forward;
    this.yaw += dx;
    if (this.mode !== 'fly') return;
    this.pitch = clamp(this.pitch + dy, -1.54, 1.54);
    const next = this.basis.forward;
    const distance = this.distance;
    this.x += (next[0] - old[0]) * distance;
    this.y += (next[1] - old[1]) * distance;
    this.z += (next[2] - old[2]) * distance;
  }
  move(right: number, forward: number, up: number) {
    const yaw = this.mode === 'plan' ? 0 : this.yaw;
    const dx = -Math.cos(yaw) * right + Math.sin(yaw) * forward;
    const dz = Math.sin(yaw) * right + Math.cos(yaw) * forward;
    if (this.mode !== 'fly') {
      this.x = clamp(this.x + dx, 0, this.edge);
      this.z = clamp(this.z + dz, 0, this.edge);
      return;
    }
    // Looking can put the focal point beyond a face edge while the eye is still inside it.
    // Constrain displacement at the eye so pressing a movement key cannot teleport it.
    const direction = this.basis.forward;
    const distance = this.distance;
    const bounded = (delta: number, eye: number, min: number, max: number) =>
      clamp(delta, Math.min(0, min - eye), Math.max(0, max - eye));
    const stepX = bounded(dx, this.x - distance * direction[0], 0, this.edge);
    const stepZ = bounded(dz, this.z - distance * direction[2], 0, this.edge);
    const now = performance.now();
    const elapsed = now - this.translatedAt;
    // Extrapolate a short segment of actual motion (including strafing).
    // A discrete navigation jump has no velocity, and a stopped eye has no lead.
    const extrapolate = elapsed <= 120 ? Math.min(300 / Math.max(4, elapsed), 36) : 0;
    const magnitude = Math.hypot(stepX, stepZ) * extrapolate;
    const scale = extrapolate * Math.min(1, 80 / Math.max(1, magnitude));
    this.leadX = stepX * scale;
    this.leadZ = stepZ * scale;
    this.translatedAt = now;
    this.x += stepX;
    this.y += bounded(up, this.y - distance * direction[1], -10000, 50000);
    this.z += stepZ;
  }
  project(x: number, z: number, y: number) {
    const b = this.basis,
      local: Vec3 = [x - this.x, y - this.y, z - this.z];
    const depth = dot(local, b.forward) + this.distance;
    const w = this.mode === 'fly' ? depth / this.distance : 1;
    const scale = this.width / this.span;
    const px = this.width / 2 + (dot(local, b.right) * scale) / w;
    const py = this.height / 2 - (dot(local, b.up) * scale) / w;
    return {
      x: px,
      y: py,
      visible:
        (this.mode !== 'fly' || (depth >= this.near && depth <= this.far)) &&
        px >= 0 &&
        py >= 0 &&
        px <= this.width &&
        py <= this.height,
    };
  }
  ray(px: number, py: number) {
    const b = this.basis,
      scale = this.span / this.width;
    const right = (px - this.width / 2) * scale,
      up = (this.height / 2 - py) * scale;
    const across: Vec3 = [0, 0, 0];
    for (const i of [0, 1, 2] as const) across[i] = b.right[i] * right + b.up[i] * up;
    const origin: Vec3 = [this.x, this.y, this.z];
    const dir: Vec3 = [...b.forward];
    for (const i of [0, 1, 2] as const) {
      if (this.mode === 'fly') {
        origin[i] -= b.forward[i] * this.distance;
        dir[i] += across[i] / this.distance;
      } else {
        origin[i] += across[i] - b.forward[i] * this.far;
      }
    }
    return { origin, dir };
  }
  atHeight(px: number, py: number, height: number) {
    const { origin, dir } = this.ray(px, py);
    if (Math.abs(dir[1]) < 0.0001) return null;
    const travel = (height - origin[1]) / dir[1];
    if (travel < 0 || (this.mode === 'fly' && (travel < this.near || travel > this.far)))
      return null;
    return { x: origin[0] + dir[0] * travel, z: origin[2] + dir[2] * travel };
  }
  getFrame(): AtlasFrame {
    if (this.mode === 'fly') {
      const moving = performance.now() - this.translatedAt <= 180;
      const flight = makeFlightView(this, moving ? this.leadX : 0, moving ? this.leadZ : 0);
      return {
        x: this.x,
        z: this.z,
        span: this.span,
        width: this.width,
        height: this.height,
        yaw: this.yaw,
        flight,
        bounds: flightBounds(flight, this.edge, false),
        detailBounds: flightBounds(flight, this.edge, true),
      };
    }
    const mpp = this.span / this.width;
    const halfX = this.span / 2,
      halfZ = (this.height * mpp) / 2;
    const radius = this.mode === 'plan' ? 0 : Math.max(48, Math.hypot(halfX, halfZ) * 2);
    const max = Math.ceil(this.edge / 16) - 1;
    const col = (v: number) => clamp(Math.floor(v / 16), 0, max);
    const detailBounds = {
      i0: col(this.x - (radius || halfX)),
      i1: col(this.x + (radius || halfX)),
      j0: col(this.z - (radius || halfZ)),
      j1: col(this.z + (radius || halfZ)),
    };
    const bounds = { ...detailBounds };
    return {
      x: this.x,
      z: this.z,
      span: this.span,
      width: this.width,
      height: this.height,
      yaw: this.mode === 'plan' ? 0 : this.yaw,
      bounds,
      detailBounds,
    };
  }
}
