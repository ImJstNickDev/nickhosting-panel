import type { Raster } from './atlas-geometry.js';
import type { Entry } from './atlas-stream.js';

type Surface = { raster: Raster; step: number };
type Block = { i: number; j: number; owners: Uint16Array };
const blockSide = 32;

// Heights along a native column boundary lie on one grid line of both submitted
// triangle grids. Interpolate the coarser grid at the finer one's vertices.
function gridHeight(r: Raster, x: number, z: number) {
  const i = Math.floor((x - r.x) / r.mpp),
    j = Math.floor((z - r.z) / r.mpp);
  const at = (i: number, j: number) =>
    4 * (Math.max(0, Math.min(r.side - 1, j)) * r.side + Math.max(0, Math.min(r.side - 1, i)));
  let p = at(i, j);
  if (!r.pixels[p + 3]) {
    for (const n of [at(i - 1, j), at(i + 1, j), at(i, j - 1), at(i, j + 1)])
      if (r.pixels[n + 3]) {
        p = n;
        break;
      }
  }
  return r.pixels[p] ?? 0;
}

function edgeHeight(s: Surface, x: number, z: number, alongX: boolean) {
  const coordinate = alongX ? x - s.raster.x : z - s.raster.z;
  const fraction = coordinate % s.step;
  if (!fraction) return gridHeight(s.raster, x, z);
  const x0 = alongX ? x - fraction : x,
    z0 = alongX ? z : z - fraction;
  const a = gridHeight(s.raster, x0, z0);
  const b = gridHeight(s.raster, x0 + (alongX ? s.step : 0), z0 + (alongX ? 0 : s.step));
  return a + ((b - a) * fraction) / s.step;
}

/** Stitch only the common line of two recorded surfaces. Empty and voxel columns keep their own silhouettes. */
type SourceBlock = { i: number; j: number; id: string; rasters: Entry[]; meshes: Entry[] };
type Plan = { id: string; block: SourceBlock; east?: SourceBlock; south?: SourceBlock };
export type SeamPage = { data: Float32Array; originX: number; originZ: number };

function planPages(entries: Iterable<Entry>) {
  const blocks = new Map<string, SourceBlock>();
  for (const e of entries) {
    const q = e.request;
    if (e.stale || q.kind === 'seed') continue;
    const v = e.value;
    const mesh =
      q.kind === 'mesh' && v?.kind === 'quads' && (v.opaque.length > 0 || v.blend.length > 0);
    if (
      !mesh &&
      !(q.kind === 'surface' && v?.kind === 'raster' && v.present && v.presentColumns !== 0)
    )
      continue;
    const bi = Math.floor((q.kind === 'mesh' ? q.i : q.ci) / blockSide) * blockSide,
      bj = Math.floor((q.kind === 'mesh' ? q.j : q.cj) / blockSide) * blockSide;
    const key = `${bi},${bj}`;
    let block = blocks.get(key);
    if (!block) {
      block = { i: bi, j: bj, id: '', rasters: [], meshes: [] };
      blocks.set(key, block);
    }
    (mesh ? block.meshes : block.rasters).push(e);
  }
  for (const b of blocks.values()) {
    b.rasters.sort(
      (a, b) => (b.value as Raster).mpp - (a.value as Raster).mpp || a.serial - b.serial,
    );
    // Different mesh LODs at the same column suppress the same raster edge.
    const covered = new Set<number>();
    for (const e of b.meshes)
      if (e.request.kind === 'mesh')
        covered.add((e.request.j - b.j) * blockSide + e.request.i - b.i);
    b.id = `${b.rasters.map((e) => e.serial).join('.')}/${[...covered].sort((a, b) => a - b).join('.')}`;
  }
  const plans = new Map<string, Plan>();
  for (const [key, b] of blocks) {
    if (!b.rasters.length) continue;
    const east = blocks.get(`${b.i + blockSide},${b.j}`),
      south = blocks.get(`${b.i},${b.j + blockSide}`);
    const id = `${key}:${b.id}:${east?.id ?? ''}:${south?.id ?? ''}`;
    plans.set(id, { id, block: b, east, south });
  }
  return plans;
}

