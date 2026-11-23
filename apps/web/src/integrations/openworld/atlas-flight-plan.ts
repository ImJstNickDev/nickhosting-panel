import type { AtlasCamera } from './atlas-camera.js';
import type { AtlasBounds } from './atlas-types.js';

// Pack two perspective projections into one fixed-point depth buffer. A 2.5cm
// near plane with a single projection can otherwise quantize ridges 100m apart
// to the same depth at the horizon.
export const flightDepthSplit = 256;
export const flightNearClip = (distance: number) => Math.max(0.025, Math.min(1, distance / 1000));
// Adjacent float32 clip depths give a face exactly on the split one owner,
// including translucent faces that do not write depth.
export const flightFarNearClip = flightDepthSplit * (1 + 2 ** -23);

export const flightHalfFov = (25 * Math.PI) / 180;
const guard = (22 * Math.PI) / 180;
const columnMetres = 16;
const halfDiagonal = Math.SQRT1_2;

type Plane = readonly [number, number, number, number];
export type AtlasFlightView = ReturnType<typeof makeFlightView>;

// The planner knows a column's footprint before it knows the mountain's height.
// Project the entire camera frustum onto the horizontal plane, including both
// upper corners. As the camera points almost straight down this becomes a disk.
export function makeFlightView(camera: AtlasCamera, leadX: number, leadZ: number) {
  const { x, y, z, yaw, pitch, width, height, distance, far, groundHeight, seedTerrain } = camera;
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const eyeX = x - cp * sinYaw * distance;
  const eyeY = y + sp * distance;
  const eyeZ = z - cp * cosYaw * distance;
  const tanV = Math.tan(flightHalfFov);
  const tanH = tanV * (width / height);
  const minForward = cp - Math.abs(sp) * tanV;
  const halfDraw = minForward <= 0 ? Math.PI : Math.atan2(tanH, minForward);
  const halfLoad = Math.min(Math.PI, halfDraw + guard);
  const focalPixels = height / (2 * tanV);
  const turnMesh = Math.min(112, Math.max(48, focalPixels * 0.12));
  const turnSurface = Math.max(256, turnMesh * 4);
  const meshReach = Math.min(768, Math.max(240, focalPixels * 0.9));
  let horizon = Math.max(8192, distance * 2.5, (width / focalPixels) * distance);
  // When even the padded top ray points down, intersect it with the lowest
  // representable height. The optional seed raster stores signed decimetres.
  const paddedTanV = Math.tan(flightHalfFov + guard / 2);
  const down = sp - cp * paddedTanV;
  if (down > 0) {
    const sideways = Math.hypot(cp + Math.abs(sp) * paddedTanV, tanH * 1.5);
    const floor = seedTerrain ? -3276.8 : 0;
    horizon = Math.min(horizon, (Math.max(0, eyeY - floor) * sideways) / down + turnSurface);
  }

  // Clip planes share the same eye, projection and near/far as the GPU shader.
  // Each stores a normal and the offset in eye-relative metres.
  const planes: Plane[] = [];
  const plane = (forward: number, up: number, right: number, offset = 0) => {
    const horizontal = forward * cp + up * sp;
    planes.push([
      horizontal * sinYaw - right * cosYaw,
      -forward * sp + up * cp,
      horizontal * cosYaw + right * sinYaw,
      offset,
    ]);
  };
  plane(1, 0, 0, -flightNearClip(distance));
  plane(-1, 0, 0, far);
  plane(tanH, 0, 1);
  plane(tanH, 0, -1);
  plane(tanV, 1, 0);
  plane(tanV, -1, 0);
  return {
    forwardX: cp * sinYaw,
    forwardY: -sp,
    forwardZ: cp * cosYaw,
    eyeX,
    eyeY,
    eyeZ,
    sinYaw,
    cosYaw,
    pitch,
    focalPixels,
    leadX,
    leadZ,
    horizon,
    meshReach,
    // Keep the transition from voxels to the distant skyline ready in every direction.
    turnCoverage: Math.min(2304, Math.max(1536, meshReach * 3)),
    turnMesh,
    turnSurface,
    altitude: groundHeight === undefined ? 0 : Math.max(0, eyeY - groundHeight),
    halfLoad,
    sinLoad: Math.sin(halfLoad),
    cosLoad: Math.cos(halfLoad),
    halfDraw,
    sinDraw: Math.sin(halfDraw),
    cosDraw: Math.cos(halfDraw),
    planes,
  };
}

