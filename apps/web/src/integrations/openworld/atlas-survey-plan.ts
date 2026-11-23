import { clamp } from './atlas-camera.js';
import { flightDemand } from './atlas-flight-plan.js';
import type { AtlasBounds, AtlasFrame } from './atlas-types.js';

/** Bounded discovery over native map extents without an exact column index. */
export function visitAtlasSurvey(
  view: AtlasFrame,
  extent: AtlasBounds,
  size: number,
  visit: (i: number, j: number, priority: number) => void,
  limit = 192,
) {
  const b = view.bounds;
  const x0 = Math.floor(Math.max(b.i0, extent.i0) / size),
    x1 = Math.floor(Math.min(b.i1, extent.i1) / size);
  const z0 = Math.floor(Math.max(b.j0, extent.j0) / size),
    z1 = Math.floor(Math.min(b.j1, extent.j1) / size);
  if (
    b.i0 > extent.i1 ||
    b.j0 > extent.j1 ||
    b.i1 < extent.i0 ||
    b.j1 < extent.j0 ||
    x1 < x0 ||
    z1 < z0
  )
    return 0;
  const f = view.flight;
  const cx = (f?.eyeX ?? view.x) / 16,
    cz = (f?.eyeZ ?? view.z) / 16;
  const xMid = clamp(Math.floor(cx / size), x0, x1),
    zMid = clamp(Math.floor(cz / size), z0, z1);
  let count = 0,
    examined = 0;
  const accept = (x: number, z: number) => {
    examined++;
    const i = x * size,
      j = z * size;
    const d = f && flightDemand(f, i, j, size);
    if (f && !d) return;
    visit(i, j, d ? d.priority + 1 : Math.hypot(i + size / 2 - cx, j + size / 2 - cz) * 0.12);
    count++;
  };
  if (f) {
    // Reserve a few samples at depth. Centre-out scans alone never reach a distant
    // occupied ridge when the visible extent is larger than the discovery budget.
    const depth = Math.min(f.horizon, Math.max(x1 - x0 + 1, z1 - z0 + 1) * size * 16);
    for (const fraction of [0.25, 0.55, 0.9])
      for (const angle of [-0.8, -0.4, 0, 0.4, 0.8]) {
        const side = Math.sin(angle * f.halfDraw),
          forward = Math.cos(angle * f.halfDraw);
        const distance = depth * fraction;
        const x = Math.floor(
          (f.eyeX + (forward * f.sinYaw + side * f.cosYaw) * distance) / 16 / size,
        );
        const z = Math.floor(
          (f.eyeZ + (forward * f.cosYaw - side * f.sinYaw) * distance) / 16 / size,
        );
        if (x >= x0 && x <= x1 && z >= z0 && z <= z1 && count < limit) accept(x, z);
      }
  }
  const maxRadius = Math.max(xMid - x0, x1 - xMid, zMid - z0, z1 - zMid);
  const remain = () => count < limit && examined < limit * 8;
  for (let r = 0; r <= maxRadius && remain(); r++) {
    // Clip the ring before iterating to keep thin, long extents linear.
    for (const z of r === 0 ? [zMid] : [zMid - r, zMid + r]) {
      if (z < z0 || z > z1) continue;
      for (let x = Math.max(x0, xMid - r); x <= Math.min(x1, xMid + r) && remain(); x++)
        accept(x, z);
    }
    for (const x of [xMid - r, xMid + r]) {
      if (x < x0 || x > x1) continue;
      for (let z = Math.max(z0, zMid - r + 1); z <= Math.min(z1, zMid + r - 1) && remain(); z++)
        accept(x, z);
    }
  }
  return count;
}
