import type { Terrain } from './atlas-geometry.js';
import type { Entry } from './atlas-stream.js';
import { backgroundPriority } from './atlas-turn-plan.js';
import type { AtlasBounds, AtlasRequest } from './atlas-types.js';

type Surface = Extract<AtlasRequest, { kind: 'surface' }>;
type Wanted = ReadonlyMap<string, { priority: number }>;
const MiB = 1024 * 1024;
const byteLimit = 96 * MiB;
const previewLimit = 24 * MiB;
const previewCount = 8192;
const detailCount = 1800;
// Keep the inspected centers of a short flight within the existing detail budget.
const inspectedBytesLimit = 12 * MiB;
const inspectedCount = 128;
const blockSide = 64; // All native tiles align to their size, at most 32 columns.
const surfaceKey = (i: number, j: number, n: number, lod: number) => `t/${i}/${j}/${n}/${lod}`;
export const requestKey = (r: AtlasRequest) =>
  r.kind === 'surface'
    ? surfaceKey(r.ci, r.cj, r.n, r.lod)
    : r.kind === 'mesh'
      ? `v/${r.i}/${r.j}/${r.lod}`
      : `s/${r.z}/${r.x}/${r.y}`;

export function terrainBytes(value: Terrain | null) {
  if (!value) return 0;
  if (value.kind === 'raster') return value.pixels.byteLength + (value.present?.byteLength ?? 0);
  return value.opaque.byteLength + value.blend.byteLength + value.materials.length * 8;
}

const isPreview = (r: AtlasRequest) => r.kind === 'surface' && r.lod >= 3;
const drawable = (e: Entry) =>
  e.value?.kind === 'raster'
    ? e.value.presentColumns !== 0
    : e.value?.kind === 'quads' && (e.value.opaque.length > 0 || e.value.blend.length > 0);

function intersects(r: Exclude<AtlasRequest, { kind: 'seed' }>, b: AtlasBounds) {
  if (r.kind === 'mesh') return r.i >= b.i0 && r.j >= b.j0 && r.i <= b.i1 && r.j <= b.j1;
  return r.ci <= b.i1 && r.cj <= b.j1 && r.ci + r.n > b.i0 && r.cj + r.n > b.j0;
}

type Block = { x: number; z: number; entries: Set<Entry> };

/** Native previews have an independent entry quota and reserved bytes within the shared budget. */
export class AtlasTerrainCache {
  private readonly entries = new Map<string, Entry>();
  private readonly previews = new Set<Entry>();
  private readonly details = new Set<Entry>();
  private readonly seeds = new Set<Entry>();
  private readonly inspected = new Set<Entry>();
  private inspectedBytes = 0;
  private focusI?: number;
  private focusJ?: number;
  private readonly blocks = new Map<string, Block>();
  // A tile width is itself a power of two, so widths 1, 2, 4, ... form a bit mask.
  private readonly widths = new Uint8Array(7);
  private readonly shapeCounts = new Uint32Array(7 * 6);
  private previewBytes = 0;
  bytes = 0;
  meshes = 0;
  surfaces = 0;

