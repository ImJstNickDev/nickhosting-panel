import type { OpenworldMapDebugTerrain } from '../../../../../games/openworld/src/map-debug.js';
import { AtlasBackoff, AtlasTileRetries } from './atlas-backoff.js';
import { clamp } from './atlas-camera.js';
import { AtlasColumnIndex } from './atlas-column-index.js';
import { flightCoverageBounds, flightDemand, flightIntersects } from './atlas-flight-plan.js';
import { sampleRaster, type Terrain } from './atlas-geometry.js';
import { usesVoxelSprite } from './atlas-materials.js';
import { visitAtlasSurvey } from './atlas-survey-plan.js';
import { backgroundPriority, prepareFlightCoverage } from './atlas-turn-plan.js';
import type {
  AtlasBounds,
  AtlasFrame,
  AtlasMaterial,
  AtlasMode,
  AtlasOptions,
  AtlasPoint,
  AtlasRequest,
} from './atlas-types.js';

export type Entry = {
  key: string;
  request: AtlasRequest;
  value: Terrain | null;
  age: number;
  bytes: number;
  stale: boolean;
  serial: number;
};
type MeshBatch = { count: number; delivered: boolean };
type Task = { key: string; request: AtlasRequest; priority: number };
export const requestKey = (r: AtlasRequest) =>
  r.kind === 'surface'
    ? `t/${r.ci}/${r.cj}/${r.n}/${r.lod}`
    : r.kind === 'mesh'
      ? `v/${r.i}/${r.j}/${r.lod}`
      : `s/${r.z}/${r.x}/${r.y}`;
// A cold native surface request may have to read every column in the block.
const chunkCount = [2, 2, 4, 4, 8, 8, 8] as const;
const cacheBudget = 96 * 1024 * 1024;
const recentMeshMs = 15000;
const warmMeshLimit = 192;
const contains = (b: AtlasBounds, i: number, j: number) =>
  i >= b.i0 && i <= b.i1 && j >= b.j0 && j <= b.j1;

