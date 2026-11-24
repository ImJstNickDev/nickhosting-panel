import { maxOpenworldMapColumn } from '../../../../../games/openworld/src/world-map.js';
import type { MapPoint } from './map-checkpoints.js';

export type MapFace = {
  face: number;
  count: number;
  i0: number | null;
  j0: number | null;
  i1: number | null;
  j1: number | null;
};
export type Area = { x: number; z: number; span: number };
export type Bounds = { i0: number; j0: number; i1: number; j1: number };
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
export type Footprint = { columns: [number, number][] };
// Widely scattered columns can obscure the area where almost all the terrain is.
// Keep multiple inhabited areas together, and offer the full outline when a few
// isolated columns would dominate the initial frame.
export function populatedExtent(face: MapFace | undefined, cells: Footprint | undefined) {
  const points = cells?.columns;
  if (!face || !points || points.length < 100) return null;
  const centralRange = (axis: 0 | 1) => {
    const sorted = points.map((p) => p[axis]).sort((a, b) => a - b);
    const tail = Math.floor(sorted.length / 100);
    const lo = sorted[tail] ?? 0,
      hi = sorted[sorted.length - 1 - tail] ?? lo;
    const reach = 8 * Math.max(1, hi - lo + 1);
    return { lo: lo - reach, hi: hi + reach };
  };
  const xs = centralRange(0),
    zs = centralRange(1);
  const core = points.filter(([i, j]) => i >= xs.lo && i <= xs.hi && j >= zs.lo && j <= zs.hi);
  if (core.length === points.length || core.length < points.length * 0.99) return null;
  const ii = core.map((p) => p[0]),
    jj = core.map((p) => p[1]);
  return {
    ...face,
    i0: Math.min(...ii),
    i1: Math.max(...ii),
    j0: Math.min(...jj),
    j1: Math.max(...jj),
  };
}
export function fit(edge: number, b: MapFace | undefined, aspect: number, point?: MapPoint): Area {
  if (b?.i0 == null || b.j0 == null || b.i1 == null || b.j1 == null)
    return {
      x: point?.x ?? Math.min(edge, 256) / 2,
      z: point?.z ?? Math.min(edge, 256) / 2,
      span: Math.min(edge, 256),
    };
  return {
    x: (b.i0 + b.i1 + 1) * 8,
    z: (b.j0 + b.j1 + 1) * 8,
    span: clamp(
      1.25 * 16 * Math.max(6, b.i1 - b.i0 + 1, (b.j1 - b.j0 + 1) * aspect),
      32,
      edge * 1.25 * Math.max(1, aspect),
    ),
  };
}

// The server permits at most 32,768 buckets. Snap and pad first because a
// narrow camera straddling a grid boundary can otherwise round up over budget.
export function footprintWindow(bounds: Bounds) {
  const span = Math.max(bounds.i1 - bounds.i0 + 1, bounds.j1 - bounds.j0 + 1);
  let stride = 2 ** Math.max(0, Math.ceil(Math.log2(span / 96)));
  for (; ; stride *= 2) {
    const snap = 32 * stride;
    const low = (v: number) => Math.max(0, Math.floor(v / snap) * snap - snap);
    const high = (v: number) =>
      Math.min(maxOpenworldMapColumn, (Math.floor(v / snap) + 2) * snap - 1);
    const i0 = low(bounds.i0),
      j0 = low(bounds.j0),
      i1 = high(bounds.i1),
      j1 = high(bounds.j1);
    const width = Math.floor(i1 / stride) - Math.floor(i0 / stride) + 1;
    const height = Math.floor(j1 / stride) - Math.floor(j0 / stride) + 1;
    if (width * height <= 32768) return { stride, i0, i1, j0, j1 };
  }
}