function* buildPage(plan: Plan): Generator<void, SeamPage> {
  const inputs = [plan.block, plan.east, plan.south].filter((b): b is SourceBlock => !!b);
  const rasters = inputs.flatMap((b) => b.rasters);
  const meshes = inputs.flatMap((b) => b.meshes);
  const blocks = new Map<string, Block>();
  const surfaces: Surface[] = [];
  const data: number[] = [];
  const originX = Math.floor(plan.block.i / 512) * 8192,
    originZ = Math.floor(plan.block.j / 512) * 8192;
  const key = (i: number, j: number) => `${i},${j}`;
  // Surface requests are power-of-two squares of up to 32 columns, aligned to their size.
  // Iterate from coarse to fine, mirroring the rank mask. Allocate only occupied spatial blocks.
  for (const e of rasters) {
    yield;
    const r = e.value,
      q = e.request;
    if (q.kind !== 'surface' || r?.kind !== 'raster' || !r.present || r.presentColumns === 0)
      continue;
    const bi = Math.floor(q.ci / blockSide) * blockSide,
      bj = Math.floor(q.cj / blockSide) * blockSide;
    const id = key(bi, bj);
    let block = blocks.get(id);
    if (!block) {
      block = { i: bi, j: bj, owners: new Uint16Array(blockSide * blockSide) };
      blocks.set(id, block);
    }
    const source = surfaces.push({
      raster: r,
      step: (r.side * r.mpp) / Math.min(128, Math.max(8, r.side)),
    });
    const start = (q.cj - bj) * blockSide + q.ci - bi;
    for (let j = 0; j < q.n; j++)
      for (let i = 0; i < q.n; i++) {
        if (r.present[j * q.n + i]) block.owners[start + j * blockSide + i] = source;
      }
  }
  for (const e of meshes) {
    const q = e.request;
    if (q.kind !== 'mesh') continue;
    const bi = Math.floor(q.i / blockSide) * blockSide,
      bj = Math.floor(q.j / blockSide) * blockSide;
    const block = blocks.get(key(bi, bj));
    if (block) block.owners[(q.j - bj) * blockSide + q.i - bi] = 0;
  }
  function seam(aId: number, bId: number, x: number, z: number, alongX: boolean) {
    if (!bId || aId === bId) return;
    const a = surfaces[aId - 1],
      b = surfaces[bId - 1];
    if (!a || !b) return;
    const step = Math.min(a.step, b.step);
    const dx = alongX ? step : 0,
      dz = alongX ? 0 : step;
    let a0 = edgeHeight(a, x, z, alongX),
      b0 = edgeHeight(b, x, z, alongX);
    for (let t = 0; t < 16; t += step, x += dx, z += dz) {
      const a1 = edgeHeight(a, x + dx, z + dz, alongX),
        b1 = edgeHeight(b, x + dx, z + dz, alongX);
      if (a0 !== b0 || a1 !== b1) {
        const emit = (from: number, to: number, h0: number, h1: number, h2: number, h3: number) => {
          const fromA = h0 + h2 >= h1 + h3;
          const r = fromA ? a.raster : b.raster;
          const mx = x + (dx * (from + to)) / 2 + (alongX ? 0 : fromA ? -0.125 : 0.125);
          const mz = z + (dz * (from + to)) / 2 + (alongX ? (fromA ? -0.125 : 0.125) : 0);
          const index =
            4 * (Math.floor((mz - r.z) / r.mpp) * r.side + Math.floor((mx - r.x) / r.mpp));
          data.push(
            x - originX + dx * from,
            z - originZ + dz * from,
            dx * (to - from),
            dz * (to - from),
            h0,
            h1,
            h2,
            h3,
            r.pixels[index + 1] ?? 0,
            r.pixels[index + 2] ?? 0,
          );
        };
        if ((a0 - b0) * (a1 - b1) < 0) {
          const cross = (a0 - b0) / (a0 - b0 + b1 - a1),
            h = a0 + (a1 - a0) * cross;
          emit(0, cross, a0, b0, h, h);
          emit(cross, 1, h, h, a1, b1);
        } else emit(0, 1, a0, b0, a1, b1);
      }
      a0 = a1;
      b0 = b1;
    }
  }
  for (const block of blocks.values()) {
    if (block.i !== plan.block.i || block.j !== plan.block.j) continue;
    const east = blocks.get(key(block.i + blockSide, block.j)),
      south = blocks.get(key(block.i, block.j + blockSide));
    for (let k = 0; k < block.owners.length; k++) {
      if ((k & 3) === 0) yield;
      const a = block.owners[k];
      if (!a) continue;
      const i = k % blockSide,
        j = Math.floor(k / blockSide);
      const x = (block.i + i) * 16,
        z = (block.j + j) * 16;
      const b = i + 1 < blockSide ? block.owners[k + 1] : east?.owners[j * blockSide];
      const c = j + 1 < blockSide ? block.owners[k + blockSide] : south?.owners[i];
      if (b && b !== a) seam(a, b, x + 16, z, false);
      if (c && c !== a) seam(a, c, x, z + 16, true);
    }
  }
  return { data: new Float32Array(data), originX, originZ };
}