export function flightBoxVisible(
  f: AtlasFlightView,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  minY: number,
  maxY: number,
) {
  // The AABB corner furthest inside each plane. Retain touching tiles.
  for (const [nx, ny, nz, offset] of f.planes) {
    if (
      nx * ((nx < 0 ? x0 : x1) - f.eyeX) +
        ny * ((ny < 0 ? minY : maxY) - f.eyeY) +
        nz * ((nz < 0 ? z0 : z1) - f.eyeZ) +
        offset <
      -0.00001
    )
      return false;
  }
  return true;
}

// Bit 1 is the near projection, bit 2 the far projection. A spanning box
// is submitted to both, clipped by the hardware at the common plane.
export function flightDepthBands(
  f: AtlasFlightView,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  minY: number,
  maxY: number,
) {
  const middle =
    ((x0 + x1) / 2 - f.eyeX) * f.forwardX +
    ((minY + maxY) / 2 - f.eyeY) * f.forwardY +
    ((z0 + z1) / 2 - f.eyeZ) * f.forwardZ;
  const radius =
    (Math.abs(f.forwardX) * (x1 - x0) +
      Math.abs(f.forwardY) * (maxY - minY) +
      Math.abs(f.forwardZ) * (z1 - z0)) /
    2;
  // Include boundary boxes on both sides despite CPU/GPU rounding.
  return (
    (middle - radius <= flightDepthSplit + 0.005 ? 1 : 0) |
    (middle + radius >= flightDepthSplit - 0.005 ? 2 : 0)
  );
}
function inCone(f: AtlasFlightView, dx: number, dz: number, radius: number, load: boolean) {
  const half = load ? f.halfLoad : f.halfDraw;
  if (half === Math.PI) return true;
  const forward = dx * f.sinYaw + dz * f.cosYaw;
  const side = Math.abs(dx * f.cosYaw - dz * f.sinYaw);
  return (
    forward * (load ? f.sinLoad : f.sinDraw) - side * (load ? f.cosLoad : f.cosDraw) >= -radius
  );
}

export function flightBounds(f: AtlasFlightView, edge: number, near: boolean): AtlasBounds {
  const radius = near ? Math.min(f.meshReach, f.horizon) : f.horizon;
  const halo = near ? f.turnMesh : Math.min(radius, f.turnSurface);
  let x0 = -halo,
    x1 = halo,
    z0 = -halo,
    z1 = halo;
  const expand = (x: number, z: number) => {
    x0 = Math.min(x0, x * radius);
    x1 = Math.max(x1, x * radius);
    z0 = Math.min(z0, z * radius);
    z1 = Math.max(z1, z * radius);
  };
  // Cardinal extrema inside the sector plus its two boundary rays give an
  // exact horizontal AABB irrespective of aspect ratio and yaw wrapping.
  for (const sign of [-1, 1]) {
    expand(
      f.sinYaw * f.cosLoad + sign * f.cosYaw * f.sinLoad,
      f.cosYaw * f.cosLoad - sign * f.sinYaw * f.sinLoad,
    );
    if (inCone(f, sign, 0, 0, true)) expand(sign, 0);
    if (inCone(f, 0, sign, 0, true)) expand(0, sign);
  }
  // The predicted movement is bounded to a short leading strip. A narrow
  // side-step therefore warms the next columns without surveying the whole face.
  const col = (v: number) =>
    Math.min(Math.ceil(edge / columnMetres) - 1, Math.max(0, Math.floor(v / columnMetres)));
  return {
    i0: col(f.eyeX + x0 + Math.min(0, f.leadX)),
    i1: col(f.eyeX + x1 + Math.max(0, f.leadX)),
    j0: col(f.eyeZ + z0 + Math.min(0, f.leadZ)),
    j1: col(f.eyeZ + z1 + Math.max(0, f.leadZ)),
  };
}