  get size() {
    return this.entries.size;
  }
  get needsTrim() {
    return (
      this.bytes > byteLimit ||
      this.previewBytes > previewLimit ||
      this.previews.size > previewCount ||
      this.details.size > detailCount
    );
  }
  get hasHeadroom() {
    return (
      this.bytes < byteLimit * 0.75 &&
      this.previewBytes < previewLimit * 0.75 &&
      this.previews.size < previewCount * 0.75 &&
      this.details.size < 1200
    );
  }
  get(key: string) {
    return this.entries.get(key);
  }
  values() {
    return this.entries.values();
  }
  coveringSurface(r: Surface) {
    return this.surfaceAt(r.ci, r.cj, r.lod, r.n);
  }
  surfaceAt(i: number, j: number, lod: number, minWidth: number, wanted?: Wanted) {
    let stale: Entry | undefined;
    for (let widths = (this.widths[lod] ?? 0) & ~(minWidth - 1); widths; widths &= widths - 1) {
      const n = widths & -widths;
      const e = this.entries.get(surfaceKey(Math.floor(i / n) * n, Math.floor(j / n) * n, n, lod));
      if (e && !e.stale) return e;
      if (e && wanted?.has(e.key)) stale ??= e;
    }
    return stale;
  }
  focusOn(ci?: number, cj?: number) {
    if (ci === this.focusI && cj === this.focusJ) return;
    this.focusI = ci;
    this.focusJ = cj;
    if (ci === undefined || cj === undefined) return;
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        const e = this.get(requestKey({ kind: 'mesh', i, j, lod: 1 }));
        if (e) this.remember(e);
      }
    }
  }
  private forget(e: Entry) {
    if (this.inspected.delete(e)) this.inspectedBytes -= e.bytes;
  }
  private remember(e: Entry) {
    if (e.stale || !drawable(e) || e.bytes > inspectedBytesLimit) return;
    this.forget(e);
    this.inspected.add(e);
    this.inspectedBytes += e.bytes;
    for (const oldest of this.inspected) {
      if (this.inspectedBytes <= inspectedBytesLimit && this.inspected.size <= inspectedCount)
        break;
      this.forget(oldest);
    }
  }
  markStale(e: Entry) {
    this.forget(e);
    e.stale = true;
  }
  invalidateColumn(i: number, j: number) {
    for (const lod of [1, 2, 4]) {
      const e = this.get(requestKey({ kind: 'mesh', i, j, lod }));
      if (e) this.markStale(e);
    }
    for (let lod = 0; lod < this.widths.length; lod++)
      for (let widths = this.widths[lod] ?? 0; widths; widths &= widths - 1) {
        const n = widths & -widths;
        const e = this.get(surfaceKey(Math.floor(i / n) * n, Math.floor(j / n) * n, n, lod));
        if (e) this.markStale(e);
      }
  }
  *inBounds(b: AtlasBounds) {
    yield* this.seeds;
    const x0 = Math.floor(b.i0 / blockSide),
      z0 = Math.floor(b.j0 / blockSide);
    const x1 = Math.floor(b.i1 / blockSide),
      z1 = Math.floor(b.j1 / blockSide);
    const blocks = this.blocks;
    function* candidates() {
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > blocks.size) {
        for (const block of blocks.values())
          if (block.x >= x0 && block.z >= z0 && block.x <= x1 && block.z <= z1) yield block;
      } else {
        for (let z = z0; z <= z1; z++)
          for (let x = x0; x <= x1; x++) {
            const block = blocks.get(`${x},${z}`);
            if (block) yield block;
          }
      }
    }
    for (const block of candidates())
      for (const e of block.entries)
        if (e.request.kind !== 'seed' && intersects(e.request, b)) yield e;
  }
  private track(e: Entry, add: boolean) {
    const r = e.request;
    const delta = add ? 1 : -1;
    this.bytes += delta * e.bytes;
    const preview = isPreview(r);
    if (preview) this.previewBytes += delta * e.bytes;
    const tier = preview ? this.previews : this.details;
    if (add) tier.add(e);
    else tier.delete(e);
    if (r.kind === 'seed') {
      if (add) this.seeds.add(e);
      else this.seeds.delete(e);
      return;
    }
    if (r.kind === 'surface') {
      if (e.value) this.surfaces += delta;
      const shape = r.lod * 6 + Math.log2(r.n);
      const count = (this.shapeCounts[shape] ?? 0) + delta;
      this.shapeCounts[shape] = count;
      const widths = this.widths[r.lod] ?? 0;
      this.widths[r.lod] = count ? widths | r.n : widths & ~r.n;
    } else if (e.value) this.meshes += delta;
    const x = Math.floor((r.kind === 'surface' ? r.ci : r.i) / blockSide);
    const z = Math.floor((r.kind === 'surface' ? r.cj : r.j) / blockSide);
    const key = `${x},${z}`;
    let block = this.blocks.get(key);
    if (add) {
      if (!block) {
        block = { x, z, entries: new Set() };
        this.blocks.set(key, block);
      }
      block.entries.add(e);
    } else if (block) {
      block.entries.delete(e);
      if (!block.entries.size) this.blocks.delete(key);
    }
  }
  delete(key: string) {
    const e = this.entries.get(key);
    if (e) {
      this.forget(e);
      this.track(e, false);
    }
    this.entries.delete(key);
  }
  store(e: Entry) {
    this.delete(e.key);
    this.entries.set(e.key, e);
    this.track(e, true);
    const r = e.request;
    if (
      r.kind === 'mesh' &&
      r.lod === 1 &&
      this.focusI !== undefined &&
      this.focusJ !== undefined &&
      Math.abs(r.i - this.focusI) <= 1 &&
      Math.abs(r.j - this.focusJ) <= 1
    )
      this.remember(e);
  }

  trim(
    wanted: Wanted,
    visible: ReadonlySet<Entry>,
    neighborhood: AtlasBounds | undefined,
    defer: (key: string, priority: number) => void,
  ) {
    const evict = (e: Entry, priority: number) => {
      this.delete(e.key);
      if (Number.isFinite(priority)) defer(e.key, priority);
    };
    const previewSizePressure = this.previewBytes > previewLimit;
    const previewCountPressure = this.previews.size > previewCount;
    if (previewSizePressure || previewCountPressure) {
      const candidates = [...this.previews].map((entry) => {
        const r = entry.request as Surface;
        const priority = wanted.get(entry.key)?.priority ?? Infinity;
        const local = neighborhood && intersects(r, neighborhood);
        // Keep actual surrounding ground, including the parent covering several child requests
        // and the other side of the camera. Preserve fresh evidence of holes in the active area.
        let rank = 0;
        if (!entry.stale) {
          if (drawable(entry)) rank = (local || visible.has(entry) ? 4 : 0) + (r.lod === 6 ? 3 : 2);
          else rank = local && Number.isFinite(priority) ? 2 : 1;
        }
        return { entry, priority, rank };
      });
      candidates.sort(
        (a, b) => a.rank - b.rank || a.entry.age - b.entry.age || b.priority - a.priority,
      );
      for (const { entry, priority } of candidates) {
        if (
          (!previewSizePressure || this.previewBytes <= previewLimit * 0.9) &&
          (!previewCountPressure || this.previews.size <= previewCount * 0.9)
        )
          break;
        evict(entry, priority);
      }
    }
    const countPressure = this.details.size > detailCount;
    const bytePressure = this.bytes > byteLimit;
    if (!countPressure && !bytePressure) return;
    const now = Date.now();
    let prepared = 0;
    let room = byteLimit / 6;
    const candidates = [...this.details]
      .map((entry) => ({ entry, priority: wanted.get(entry.key)?.priority ?? Infinity, rank: 0 }))
      .sort((a, b) => a.priority - b.priority);
    for (const c of candidates) {
      const { entry, priority } = c;
      if (entry.stale) continue;
      const active = Number.isFinite(priority);
      const warm = active && priority >= backgroundPriority;
      if (drawable(entry) && (visible.has(entry) || (active && !warm && priority < 12))) c.rank = 7;
      else if (this.inspected.has(entry)) c.rank = 6;
      else if (warm && drawable(entry) && entry.bytes <= room && prepared < 1024) {
        c.rank = 5;
        room -= entry.bytes;
        prepared++;
      } else if (drawable(entry) && entry.value?.kind === 'quads' && entry.age >= now - 15000)
        c.rank = 4;
      else if ((drawable(entry) && entry.age >= now - 2000) || (active && !warm)) c.rank = 3;
      else c.rank = warm ? 2 : 1;
    }
    candidates.sort(
      (a, b) => a.rank - b.rank || a.entry.age - b.entry.age || b.priority - a.priority,
    );
    for (const { entry, priority } of candidates) {
      if (
        (!countPressure || this.details.size <= 1600) &&
        (!bytePressure || this.bytes <= byteLimit * 0.9)
      )
        break;
      evict(entry, priority);
    }
  }
  clear() {
    this.entries.clear();
    this.previews.clear();
    this.details.clear();
    this.blocks.clear();
    this.seeds.clear();
    this.inspected.clear();
    this.inspectedBytes = 0;
    this.focusI = this.focusJ = undefined;
    this.widths.fill(0);
    this.shapeCounts.fill(0);
    this.bytes = this.previewBytes = this.meshes = this.surfaces = 0;
  }
}
