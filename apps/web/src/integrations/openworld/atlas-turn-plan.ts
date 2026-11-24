import type { AtlasColumnIndex } from './atlas-column-index.js';
import { type AtlasFlightView, flightIntersects } from './atlas-flight-plan.js';
import type { AtlasBounds, AtlasRequest } from './atlas-types.js';

// Foreground priorities are camera distances in columns. Speculation uses one spare lane.
export const backgroundPriority = 2 ** 32;

/** A continuous intermediate surface all around the eye, then known terrain up to the horizon. */
export function prepareFlightCoverage(
  f: AtlasFlightView,
  index: AtlasColumnIndex,
  stride: number,
  survey: AtlasBounds | null,
  middle: AtlasBounds,
  horizon: AtlasBounds,
  add: (r: AtlasRequest, priority: number) => void,
  prepareRearMesh: (i: number, j: number) => void,
) {
  const cover = (extent: AtlasBounds, bounds: AtlasBounds, n: number, radius: number) => {
    const x0 = Math.floor(Math.max(extent.i0, bounds.i0) / n) * n;
    const z0 = Math.floor(Math.max(extent.j0, bounds.j0) / n) * n;
    const x1 = Math.min(extent.i1, bounds.i1),
      z1 = Math.min(extent.j1, bounds.j1);
    for (let j = z0; j <= z1; j += n)
      for (let i = x0; i <= x1; i += n) {
        const dx = (i + n / 2) * 16 - f.eyeX,
          dz = (j + n / 2) * 16 - f.eyeZ;
        const distance = Math.hypot(
          Math.max(0, Math.abs(dx) - n * 8),
          Math.max(0, Math.abs(dz) - n * 8),
        );
        if (distance > radius) continue;
        const visibleMiddle = distance <= f.turnCoverage && flightIntersects(f, i, j, n, 'draw');
        // Nearby exact voxels already have high-quality surface requests. Bridge the visible
        // middle before the distant skyline, and let all other bearings drain by distance.
        if (visibleMiddle && distance < f.meshReach * 0.6 && !survey && stride === 1) continue;
        const priority = visibleMiddle ? 5 + distance / 240 : backgroundPriority + distance / 16;
        add({ kind: 'surface', ci: i, cj: j, lod: 6, n }, priority);
      }
  };
  // A planet-sized extent is not evidence of visited columns. Discover only the local ring.
  if (survey) cover(survey, middle, 32, f.turnCoverage);
  // Extremely coarse buckets span thousands of unknown columns. Search those only locally.
  const indexedHorizon = stride <= 32;
  const extent = indexedHorizon ? horizon : middle;
  index.visit(extent, (block) => {
    const side = index.size;
    const blockExtent = {
      i0: block.i,
      j0: block.j,
      i1: block.i + side - 1,
      j1: block.j + side - 1,
    };
    const distance = Math.hypot(
      Math.max(0, Math.abs((block.i + side / 2) * 16 - f.eyeX) - side * 8),
      Math.max(0, Math.abs((block.j + side / 2) * 16 - f.eyeZ) - side * 8),
    );
    // A single distant native parent can cover multiple sampled cells. Preserve small native
    // requests for isolated precisely indexed outcrops and the latency-sensitive local band.
    const n = distance > f.turnCoverage && stride > 1 ? 32 : Math.min(32, block.farSize);
    cover(
      blockExtent,
      extent,
      n,
      indexedHorizon ? Math.max(f.turnCoverage, f.horizon) : f.turnCoverage,
    );
    if (stride === 1 && distance <= f.turnMesh * 2)
      for (const [i, j] of block.columns) prepareRearMesh(i, j);
  });
}
