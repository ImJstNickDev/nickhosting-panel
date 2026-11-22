import { expect, it } from 'vitest';
import { footprintWindow } from './map-framing.js';

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