export class AtlasStream {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<
    string,
    { abort: AbortController; request: AtlasRequest; batch?: MeshBatch; received?: boolean }
  >();
  private primaryBatch?: MeshBatch;
  private readonly failedPreparation = new Map<string, { attempts: number; retryAt: number }>();
  private prepareAfter = 0;
  // A single small first delivery may finish while the camera prioritizes another patch.
  private returningBatch?: MeshBatch;
  private firstMeshGroup = true;
  private get batchActive() {
    return Boolean(this.primaryBatch);
  }
  private readonly workers = new Map<
    number,
    { key: string; resolve: (value: Terrain) => void; reject: (error: unknown) => void }
  >();
  private readonly evictedPriority = new Map<string, number>();
  private readonly tileRetries: AtlasTileRetries;
  private readonly splitSurfaces = new Set<string>();
  private readonly smallestSurface: number[] = [...chunkCount];
  private readonly worker: Worker;
  private spriteIds = new Set<number>();
  private wanted = new Map<string, Task>();
  private queue = new Set<Task>();
  // Coverage, scale and intersecting column boundaries govern the requested set.
  // Newly decoded columns usually change visibility alone.
  private previousPlan: { view: AtlasFrame; mode: AtlasMode } | null = null;
  private presented: { view: AtlasFrame; mode: AtlasMode; generation: number } | null = null;
  private viewedGeneration = -1;
  private serial = 0;
  private totalBytes = 0;
  private disposed = false;
  private paused = false;
  private readonly backoff: Record<'seed' | 'live', AtlasBackoff>;
  columns: readonly (readonly [number, number])[] = [];
  stride = 1;
  coverageReady = false;
  audited: AtlasBounds | null = null;
  private survey: AtlasBounds | null = null;
  private readonly seedFootprints = new Map<string, boolean>();
  private columnIndex = new AtlasColumnIndex();
  private coverageSet = new Set<string>();
  seed = false;
  seedEdge: number;
  maxSeedZoom = 15;
  generation = 0;
  visible: Entry[] = [];
  constructor(
    private readonly options: AtlasOptions,
    private readonly changed: () => void,
  ) {
    const backoff = () =>
      new AtlasBackoff(
        () => this.pump(),
        (e) => options.onError?.(e),
      );
    this.backoff = { live: backoff(), seed: backoff() };
    this.tileRetries = new AtlasTileRetries(() => this.pump(), options.onTerrainStatus);
    this.seedEdge = options.edge;
    this.worker = new Worker(new URL('./atlas-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({
      data,
    }: {
      data: { id: number; terrain?: Terrain; error?: boolean };
    }) => {
      const job = this.workers.get(data.id);
      if (!job) return;
      this.workers.delete(data.id);
      if (data.terrain) job.resolve(data.terrain);
      else job.reject(new Error('Invalid Openworld terrain response'));
    };
    this.worker.onerror = () => {
      const error = new Error('Openworld terrain worker failed');
      for (const job of this.workers.values()) job.reject(error);
      this.workers.clear();
      if (!this.disposed) this.options.onUnavailable?.();
    };
  }
  setPalette(materials: readonly AtlasMaterial[]) {
    const next = new Set(materials.filter(usesVoxelSprite).map((m) => m.id));
    const old = this.spriteIds;
    if (old.size === next.size && [...old].every((id) => next.has(id))) return;
    this.spriteIds = next;
    // The palette may arrive after the first meshes or change on refresh.
    for (const entry of this.cache.values()) {
      if (
        entry.value?.kind === 'quads' &&
        entry.value.materials.some((id) => old.has(id) !== next.has(id))
      )
        entry.stale = true;
    }
    this.previousPlan = null;
    this.generation++;
    this.changed();
  }
  setCoverage(
    columns: readonly (readonly [number, number])[],
    stride: number,
    audited?: AtlasBounds | null,
  ) {
    this.previousPlan = null;
    this.seedFootprints.clear();
    this.audited = audited ?? null;
    this.coverageReady = true;
    this.columns = columns;
    this.stride = Math.max(1, stride);
    this.columnIndex = new AtlasColumnIndex(columns, this.stride);
    this.coverageSet = new Set(columns.map(([i, j]) => `${i},${j}`));
    this.generation++;
  }
  setSurvey(bounds: AtlasBounds | null) {
    this.previousPlan = null;
    this.survey = bounds;
    this.generation++;
  }
  get surveyBounds() {
    return this.survey;
  }
  listed(i: number, j: number) {
    const s = this.stride;
    return this.coverageSet.has(`${Math.floor(i / s) * s},${Math.floor(j / s) * s}`);
  }
  indexed(i: number, j: number) {
    return this.stride === 1 && this.listed(i, j);
  }
  forEachColumn(bounds: AtlasBounds, visit: (i: number, j: number) => void) {
    this.columnIndex.visit(bounds, ({ columns }) => {
      for (const [i, j] of columns) {
        if (
          i <= bounds.i1 &&
          j <= bounds.j1 &&
          i + this.stride > bounds.i0 &&
          j + this.stride > bounds.j0
        )
          visit(i, j);
      }
    });
  }
  private surfaceAt(i: number, j: number, lod: number) {
    // Wide surveys can use larger previews. Keep them available while zooming in.
    const size = chunkCount[lod] ?? 8;
    const largest = lod === 6 ? 32 : size;
    let stale: Entry | undefined;
    for (let n = this.smallestSurface[lod] ?? size; n <= largest; n *= 2) {
      const entry = this.cache.get(
        requestKey({
          kind: 'surface',
          ci: Math.floor(i / n) * n,
          cj: Math.floor(j / n) * n,
          n,
          lod,
        }),
      );
      if (entry && !entry.stale) return entry;
      if (entry && this.wanted.has(entry.key)) stale ??= entry;
    }
    return stale;
  }
  private hasDrawnSurface(i: number, j: number) {
    for (let lod = 6; lod >= 0; lod--) {
      const e = this.surfaceAt(i, j, lod);
      if (e?.request.kind !== 'surface' || e.value?.kind !== 'raster' || e.stale) continue;
      const r = e.request;
      if (e.value.present?.[(j - r.cj) * r.n + i - r.ci]) return true;
    }
    return false;
  }
  seedAllowed(i: number, j: number) {
    if (!this.seed || (this.audited && !contains(this.audited, i, j))) return false;
    if (this.stride === 1 && this.listed(i, j)) return false;
    if ((this.survey && contains(this.survey, i, j)) || this.listed(i, j)) {
      // A sampled index reports an occupied bucket; only a real surface can prove an interior hole.
      for (let lod = 0; lod <= 6; lod++) {
        const entry = this.surfaceAt(i, j, lod);
        if (!entry || entry.stale || entry.request.kind !== 'surface') continue;
        const r = entry.request;
        if (entry.value === null) return true;
        if (entry.value.kind === 'raster' && entry.value.present)
          return !entry.value.present[(j - r.cj) * r.n + i - r.ci];
      }
      return false;
    }
    return this.coverageReady || Boolean(this.survey);
  }
  setPaused(paused: boolean) {
    this.paused = paused;
    this.backoff.live.pause(paused);
    this.backoff.seed.pause(paused);
    if (paused) {
      this.tileRetries.wakeAt(Infinity);
      for (const job of this.pending.values()) job.abort.abort();
    } else this.pump();
  }
  needsSeed(bounds: AtlasBounds, x: number, y: number, tileMetres: number) {
    const i0 = Math.max(bounds.i0, Math.floor((x * tileMetres) / 16));
    const j0 = Math.max(bounds.j0, Math.floor((y * tileMetres) / 16));
    const i1 = Math.min(bounds.i1, Math.ceil(((x + 1) * tileMetres) / 16) - 1);
    const j1 = Math.min(bounds.j1, Math.ceil(((y + 1) * tileMetres) / 16) - 1);
    if (i0 > i1 || j0 > j1) return false;
    if (this.stride !== 1 || (i1 - i0 + 1) * (j1 - j0 + 1) > this.coverageSet.size) return true;
    const key = [i0, j0, i1, j1].join('/');
    const cached = this.seedFootprints.get(key);
    if (cached !== undefined) return cached;
    let gap = false;
    for (let j = j0; !gap && j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!this.coverageSet.has(`${i},${j}`)) {
          gap = true;
          break;
        }
      }
    }
    if (this.seedFootprints.size >= 1024) this.seedFootprints.clear();
    this.seedFootprints.set(key, gap);
    return gap;
  }
  setSeed(enabled: boolean, edge: number, zoom: number) {
    this.previousPlan = null;
    this.seed = enabled;
    this.seedEdge = edge;
    this.maxSeedZoom = zoom;
    if (!enabled) {
      for (const [key, entry] of this.cache) if (entry.request.kind === 'seed') this.remove(key);
      for (const job of this.pending.values()) if (job.request.kind === 'seed') job.abort.abort();
      this.visible = this.visible.filter((e) => e.request.kind !== 'seed');
    }
    this.generation++;
  }
  invalidate(cells: readonly (readonly [number, number])[] | null) {
    this.previousPlan = null;
    const keys = cells ? new Set(cells.map(([i, j]) => `${i},${j}`)) : null;
    const affected = (r: AtlasRequest) => {
      if (r.kind === 'seed') return false;
      if (!keys || !cells) return true;
      if (r.kind === 'mesh') return keys.has(`${r.i},${r.j}`);
      if (cells.length < r.n * r.n)
        return cells.some(([i, j]) => i >= r.ci && j >= r.cj && i < r.ci + r.n && j < r.cj + r.n);
      for (let j = r.cj; j < r.cj + r.n; j++)
        for (let i = r.ci; i < r.ci + r.n; i++) if (keys.has(`${i},${j}`)) return true;
      return false;
    };
    for (const key of this.failedPreparation.keys()) {
      const task = this.wanted.get(key);
      if (task && affected(task.request)) this.failedPreparation.delete(key);
    }
    this.tileRetries.invalidate((key) => {
      const task = this.wanted.get(key);
      return !!task && affected(task.request);
    });
    for (const key of this.evictedPriority.keys()) {
      const task = this.wanted.get(key);
      if (task && affected(task.request)) this.evictedPriority.delete(key);
    }
    for (const entry of this.cache.values()) if (affected(entry.request)) entry.stale = true;
    for (const job of this.pending.values()) if (affected(job.request)) job.abort.abort();
    this.generation++;
  }
  retry() {
    this.previousPlan = null;
    this.evictedPriority.clear();
    this.failedPreparation.clear();
    this.prepareAfter = 0;
    this.tileRetries.reset();
    this.backoff.live.reset();
    this.backoff.seed.reset();
    this.generation++;
  }
  private remove(key: string) {
    const entry = this.cache.get(key);
    if (entry) this.totalBytes -= entry.bytes;
    this.cache.delete(key);
  }
  update(view: AtlasFrame, mode: AtlasMode) {
    const previous = this.previousPlan;
    const viewChanged = !previous || previous.mode !== mode || !sameDemandView(previous.view, view);
    if (this.evictedPriority.size && this.totalBytes < cacheBudget * 0.75 && this.cache.size < 1200)
      this.evictedPriority.clear();
    if (!viewChanged && this.viewedGeneration === this.generation) return;
    if (viewChanged) {
      this.plan(view, mode);
      this.previousPlan = { view, mode };
      this.presented = null;
    }
    this.viewedGeneration = this.generation;
    this.present(view, mode);
    this.pump();
  }

  private plan(view: AtlasFrame, mode: AtlasMode) {
    const b = view.bounds,
      cx = view.x / 16,
      cz = view.z / 16,
      mpp = view.span / view.width;
    const wanted = new Map<string, Task>();
    const f = view.flight;
    const turnBounds = f && flightCoverageBounds(f, this.options.edge, undefined, f.turnCoverage);
    const planBounds = f ? flightCoverageBounds(f, this.options.edge, b) : b;
    const add = (request: AtlasRequest, priority: number) => {
      const key = requestKey(request),
        existing = wanted.get(key);
      if (!existing || existing.priority > priority) wanted.set(key, { key, request, priority });
    };
    const dist = (i: number, j: number) => Math.hypot(i - cx, j - cz);
    const rasterMpp = mode === 'plan' ? mpp : mpp * 4;
    const lod = clamp(Math.round(Math.log2(Math.max(0.25, rasterMpp) / 0.25)), 0, 6);
    const spanColumns = Math.max(b.i1 - b.i0 + 1, b.j1 - b.j0 + 1);
    const surveySize = spanColumns <= 96 ? 8 : spanColumns <= 192 ? 16 : 32;
    const previewSize = this.survey
      ? surveySize
      : Math.min(32, Math.max(chunkCount[6], this.stride));
    const tileSize = (level: number) => (level === 6 ? previewSize : (chunkCount[level] ?? 8));
    const terrain = (i: number, j: number, level: number, priority: number) => {
      const n = tileSize(level);
      add(
        { kind: 'surface', ci: Math.floor(i / n) * n, cj: Math.floor(j / n) * n, n, lod: level },
        priority,
      );
    };
    const discover = (i: number, j: number, n: number, priority: number) => {
      // Produce a close native presence map promptly before targeting individual mesh columns.
      // A 32-column-wide native read can otherwise hold back all 1,024 underlying cells.
      if (view.flight && n > 8 && flightDemand(view.flight, i, j, n)?.meshLod != null) {
        for (let z = j; z < j + n; z += 8)
          for (let x = i; x < i + n; x += 8) {
            const demand = flightDemand(view.flight, x, z, 8);
            if (demand) add({ kind: 'surface', ci: x, cj: z, n: 8, lod: 6 }, demand.priority + 1);
          }
      } else add({ kind: 'surface', ci: i, cj: j, n, lod: 6 }, priority);
    };
    const warmMeshes = new Map<string, { i: number; j: number; lod: number; distance: number }>();
    let lastWarmDistance = Infinity;
    const rememberMesh = (i: number, j: number, lod: number, distance: number) => {
      if (distance >= lastWarmDistance) return;
      warmMeshes.set(`${i},${j}`, { i, j, lod, distance });
      if (warmMeshes.size >= warmMeshLimit * 2) {
        const sorted = [...warmMeshes.entries()].sort((a, b) => a[1].distance - b[1].distance);
        for (const [key] of sorted.slice(warmMeshLimit)) warmMeshes.delete(key);
        lastWarmDistance = sorted[warmMeshLimit - 1]?.[1].distance ?? Infinity;
      }
    };
    const prepareRearMesh = (i: number, j: number) => {
      if (!f) return;
      const dx = (i + 0.5) * 16 - f.eyeX,
        dz = (j + 0.5) * 16 - f.eyeZ;
      const distance = Math.hypot(dx, dz);
      if (distance > f.turnMesh * 2 || flightDemand(f, i, j)?.meshLod != null) return;
      const pixel = Math.hypot(distance, f.altitude) / f.focalPixels;
      if (pixel <= 0.85) rememberMesh(i, j, pixel < 0.35 ? 1 : 2, distance);
    };
    const mesh = (i: number, j: number, d: number) => {
      if (mode === 'plan') return false;
      // A merged quarter-metre voxel seen at less than one pixel needs coarser geometry.
      const pixel = mode === 'iso' ? mpp : Math.max(mpp * 0.2, mpp * (0.3 + (d * 16) / view.span));
      if (pixel > 1.7) return false;
      const stride = pixel < 0.35 ? 1 : pixel < 0.85 ? 2 : 4;
      const target = { kind: 'mesh', i, j, lod: stride } as const;
      const finer =
        stride > 1 ? this.cache.get(requestKey({ ...target, lod: stride / 2 })) : undefined;
      add(finer?.value?.kind === 'quads' && !finer.stale ? finer.request : target, d + 1);
      return true;
    };
    const consider = (i: number, j: number, s: number) => {
      if (i > b.i1 || i + s <= b.i0 || j > b.j1 || j + s <= b.j0) return;
      if (view.flight) {
        const load = flightDemand(view.flight, i, j, s);
        if (!load) return;
        if (s === 1 && load.meshLod !== null) {
          const r = { kind: 'mesh', i, j, lod: load.meshLod } as const;
          const finer =
            r.lod > 1 ? this.cache.get(requestKey({ ...r, lod: r.lod / 2 })) : undefined;
          // An adjacent finer LOD already resident at a boundary needs no coarser download.
          // Looking down from altitude, the closest columns can sit below the
          // eye and outside the picture. Include the focal column in the first delivery.
          const atFocus = view.flight.pitch > 0.15 && i === Math.floor(cx) && j === Math.floor(cz);
          add(
            finer?.value?.kind === 'quads' && !finer.stale ? finer.request : r,
            atFocus ? -1 : load.priority,
          );
        }
        if (s === 1 || s <= tileSize(load.surfaceLod))
          terrain(i, j, load.surfaceLod, load.priority + 2);
        if (s > 1) {
          const n = Math.min(32, Math.max(8, s));
          discover(Math.floor(i / n) * n, Math.floor(j / n) * n, n, load.priority + 1);
        }
        return;
      }
      const d = dist(i, j);
      // Keep a preview visible until the finer terrain arrives.
      terrain(i, j, 6, d * 0.12);
      if (view.detailBounds && !contains(view.detailBounds, i, j)) {
        // Screen-space terrain for the distant skyline with true native height and materials.
        const level = clamp(
          Math.ceil(Math.log2(Math.max(mpp * 4, ((d * 16) / view.width) * 4) / 0.25)),
          3,
          6,
        );
        if (s <= tileSize(level)) terrain(i, j, level, d + 4);
        return;
      }
      if (s === 1) {
        const hasVoxelDetail = mesh(i, j, d);
        terrain(i, j, hasVoxelDetail ? Math.max(4, lod) : lod, d + 2);
      } else {
        const n = tileSize(lod);
        if (s <= n) terrain(i, j, lod, d + 2);
      }
    };
    const wideBuckets: { i: number; j: number; priority: number }[] = [];
    this.columnIndex.visit(b, (block) => {
      if (view.flight) {
        const n = this.columnIndex.size;
        const demand = flightDemand(view.flight, block.i, block.j, n);
        if (!demand) return;
        if (this.stride > 32) {
          wideBuckets.push({ i: block.i, j: block.j, priority: demand.priority });
          return;
        }
        if (this.stride === 1 && demand.meshLod === null && n <= tileSize(demand.surfaceLod)) {
          // Wide native previews pay off for contiguous distant terrain. Disjoint
          // settlements sharing the same skyline keep their small native footprint.
          if (demand.surfaceLod === 6 && block.farSize > n) {
            const w = block.farSize;
            add(
              {
                kind: 'surface',
                ci: Math.floor(block.i / w) * w,
                cj: Math.floor(block.j / w) * w,
                n: w,
                lod: 6,
              },
              demand.priority + 2,
            );
          } else terrain(block.i, block.j, demand.surfaceLod, demand.priority + 2);
          return;
        }
      }
      for (const [i, j] of block.columns) consider(i, j, this.stride);
    });
    if (wideBuckets.length) {
      // A sampled bucket may contain live columns in any of its quadrants.
      // Visit its overlapping native tiles, closest occupied buckets first on planetary views.
      const n = this.stride;
      let budget = 2048;
      for (const { i, j } of wideBuckets.sort((a, b) => a.priority - b.priority)) {
        if (budget <= 0) break;
        budget -= visitAtlasSurvey(
          view,
          { i0: i, j0: j, i1: i + n - 1, j1: j + n - 1 },
          32,
          (x, z, priority) => discover(x, z, 32, priority),
          Math.min(192, budget),
        );
      }
    }
    if (this.survey)
      visitAtlasSurvey(view, this.survey, previewSize, (i, j, priority) => {
        discover(i, j, previewSize, priority);
      });
    if (f && turnBounds)
      prepareFlightCoverage(
        f,
        this.columnIndex,
        this.stride,
        this.survey,
        turnBounds,
        planBounds,
        add,
        prepareRearMesh,
      );
    // Measured availability supplies exact column locations after a coarse survey/bucket response.
    if (this.survey || this.stride > 1) {
      for (const entry of this.cache.values()) {
        const r = entry.request,
          v = entry.value;
        if (
          r.kind !== 'surface' ||
          r.lod !== 6 ||
          v?.kind !== 'raster' ||
          !v.present ||
          !intersects(entry, planBounds, view, this.seedEdge)
        )
          continue;
        const f = view.flight;
        if (f) {
          const block = flightDemand(f, r.ci, r.cj, r.n);
          const withinRearMesh =
            Math.abs((r.ci + r.n / 2) * 16 - f.eyeX) <= f.turnMesh * 2 + r.n * 8 &&
            Math.abs((r.cj + r.n / 2) * 16 - f.eyeZ) <= f.turnMesh * 2 + r.n * 8;
          if ((!block || (block.meshLod === null && block.surfaceLod === 6)) && !withinRearMesh)
            continue;
        }
        for (let k = 0; k < v.present.length; k++)
          if (v.present[k]) {
            const i = r.ci + (k % r.n),
              j = r.cj + Math.floor(k / r.n);
            consider(i, j, 1);
            if (f) prepareRearMesh(i, j);
          }
      }
    }
    if (mode === 'plan' && lod <= 3) {
      // Prepare only columns actually delivered at the inspected resolution. This also works
      // without an exact index and never guesses voxel content from a sampled bucket.
      for (const e of this.cache.values()) {
        const r = e.request,
          v = e.value;
        if (
          r.kind !== 'surface' ||
          r.lod !== lod ||
          e.stale ||
          !wanted.has(e.key) ||
          v?.kind !== 'raster' ||
          !v.present
        )
          continue;
        for (let k = 0; k < v.present.length; k++) {
          const i = r.ci + (k % r.n),
            j = r.cj + Math.floor(k / r.n);
          if (
            v.present[k] &&
            contains(b, i, j) &&
            (!this.coverageReady || this.stride > 1 || !!this.survey || this.indexed(i, j))
          )
            rememberMesh(i, j, lod <= 1 ? 1 : 2, dist(i + 0.5, j + 0.5) * 16);
        }
      }
    }
    for (const { i, j, lod: target, distance } of [...warmMeshes.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, warmMeshLimit)) {
      const r = { kind: 'mesh', i, j, lod: target } as const;
      const finer = target > 1 ? this.cache.get(requestKey({ ...r, lod: 1 })) : undefined;
      add(
        finer?.value?.kind === 'quads' && !finer.stale ? finer.request : r,
        backgroundPriority + distance / 16,
      );
    }
    if (this.seed && (this.coverageReady || this.survey)) {
      const near = view.detailBounds ?? b;
      const zoom = clamp(
        Math.round(Math.log2(this.seedEdge / (256 * Math.max(mpp, 0.25)))),
        0,
        this.maxSeedZoom,
      );
      const schedule = (bounds: AtlasBounds, z: number) => {
        const side = this.seedEdge / 2 ** z,
          max = 2 ** z - 1;
        for (
          let j = clamp(Math.floor((bounds.j0 * 16) / side), 0, max);
          j <= clamp(Math.floor(((bounds.j1 + 1) * 16) / side), 0, max);
          j++
        ) {
          for (
            let i = clamp(Math.floor((bounds.i0 * 16) / side), 0, max);
            i <= clamp(Math.floor(((bounds.i1 + 1) * 16) / side), 0, max);
            i++
          ) {
            const demand =
              view.flight && flightDemand(view.flight, (i * side) / 16, (j * side) / 16, side / 16);
            if (view.flight && !demand) continue;
            if (!this.needsSeed(bounds, i, j, side)) continue;
            add(
              { kind: 'seed', x: i, y: j, z },
              demand ? demand.priority + 3 : dist(((i + 0.5) * side) / 16, ((j + 0.5) * side) / 16),
            );
          }
        }
      };
      schedule(near, zoom);
      if (b.i0 !== near.i0 || b.i1 !== near.i1 || b.j0 !== near.j0 || b.j1 !== near.j1) {
        const width = Math.max(b.i1 - b.i0 + 1, b.j1 - b.j0 + 1) * 16;
        schedule(b, clamp(Math.floor(Math.log2(this.seedEdge / (width / 4))), 0, zoom));
      }
    }
    // Keep the same LOD when a slow square must be read in smaller pieces.
    // A split replaces one request with at most four visible children.
    if (this.splitSurfaces.size) {
      const visibleSplits = new Set<string>();
      for (const [key, task] of wanted) {
        const r = task.request;
        if (r.kind !== 'surface' || !this.splitSurfaces.has(key)) continue;
        wanted.delete(key);
        visibleSplits.add(key);
        const n = r.n / 2;
        for (const ci of [r.ci, r.ci + n]) {
          for (const cj of [r.cj, r.cj + n]) {
            if (
              ci > planBounds.i1 ||
              cj > planBounds.j1 ||
              ci + n <= planBounds.i0 ||
              cj + n <= planBounds.j0
            )
              continue;
            add({ ...r, n, ci, cj }, task.priority + 0.001 * dist(ci + n / 2, cj + n / 2));
          }
        }
      }
      for (const key of this.splitSurfaces)
        if (!visibleSplits.has(key)) this.splitSurfaces.delete(key);
    }
    if (view.flight) prioritizeSkyline(view.flight, wanted);
    this.wanted = wanted;
    this.tileRetries.retain(wanted);
    for (const key of this.failedPreparation.keys())
      if ((wanted.get(key)?.priority ?? 0) < backgroundPriority) this.failedPreparation.delete(key);
    for (const [key, priority] of this.evictedPriority) {
      const task = wanted.get(key);
      // If a former skyline tile enters the foreground, it is immediately eligible again.
      const offset = priority >= backgroundPriority ? backgroundPriority : 0;
      if (!task || task.priority - offset + 1 < (priority - offset) * 0.85)
        this.evictedPriority.delete(key);
    }
    this.queue = new Set(
      [...wanted.values()]
        .filter((task) => {
          const entry = this.cache.get(task.key);
          return !entry || entry.stale;
        })
        .sort((a, b) => a.priority - b.priority),
    );
    const keepBatches = new Set<MeshBatch>();
    const foregroundBatches = new Set<MeshBatch>();
    for (const [key, job] of this.pending) {
      if (!job.batch || job.abort.signal.aborted) continue;
      const task = wanted.get(key);
      if (task) {
        keepBatches.add(job.batch);
        if (task.priority < backgroundPriority) foregroundBatches.add(job.batch);
      }
    }
    const batch = this.primaryBatch;
    if (batch && !foregroundBatches.has(batch) && mode === 'fly') {
      // A small in-flight prefix can finish without occupying the new direction's foreground lane.
      if (!this.returningBatch && (batch.count <= 3 || batch.delivered)) {
        this.returningBatch = batch;
        this.primaryBatch = undefined;
      }
    }
    let retainedSurface = false;
    for (const [key, job] of this.pending) {
      if (wanted.has(key) || job.received || job.abort.signal.aborted) continue;
      const r = job.request;
      if (
        !retainedSurface &&
        turnBounds &&
        r.kind === 'surface' &&
        r.ci <= turnBounds.i1 &&
        r.ci + r.n > turnBounds.i0 &&
        r.cj <= turnBounds.j1 &&
        r.cj + r.n > turnBounds.j0
      ) {
        retainedSurface = true;
        continue;
      }
      if (
        job.batch &&
        (job.batch.delivered || keepBatches.has(job.batch) || job.batch === this.returningBatch)
      )
        continue;
      job.abort.abort();
    }
    if (
      mode === 'fly' &&
      (!batch || !foregroundBatches.has(batch)) &&
      !this.visible.some((e) => e.request.kind === 'mesh' && wanted.has(e.key))
    )
      this.firstMeshGroup = true;
  }

  /** Select already decoded geometry on movement even between network planning ticks. */
  present(view: AtlasFrame, mode: AtlasMode) {
    const last = this.presented;
    if (
      last &&
      last.generation === this.generation &&
      last.mode === mode &&
      sameDemandView(last.view, view)
    )
      return;
    this.presented = { view, mode, generation: this.generation };
    const b = view.bounds;
    const wanted = this.wanted;
    const now = Date.now();
    const visible: Entry[] = [];
    const meshes = new Map<string, { entry: Entry; cost: number }>();
    for (const e of this.cache.values()) {
      if (
        (e.stale && !wanted.has(e.key)) ||
        (!e.value && (e.request.kind !== 'surface' || !this.seed)) ||
        !intersects(e, b, view, this.seedEdge)
      )
        continue;
      if (view.flight) {
        const req = e.request;
        const n =
          req.kind === 'mesh'
            ? 1
            : req.kind === 'surface'
              ? req.n
              : this.seedEdge / 2 ** req.z / 16;
        const i = req.kind === 'mesh' ? req.i : req.kind === 'surface' ? req.ci : req.x * n;
        const j = req.kind === 'mesh' ? req.j : req.kind === 'surface' ? req.cj : req.y * n;
        // The GPU clips the exact 3D box each frame. A one-degree guard covers the
        // presentation threshold so a turn never reveals a tile before the next selection.
        const pad =
          0.15 +
          0.02 *
            Math.max(
              Math.abs(i + n / 2 - view.flight.eyeX / 16),
              Math.abs(j + n / 2 - view.flight.eyeZ / 16),
            );
        if (!flightIntersects(view.flight, i - pad, j - pad, n + 2 * pad, 'draw')) continue;
        if (req.kind === 'mesh') {
          if (
            this.coverageReady &&
            this.stride === 1 &&
            !this.survey &&
            (!this.audited || contains(this.audited, i, j)) &&
            !this.listed(i, j)
          )
            continue;
          const meshLod = flightDemand(view.flight, i, j)?.meshLod;
          // Crossing from voxels to a distant surface mustn't open a hole while that
          // surface is still travelling. Release the fallback when a live sample exists.
          if (meshLod == null && this.hasDrawnSurface(i, j)) continue;
          const desired = meshLod ?? 4;
          const key = `${i},${j}`;
          // Prefer the screen-space target. While it streams, preserve the closest
          // resident LOD and break ties in favour of the finer one.
          const cost =
            Math.max(desired / req.lod, req.lod / desired) + (req.lod > desired ? 0.1 : 0);
          if (cost < (meshes.get(key)?.cost ?? Infinity)) meshes.set(key, { entry: e, cost });
          continue;
        }
      } else if (e.request.kind === 'mesh' && (mode === 'plan' || !wanted.has(e.key))) {
        // Keep a resident voxel LOD while a replacement is being streamed.
        const r = e.request;
        if (mode === 'plan' || ![1, 2, 4].some((l) => wanted.has(requestKey({ ...r, lod: l }))))
          continue;
      }
      if (e.request.kind === 'seed' && !this.seed) continue;
      e.age = now;
      visible.push(e);
    }
    for (const { entry } of meshes.values()) {
      entry.age = now;
      visible.push(entry);
    }
    if (visible.length !== this.visible.length || visible.some((e, i) => e !== this.visible[i])) {
      this.visible = visible;
    }
  }
  residentTerrain() {
    return this.cache.values();
  }
  getDebugTerrain(): Omit<OpenworldMapDebugTerrain, 'visibleMeshes' | 'visibleSurfaces'> {
    const f = this.presented?.view.flight;
    const counts = {
      queued: 0,
      pending: this.pending.size,
      residentBytes: this.totalBytes,
      residentMeshes: 0,
      residentSurfaces: 0,
      middleWanted: 0,
      middleReady: 0,
      middlePresentColumns: 0,
      behindWanted: 0,
      behindReady: 0,
      behindPresentColumns: 0,
    };
    for (const task of this.queue)
      if (
        !this.pending.has(task.key) &&
        !this.evictedPriority.has(task.key) &&
        this.failedPreparation.get(task.key)?.retryAt !== Infinity
      )
        counts.queued++;
    for (const e of this.cache.values()) {
      if (e.value?.kind === 'quads') counts.residentMeshes++;
      if (e.value?.kind === 'raster' && e.request.kind === 'surface') counts.residentSurfaces++;
    }
    if (f) {
      const readyParents = { middle: new Set<string>(), behind: new Set<string>() };
      // A surveyed parent and its smaller discovery squares can overlap. Count each
      // footprint once per sector, using the largest fresh native response available.
      const previews = [...this.wanted.values()]
        .flatMap((task) =>
          task.request.kind === 'surface' && task.request.lod === 6
            ? [{ r: task.request, key: task.key }]
            : [],
        )
        .sort((a, b) => b.r.n - a.r.n);
      for (const { r, key } of previews) {
        const dx = (r.ci + r.n / 2) * 16 - f.eyeX,
          dz = (r.cj + r.n / 2) * 16 - f.eyeZ;
        const d = Math.hypot(dx, dz);
        if (d > Math.max(f.turnCoverage, f.horizon) + r.n * 8 * Math.SQRT2) continue;
        const entry = this.cache.get(key);
        const record = (sector: 'middle' | 'behind') => {
          counts[`${sector}Wanted`]++;
          if (!entry || entry.stale) return;
          counts[`${sector}Ready`]++;
          for (let n = r.n * 2; n <= 32; n *= 2)
            if (
              readyParents[sector].has(
                requestKey({ ...r, n, ci: Math.floor(r.ci / n) * n, cj: Math.floor(r.cj / n) * n }),
              )
            )
              return;
          readyParents[sector].add(key);
          if (entry.value?.kind === 'raster')
            counts[`${sector}PresentColumns`] += entry.value.presentColumns ?? 0;
        };
        if (d >= f.meshReach * 0.6 && d <= f.turnCoverage + r.n * 8 * Math.SQRT2) record('middle');
        if (dx * f.sinYaw + dz * f.cosYaw < 0) record('behind');
      }
    }
    return counts;
  }
  private eligible(task: Task) {
    if (
      this.pending.has(task.key) ||
      (this.failedPreparation.get(task.key)?.retryAt ?? 0) > Date.now() ||
      this.backoff[task.request.kind === 'seed' ? 'seed' : 'live'].blocked
    )
      return false;
    const cached = this.cache.get(task.key);
    return (!cached || cached.stale) && !this.evictedPriority.has(task.key);
  }
  private pump() {
    if (this.disposed || this.paused) return;
    const pending = [...this.pending.values()];
    const now = Date.now();
    let wakeAt = Infinity;
    let liveBusy = pending.some((job) => job.request.kind !== 'seed');
    let seedBusy = pending.some((job) => job.request.kind === 'seed');
    let warming = [...this.pending.keys()].some(
      (key) => (this.wanted.get(key)?.priority ?? 0) >= backgroundPriority,
    );
    let slots =
      6 -
      pending.filter((job) => !job.batch).length -
      Number(this.batchActive) -
      Number(!!this.returningBatch);
    for (const task of this.queue) {
      if (slots <= 0) break;
      const background = task.priority >= backgroundPriority;
      // One small speculative operation leaves the other lanes available immediately on a turn.
      if (background && (warming || this.tileRetries.probing)) break;
      if (background && this.prepareAfter > now) {
        wakeAt = Math.min(wakeAt, this.prepareAfter);
        break;
      }
      const retryAt = this.failedPreparation.get(task.key)?.retryAt;
      if (retryAt !== undefined && retryAt > now) {
        wakeAt = Math.min(wakeAt, retryAt);
        continue;
      }
      if ((task.request.kind === 'seed' && seedBusy) || !this.eligible(task)) continue;
      if (task.request.kind !== 'seed') {
        if (this.tileRetries.probing && liveBusy) continue;
        const at = this.tileRetries.readyAt(task.key);
        if (at > now) {
          wakeAt = Math.min(wakeAt, at);
          continue;
        }
      }
      if (
        this.options.loadMeshes &&
        task.request.kind === 'mesh' &&
        !this.tileRetries.probing &&
        !this.tileRetries.has(task.key)
      ) {
        if (this.batchActive) continue;
        this.startBatch(task.request.lod, this.options.loadMeshes, background);
      } else {
        const abort = new AbortController();
        this.pending.set(task.key, { abort, request: task.request });
        if (task.request.kind === 'seed') seedBusy = true;
        void this.load(task, abort);
      }
      if (background) warming = true;
      if (task.request.kind !== 'seed') liveBusy = true;
      slots--;
    }
    this.tileRetries.wakeAt(wakeAt);
  }
  private startBatch(
    lod: number,
    loader: NonNullable<AtlasOptions['loadMeshes']>,
    background: boolean,
  ) {
    const abortBatch = new AbortController();
    const batch: MeshBatch = { count: 0, delivered: false };
    const limit = background
      ? 2
      : this.previousPlan?.mode === 'fly' && this.firstMeshGroup
        ? 3
        : 16;
    this.firstMeshGroup = false;
    const requests: Extract<AtlasRequest, { kind: 'mesh' }>[] = [];
    const jobs: { task: Task; abort: AbortController }[] = [];
    for (const task of this.queue) {
      const r = task.request;
      if (
        r.kind !== 'mesh' ||
        r.lod !== lod ||
        task.priority >= backgroundPriority !== background ||
        this.tileRetries.has(task.key) ||
        !this.eligible(task)
      )
        continue;
      const abort = new AbortController();
      this.pending.set(task.key, { abort, request: r, batch });
      requests.push(r);
      jobs.push({ task, abort });
      if (jobs.length === limit) break;
    }
    const cancel = () => {
      if (jobs.every((job) => job.abort.signal.aborted)) abortBatch.abort();
    };
    for (const { abort } of jobs) abort.signal.addEventListener('abort', cancel, { once: true });
    batch.count = requests.length;
    this.primaryBatch = batch;
    const response = Promise.resolve()
      .then(() => loader(requests, abortBatch.signal))
      .then((results) => {
        if (results.length !== requests.length) throw new Error('Incomplete Openworld mesh batch');
        batch.delivered = true;
        return results;
      });
    void Promise.all(
      jobs.map(({ task, abort }, index) =>
        this.load(
          task,
          abort,
          response.then((all) => all[index] ?? null),
        ),
      ),
    ).finally(() => {
      if (this.primaryBatch === batch) this.primaryBatch = undefined;
      if (this.returningBatch === batch) this.returningBatch = undefined;
      for (const job of jobs) job.abort.signal.removeEventListener('abort', cancel);
      this.pump();
    });
  }
  private async load(task: Task, abort: AbortController, batched?: Promise<ArrayBuffer | null>) {
    try {
      const bytes = await (batched ?? this.options.load(task.request, abort.signal));
      if (this.disposed || abort.signal.aborted) return;
      const job = this.pending.get(task.key);
      if (job) job.received = true;
      const spriteIds = this.spriteIds;
      const value = bytes
        ? await new Promise<Terrain>((resolve, reject) => {
            const id = ++this.serial;
            this.workers.set(id, { key: task.key, resolve, reject });
            this.worker.postMessage(
              {
                id,
                request: task.request,
                face: this.options.face,
                spriteIds: task.request.kind === 'mesh' ? spriteIds : undefined,
                bytes,
              },
              [bytes],
            );
          })
        : null;
      if (this.disposed || abort.signal.aborted) return;
      if (
        value?.kind === 'quads' &&
        spriteIds !== this.spriteIds &&
        value.materials.some((id) => spriteIds.has(id) !== this.spriteIds.has(id))
      )
        return;
      this.remove(task.key);
      this.failedPreparation.delete(task.key);
      if (task.request.kind !== 'seed') this.tileRetries.succeed(task.key);
      const size =
        value?.kind === 'raster'
          ? value.pixels.byteLength
          : value?.kind === 'quads'
            ? value.opaque.byteLength + value.blend.byteLength
            : 0;
      const planned = this.previousPlan,
        r = task.request;
      if (
        planned &&
        r.kind === 'surface' &&
        value?.kind === 'raster' &&
        (value.presentColumns ?? value.present?.some(Boolean)) &&
        this.wanted.has(task.key)
      ) {
        if (r.lod === 6 && (this.stride > 1 || this.survey)) {
          const flight = planned.view.flight;
          const demand = flight && flightDemand(flight, r.ci, r.cj, r.n);
          const local =
            flight &&
            Math.hypot((r.ci + r.n / 2) * 16 - flight.eyeX, (r.cj + r.n / 2) * 16 - flight.eyeZ) <=
              flight.turnMesh * 2 + r.n * 8 * Math.SQRT2;
          // A distant all-around preview is already at its final resolution. Replanning
          // the whole footprint on each such arrival needlessly stalls a stationary camera.
          if (!flight || local || (demand && demand.surfaceLod < 6) || demand?.meshLod != null)
            this.previousPlan = null;
        } else if (planned.mode === 'plan' && r.lod <= 3) this.previousPlan = null;
      }
      this.totalBytes += size;
      this.cache.set(task.key, {
        ...task,
        value,
        bytes: size,
        age: task.request.kind === 'mesh' && !this.wanted.has(task.key) ? Date.now() : 0,
        stale: false,
        serial: ++this.serial,
      });
      if (this.cache.size > 1800 || this.totalBytes > cacheBudget) {
        const now = Date.now();
        const visible = new Set(this.visible);
        // Reserve up to one sixth of RAM for current turn/switch preparation. Otherwise a
        // full cache of recently flown, now-distant voxels can evict every new rear column
        // as it arrives. Foreground still wins when its visible set needs the whole budget.
        let prepared = 0;
        let room = cacheBudget / 6;
        const candidates = [...this.cache.values()]
          .map((entry) => ({
            entry,
            priority: this.wanted.get(entry.key)?.priority ?? Infinity,
            rank: 0,
          }))
          .sort((a, b) => a.priority - b.priority);
        for (const candidate of candidates) {
          const { entry, priority } = candidate;
          if (entry.stale) continue;
          const active = Number.isFinite(priority);
          const warm = active && priority >= backgroundPriority;
          const drawable =
            entry.value?.kind === 'raster'
              ? entry.value.presentColumns !== 0
              : entry.value?.kind === 'quads' &&
                (entry.value.opaque.length > 0 || entry.value.blend.length > 0);
          if (drawable && (visible.has(entry) || (active && !warm && priority < 12))) {
            // A still-drawn fallback may have a different key from the finer replacement.
            candidate.rank = 6;
          } else if (warm && drawable && entry.bytes <= room && prepared < 1024) {
            candidate.rank = 5;
            room -= entry.bytes;
            prepared++;
          } else if (drawable && entry.value?.kind === 'quads' && entry.age >= now - recentMeshMs)
            candidate.rank = 4;
          else if ((drawable && entry.age >= now - 2000) || (active && !warm)) candidate.rank = 3;
          else candidate.rank = warm ? 2 : 1;
        }
        candidates.sort(
          (a, b) => a.rank - b.rank || a.entry.age - b.entry.age || b.priority - a.priority,
        );
        for (const { entry: c, priority } of candidates) {
          if (this.cache.size <= 1600 && this.totalBytes <= cacheBudget * 0.9) break;
          this.remove(c.key);
          this.previousPlan = null;
          // Defer eviction victims in a scene that exceeds memory capacity.
          if (Number.isFinite(priority)) this.evictedPriority.set(c.key, priority);
        }
      }
      const queued = this.wanted.get(task.key);
      if (queued) this.queue.delete(queued);
      this.generation++;
      this.changed();
    } catch (e) {
      if (!this.disposed && !abort.signal.aborted && this.wanted.has(task.key)) {
        const status = typeof e === 'object' && e !== null && 'status' in e ? e.status : null;
        if (
          (this.wanted.get(task.key)?.priority ?? 0) >= backgroundPriority &&
          (status === 503 || status === 504)
        ) {
          // A speculative miss must not throttle the newly visible ground on the next turn.
          const now = Date.now();
          const attempts = (this.failedPreparation.get(task.key)?.attempts ?? 0) + 1;
          const delay = [5000, 15000][attempts - 1];
          this.failedPreparation.set(task.key, {
            attempts,
            retryAt: delay === undefined ? Infinity : now + delay,
          });
          this.prepareAfter = now + 5000;
        } else if (task.request.kind !== 'seed' && (status === 503 || status === 504)) {
          const r = task.request;
          const previouslyFailed = this.tileRetries.has(task.key);
          this.tileRetries.fail(task.key);
          if (
            status === 504 &&
            r.kind === 'surface' &&
            r.n > 1 &&
            previouslyFailed &&
            this.splitSurfaces.size < 24
          ) {
            this.splitSurfaces.add(task.key);
            this.smallestSurface[r.lod] = Math.min(this.smallestSurface[r.lod] ?? r.n, r.n / 2);
            this.previousPlan = null;
            this.generation++;
            this.changed();
          }
        } else {
          const family = task.request.kind === 'seed' ? 'seed' : 'live';
          this.backoff[family].fail(e);
        }
      }
    } finally {
      this.pending.delete(task.key);
      if (!this.disposed) this.pump();
    }
  }
  sample(x: number, z: number, voxel: number): AtlasPoint {
    const i = Math.floor(x / 16),
      j = Math.floor(z / 16);
    for (let lod = 0; lod <= 6; lod++) {
      const entry = this.surfaceAt(i, j, lod);
      if (!entry || (entry.stale && !this.wanted.has(entry.key))) continue;
      const v = entry.value;
      if (v?.kind !== 'raster') continue;
      const hit = sampleRaster(v, x, z, voxel);
      if (hit) return { x, z, ...hit, source: 'live' };
    }
    if (this.seedAllowed(i, j)) {
      for (let level = this.maxSeedZoom; level >= 0; level--) {
        const size = this.seedEdge / 2 ** level;
        const v = this.cache.get(
          requestKey({ kind: 'seed', z: level, x: Math.floor(x / size), y: Math.floor(z / size) }),
        )?.value;
        if (v?.kind !== 'raster') continue;
        const hit = sampleRaster(v, x, z, voxel);
        if (hit) return { x, z, ...hit, source: 'seed' };
      }
    }
    return { x, z, source: this.indexed(i, j) ? 'indexed' : 'unknown' };
  }
  destroy() {
    this.disposed = true;
    this.backoff.live.reset();
    this.backoff.seed.reset();
    for (const job of this.pending.values()) job.abort.abort();
    for (const job of this.workers.values()) job.reject(new DOMException('Aborted', 'AbortError'));
    this.workers.clear();
    this.worker.terminate();
    this.cache.clear();
    this.visible = [];
    this.queue.clear();
    this.evictedPriority.clear();
    this.failedPreparation.clear();
    this.prepareAfter = 0;
    this.tileRetries.reset();
  }
}
/** Keep a few genuinely distant viewshed samples progressing alongside the nearest ground. */
function prioritizeSkyline(f: NonNullable<AtlasFrame['flight']>, wanted: Map<string, Task>) {
  const skyline = new Map<number, { task: Task; distance: number }>();
  for (const task of wanted.values()) {
    const r = task.request;
    if (r.kind !== 'surface' || r.lod < 4) continue;
    const dx = (r.ci + r.n / 2) * 16 - f.eyeX,
      dz = (r.cj + r.n / 2) * 16 - f.eyeZ;
    const forward = dx * f.sinYaw + dz * f.cosYaw;
    if (forward < Math.max(512, f.meshReach)) continue;
    const side = dx * f.cosYaw - dz * f.sinYaw;
    const angle = Math.atan2(side, forward);
    if (Math.abs(angle) > f.halfDraw) continue;
    const sector = Math.min(7, Math.floor((angle / f.halfDraw + 1) * 4));
    const key = sector + (forward > f.horizon * 0.5 ? 8 : 0);
    const current = skyline.get(key);
    if (!current || current.distance < forward) skyline.set(key, { task, distance: forward });
  }
  for (const { task, distance } of skyline.values())
    task.priority = Math.min(task.priority, 8 + Math.min(4, (distance / f.horizon) * 4));
}
function sameDemandView(a: AtlasFrame, b: AtlasFrame) {
  if (a.span !== b.span || a.width !== b.width || a.height !== b.height) return false;
  if (a.flight && b.flight) {
    // Spatial/angle padding covers these sub-pixel planner movements. Compare to the last
    // processed frame, so a slow pan or turn eventually crosses the threshold.
    return (
      Math.abs(a.flight.eyeX - b.flight.eyeX) < 2 &&
      Math.abs(a.flight.eyeZ - b.flight.eyeZ) < 2 &&
      Math.abs(a.flight.eyeY - b.flight.eyeY) < 2 &&
      Math.abs(a.flight.pitch - b.flight.pitch) < 0.015 &&
      Math.abs(a.flight.altitude - b.flight.altitude) < 3 &&
      Math.abs(a.flight.leadX - b.flight.leadX) < 8 &&
      Math.abs(a.flight.leadZ - b.flight.leadZ) < 8 &&
      a.flight.sinYaw * b.flight.sinYaw + a.flight.cosYaw * b.flight.cosYaw > 0.99988
    );
  }
  return (
    a.yaw === b.yaw &&
    Math.floor(a.x / 16) === Math.floor(b.x / 16) &&
    Math.floor(a.z / 16) === Math.floor(b.z / 16) &&
    sameBounds(a.bounds, b.bounds) &&
    sameBounds(a.detailBounds, b.detailBounds)
  );
}
function sameBounds(a: AtlasBounds | undefined, b: AtlasBounds | undefined) {
  return (
    a === b || (!!a && !!b && a.i0 === b.i0 && a.i1 === b.i1 && a.j0 === b.j0 && a.j1 === b.j1)
  );
}
function intersects(e: Entry, b: AtlasBounds, view: AtlasFrame, edge: number) {
  const r = e.request;
  if (r.kind === 'mesh') return contains(b, r.i, r.j);
  if (r.kind === 'surface')
    return r.ci <= b.i1 && r.ci + r.n > b.i0 && r.cj <= b.j1 && r.cj + r.n > b.j0;
  const size = edge / 2 ** r.z;
  return (
    r.x * size <= (b.i1 + 1) * 16 &&
    (r.x + 1) * size > b.i0 * 16 &&
    r.y * size <= (b.j1 + 1) * 16 &&
    (r.y + 1) * size > b.j0 * 16 &&
    view.span > 0
  );
}