/** Native coverage may extend behind the drawable frustum. Keep that query footprint stable on turns. */
export function flightCoverageBounds(
  f: AtlasFlightView,
  edge: number,
  visible?: AtlasBounds,
  radius = Math.max(f.turnCoverage, f.horizon),
): AtlasBounds {
  const col = (m: number) =>
    Math.max(0, Math.min(Math.ceil(edge / columnMetres) - 1, Math.floor(m / columnMetres)));
  const i0 = col(f.eyeX - radius),
    i1 = col(f.eyeX + radius);
  const j0 = col(f.eyeZ - radius),
    j1 = col(f.eyeZ + radius);
  return visible
    ? {
        i0: Math.min(i0, visible.i0),
        i1: Math.max(i1, visible.i1),
        j0: Math.min(j0, visible.j0),
        j1: Math.max(j1, visible.j1),
      }
    : { i0, i1, j0, j1 };
}

// Radius is the box half-diagonal, so a parent can never exclude an intersecting child.
export function flightIntersects(
  f: AtlasFlightView,
  i: number,
  j: number,
  n: number,
  kind: 'load' | 'draw',
) {
  const size = columnMetres * n;
  const dx = i * columnMetres + size / 2 - f.eyeX;
  const dz = j * columnMetres + size / 2 - f.eyeZ;
  const s = size / 2;
  const distance = Math.hypot(Math.max(0, Math.abs(dx) - s), Math.max(0, Math.abs(dz) - s));
  if (kind === 'draw')
    return distance <= f.horizon && inCone(f, dx, dz, size * halfDiagonal, false);
  if (distance <= f.turnSurface) return true;
  if (distance <= f.horizon && inCone(f, dx, dz, size * halfDiagonal, true)) return true;
  const px = dx - f.leadX,
    pz = dz - f.leadZ;
  return (
    (f.leadX !== 0 || f.leadZ !== 0) &&
    Math.hypot(Math.max(0, Math.abs(px) - s), Math.max(0, Math.abs(pz) - s)) <= f.meshReach &&
    (Math.hypot(px, pz) <= f.turnMesh + size * halfDiagonal ||
      inCone(f, px, pz, size * halfDiagonal, true))
  );
}

type FlightDemand = { priority: number; meshLod: 1 | 2 | 4 | null; surfaceLod: number };
export function flightDemand(f: AtlasFlightView, i: number, j: number, n = 1): FlightDemand | null {
  const size = columnMetres * n;
  const dx = i * columnMetres + size / 2 - f.eyeX;
  const dz = j * columnMetres + size / 2 - f.eyeZ;
  const s = size / 2;
  const radius = size * halfDiagonal;
  const d = Math.hypot(Math.max(0, Math.abs(dx) - s), Math.max(0, Math.abs(dz) - s));
  const moving = f.leadX !== 0 || f.leadZ !== 0;
  const ahead = moving
    ? Math.hypot(Math.max(0, Math.abs(dx - f.leadX) - s), Math.max(0, Math.abs(dz - f.leadZ) - s))
    : d;
  const drawn = d <= f.horizon && inCone(f, dx, dz, radius, false);
  const padded = drawn || (d <= f.horizon && inCone(f, dx, dz, radius, true));
  const lead =
    moving &&
    ahead <= f.meshReach &&
    (ahead <= f.turnMesh || inCone(f, dx - f.leadX, dz - f.leadZ, radius, true));
  if (!padded && !lead && d > f.turnSurface) return null;
  const range = lead ? Math.min(d, ahead) : d;
  // A sample underneath the eye only describes nearby topography. Relax its
  // altitude bound with horizontal distance to avoid downgrading distant peaks.
  const farEdge = f.altitude > d ? Math.hypot(Math.abs(dx) + s, Math.abs(dz) + s) : d;
  const metresPerPixel = Math.hypot(range, Math.max(0, f.altitude - farEdge)) / f.focalPixels;
  const meshRange = padded || lead ? f.meshReach : f.turnMesh;
  let meshLod: FlightDemand['meshLod'] = null;
  if (range <= meshRange && metresPerPixel <= 1.7) {
    meshLod = metresPerPixel < 0.35 ? 1 : metresPerPixel < 0.85 ? 2 : 4;
    if (meshLod === 1 && !padded && !lead && range > f.turnMesh / 2) meshLod = 2;
  }
  const surfaceLod =
    !padded && !lead
      ? 6
      : Math.min(6, Math.max(3, Math.ceil(Math.log2(Math.max(1, metresPerPixel * 4) / 0.25))));
  const priority = range / columnMetres + (drawn ? 0 : padded ? 4 : lead ? 6 : 12);
  return { meshLod, surfaceLod, priority };
}