// The native rasters already live in the decode cache. Build a bounded slice directly from
// those arrays instead of cloning an entire world into another worker. A page survives
// camera turns while its input revisions and neighboring coverage still match.
export class AtlasSeamCache {
  private visible = new Map<string, Plan>();
  private warm = new Map<string, Plan>();
  private pending = new Map<string, Generator<void, SeamPage>>();
  private results = new Map<string, SeamPage>();
  private bytes = 0;

  setVisible(entries: Iterable<Entry>) {
    this.visible = planPages(entries);
    this.discardCold();
  }
  setResident(entries: Iterable<Entry>) {
    this.warm = planPages(entries);
    this.discardCold();
  }
  private discardCold() {
    if (this.bytes < 12 * 1024 * 1024 && this.results.size < 1024) return;
    for (const [id, page] of this.results)
      if (!this.visible.has(id) && !this.warm.has(id)) {
        this.results.delete(id);
        this.bytes -= page.data.byteLength;
      }
  }
  advance(milliseconds: number) {
    const deadline = performance.now() + milliseconds;
    for (const id of this.pending.keys())
      if (!this.visible.has(id) && !this.warm.has(id)) this.pending.delete(id);
    for (const plans of [this.visible, this.warm])
      for (const [id, plan] of plans) {
        if (this.results.has(id)) continue;
        if (plans === this.warm && (this.bytes > 12 * 1024 * 1024 || this.results.size >= 1024))
          return false;
        let task = this.pending.get(id);
        if (!task) {
          task = buildPage(plan);
          this.pending.set(id, task);
        }
        let step: IteratorResult<void, SeamPage>;
        do {
          if (performance.now() >= deadline) return true;
          step = task.next();
        } while (!step.done);
        this.pending.delete(id);
        this.results.set(id, step.value);
        this.bytes += step.value.data.byteLength;
        if (this.bytes > 16 * 1024 * 1024 || this.results.size > 1536) {
          for (const [k, page] of this.results) {
            if (this.visible.has(k)) continue;
            this.results.delete(k);
            this.bytes -= page.data.byteLength;

            if (this.bytes <= 12 * 1024 * 1024 && this.results.size <= 1024) break;
          }
        }
      }
    return false;
  }
  visiblePages() {
    const result: SeamPage[] = [];
    for (const id of this.visible.keys()) {
      const page = this.results.get(id);
      if (page?.data.length) result.push(page);
    }
    return result;
  }
  destroy() {
    this.results.clear();
    this.pending.clear();
    this.visible.clear();
    this.warm.clear();
    this.bytes = 0;
  }
}
