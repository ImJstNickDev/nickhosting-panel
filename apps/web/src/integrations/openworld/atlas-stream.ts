import { AtlasBackoff, AtlasTileRetries } from './atlas-backoff.js';
import { clamp } from './atlas-camera.js';
import { sampleRaster, type Terrain } from './atlas-geometry.js';
import type {
  AtlasBounds,
  AtlasFrame,
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
const contains = (b: AtlasBounds, i: number, j: number) =>
  i >= b.i0 && i <= b.i1 && j >= b.j0 && j <= b.j1;

export class AtlasStream {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<
    string,
    { abort: AbortController; request: AtlasRequest; batch?: boolean }
  >();
  private batchActive = false;
  private readonly workers = new Map<
    number,
    { key: string; resolve: (value: Terrain) => void; reject: (error: unknown) => void }
  >();
  private readonly evictedUntil = new Map<string, number>();
  private readonly tileRetries: AtlasTileRetries;
  private readonly splitSurfaces = new Set<string>();
  private readonly smallestSurface: number[] = [...chunkCount];
  private readonly worker: Worker;
  private wanted = new Map<string, Task>();
  private queue: Task[] = [];
  // Coverage, scale and intersecting column boundaries govern the requested set.
  // Newly decoded columns usually change visibility alone.
  private previousPlan: { view: AtlasFrame; mode: AtlasMode } | null = null;
  private viewedGeneration = -1;
  private serial = 0;
  private age = 0;
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
    this.tileRetries.invalidate((key) => {
      const task = this.wanted.get(key);
      return !!task && affected(task.request);
    });
    for (const entry of this.cache.values()) if (affected(entry.request)) entry.stale = true;
    for (const job of this.pending.values()) if (affected(job.request)) job.abort.abort();
    this.generation++;
  }
  retry() {
    this.previousPlan = null;
    this.evictedUntil.clear();
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
    const viewChanged =
      !previous ||
      previous.mode !== mode ||
      previous.view.span !== view.span ||
      previous.view.width !== view.width ||
      !sameBounds(previous.view.bounds, view.bounds) ||
      !sameBounds(previous.view.detailBounds, view.detailBounds) ||
      (mode === 'fly'
        ? previous.view.x !== view.x || previous.view.z !== view.z
        : Math.floor(previous.view.x / 16) !== Math.floor(view.x / 16) ||
          Math.floor(previous.view.z / 16) !== Math.floor(view.z / 16));
    if (!viewChanged && this.viewedGeneration === this.generation) return;
    if (viewChanged) {
      this.plan(view, mode);
      this.previousPlan = { view, mode };
    }
    this.viewedGeneration = this.generation;
    this.updateVisible(view, mode);
    this.pump();
  }

  private plan(view: AtlasFrame, mode: AtlasMode) {
    const b = view.bounds,
      cx = view.x / 16,
      cz = view.z / 16,
      mpp = view.span / view.width;
    const wanted = new Map<string, Task>();
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
    const mesh = (i: number, j: number, d: number) => {
      if (mode === 'plan') return false;
      // A merged quarter-metre voxel seen at less than one pixel needs coarser geometry.
      const pixel = mode === 'iso' ? mpp : Math.max(mpp * 0.2, mpp * (0.3 + (d * 16) / view.span));
      if (pixel > 1.7) return false;
      const stride = pixel < 0.35 ? 1 : pixel < 0.85 ? 2 : 4;
      add({ kind: 'mesh', i, j, lod: stride }, d + 1);
      return true;
    };
    const consider = (i: number, j: number, s: number) => {
      if (i > b.i1 || i + s <= b.i0 || j > b.j1 || j + s <= b.j0) return;
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
    for (const [i, j] of this.columns) consider(i, j, this.stride);
    if (this.survey) {
      const si0 = Math.max(b.i0, this.survey.i0),
        sj0 = Math.max(b.j0, this.survey.j0),
        si1 = Math.min(b.i1, this.survey.i1),
        sj1 = Math.min(b.j1, this.survey.j1);
      if (si0 <= si1 && sj0 <= sj1) {
        // Bounded, centre-out exploration if the native face exceeds its safe enumeration limit.
        const baseI = clamp(
            Math.floor(cx / previewSize),
            Math.floor(si0 / previewSize),
            Math.floor(si1 / previewSize),
          ),
          baseJ = clamp(
            Math.floor(cz / previewSize),
            Math.floor(sj0 / previewSize),
            Math.floor(sj1 / previewSize),
          );
        let visited = 0;
        const rMax = Math.max(
          baseI - Math.floor(si0 / previewSize),
          Math.floor(si1 / previewSize) - baseI,
          baseJ - Math.floor(sj0 / previewSize),
          Math.floor(sj1 / previewSize) - baseJ,
        );
        const minI = Math.floor(si0 / previewSize) - baseI,
          maxI = Math.floor(si1 / previewSize) - baseI;
        const minJ = Math.floor(sj0 / previewSize) - baseJ,
          maxJ = Math.floor(sj1 / previewSize) - baseJ;
        const visit = (di: number, dj: number) => {
          const i = (baseI + di) * previewSize,
            j = (baseJ + dj) * previewSize;
          terrain(i, j, 6, dist(i + previewSize / 2, j + previewSize / 2) * 0.12);
          visited++;
        };
        for (let r = 0; r <= rMax && visited < 192; r++) {
          // Intersect the ring edges before scanning. A long one-column extent stays linear.
          for (const j of r === 0 ? [0] : [-r, r]) {
            if (j < minJ || j > maxJ) continue;
            for (let i = Math.max(minI, -r); i <= Math.min(maxI, r) && visited < 192; i++)
              visit(i, j);
          }
          for (const i of [-r, r]) {
            if (i < minI || i > maxI) continue;
            for (let j = Math.max(minJ, 1 - r); j <= Math.min(maxJ, r - 1) && visited < 192; j++)
              visit(i, j);
          }
        }
      }
    }
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
          !intersects(entry, b, view, this.seedEdge)
        )
          continue;
        for (let k = 0; k < v.present.length; k++)
          if (v.present[k]) consider(r.ci + (k % r.n), r.cj + Math.floor(k / r.n), 1);
      }
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
            if (!this.needsSeed(bounds, i, j, side)) continue;
            add(
              { kind: 'seed', x: i, y: j, z },
              dist(((i + 0.5) * side) / 16, ((j + 0.5) * side) / 16),
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
            if (ci > b.i1 || cj > b.j1 || ci + n <= b.i0 || cj + n <= b.j0) continue;
            add({ ...r, n, ci, cj }, task.priority + 0.001 * dist(ci + n / 2, cj + n / 2));
          }
        }
      }
      for (const key of this.splitSurfaces)
        if (!visibleSplits.has(key)) this.splitSurfaces.delete(key);
    }
    this.wanted = wanted;
    this.tileRetries.retain(wanted);
    for (const key of this.evictedUntil.keys()) if (!wanted.has(key)) this.evictedUntil.delete(key);
    this.queue = [...wanted.values()]
      .filter((task) => {
        const entry = this.cache.get(task.key);
        return !entry || entry.stale;
      })
      .sort((a, b) => a.priority - b.priority);
    for (const [key, job] of this.pending) if (!wanted.has(key)) job.abort.abort();
  }
  private updateVisible(view: AtlasFrame, mode: AtlasMode) {
    const b = view.bounds;
    const wanted = this.wanted;
    const age = ++this.age;
    const visible: Entry[] = [];
    for (const e of this.cache.values()) {
      if (
        (e.stale && !wanted.has(e.key)) ||
        (!e.value && (e.request.kind !== 'surface' || !this.seed)) ||
        !intersects(e, b, view, this.seedEdge)
      )
        continue;
      if (e.request.kind === 'mesh' && (mode === 'plan' || !wanted.has(e.key))) {
        // Keep a resident voxel LOD while a replacement is being streamed.
        const r = e.request;
        if (mode === 'plan' || ![1, 2, 4].some((l) => wanted.has(requestKey({ ...r, lod: l }))))
          continue;
      }
      if (e.request.kind === 'seed' && !this.seed) continue;
      if (wanted.has(e.key)) e.age = age;
      visible.push(e);
    }
    if (visible.length !== this.visible.length || visible.some((e, i) => e !== this.visible[i])) {
      this.visible = visible;
    }
  }
  private eligible(task: Task) {
    if (
      this.pending.has(task.key) ||
      this.backoff[task.request.kind === 'seed' ? 'seed' : 'live'].blocked
    )
      return false;
    const cached = this.cache.get(task.key);
    return (!cached || cached.stale) && (this.evictedUntil.get(task.key) ?? 0) <= Date.now();
  }
  private pump() {
    if (this.disposed || this.paused) return;
    const pending = [...this.pending.values()];
    const now = Date.now();
    let wakeAt = Infinity;
    let liveBusy = pending.some((job) => job.request.kind !== 'seed');
    let seedBusy = pending.some((job) => job.request.kind === 'seed');
    let slots = 6 - pending.filter((job) => !job.batch).length - Number(this.batchActive);
    for (const task of this.queue) {
      if (slots <= 0) break;
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
        this.startBatch(task.request.lod, this.options.loadMeshes);
      } else {
        const abort = new AbortController();
        this.pending.set(task.key, { abort, request: task.request });
        if (task.request.kind === 'seed') seedBusy = true;
        void this.load(task, abort);
      }
      if (task.request.kind !== 'seed') liveBusy = true;
      slots--;
    }
    this.tileRetries.wakeAt(wakeAt);
  }
  private startBatch(lod: number, loader: NonNullable<AtlasOptions['loadMeshes']>) {
    const batch = new AbortController();
    const requests: Extract<AtlasRequest, { kind: 'mesh' }>[] = [];
    const jobs: { task: Task; abort: AbortController }[] = [];
    for (const task of this.queue) {
      const r = task.request;
      if (
        r.kind !== 'mesh' ||
        r.lod !== lod ||
        this.tileRetries.has(task.key) ||
        !this.eligible(task)
      )
        continue;
      const abort = new AbortController();
      this.pending.set(task.key, { abort, request: r, batch: true });
      requests.push(r);
      jobs.push({ task, abort });
      if (jobs.length === 16) break;
    }
    const cancel = () => {
      if (jobs.every((job) => job.abort.signal.aborted)) batch.abort();
    };
    for (const { abort } of jobs) abort.signal.addEventListener('abort', cancel, { once: true });
    this.batchActive = true;
    const response = Promise.resolve()
      .then(() => loader(requests, batch.signal))
      .then((results) => {
        if (results.length !== requests.length) throw new Error('Incomplete Openworld mesh batch');
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
      this.batchActive = false;
      for (const job of jobs) job.abort.signal.removeEventListener('abort', cancel);
      this.pump();
    });
  }
  private async load(task: Task, abort: AbortController, batched?: Promise<ArrayBuffer | null>) {
    try {
      const bytes = await (batched ?? this.options.load(task.request, abort.signal));
      if (this.disposed || abort.signal.aborted) return;
      const value = bytes
        ? await new Promise<Terrain>((resolve, reject) => {
            const id = ++this.serial;
            this.workers.set(id, { key: task.key, resolve, reject });
            this.worker.postMessage({ id, request: task.request, face: this.options.face, bytes }, [
              bytes,
            ]);
          })
        : null;
      if (this.disposed || abort.signal.aborted) return;
      this.remove(task.key);
      if (task.request.kind !== 'seed') this.tileRetries.succeed(task.key);
      const size =
        value?.kind === 'raster'
          ? value.pixels.byteLength
          : value?.kind === 'quads'
            ? value.opaque.byteLength + value.blend.byteLength
            : 0;
      if (
        (this.stride > 1 || this.survey) &&
        task.request.kind === 'surface' &&
        task.request.lod === 6
      )
        this.previousPlan = null;
      this.totalBytes += size;
      this.cache.set(task.key, {
        ...task,
        value,
        bytes: size,
        age: this.age,
        stale: false,
        serial: ++this.serial,
      });
      if (this.cache.size > 1800 || this.totalBytes > cacheBudget) {
        const candidates = [...this.cache.values()].sort((a, b) => a.age - b.age);
        for (const c of candidates) {
          if (this.cache.size <= 1600 && this.totalBytes <= cacheBudget * 0.9) break;
          this.remove(c.key);
          this.previousPlan = null;
          // Defer eviction victims in a scene that exceeds memory capacity.
          if (this.wanted.has(c.key)) this.evictedUntil.set(c.key, Date.now() + 30000);
        }
      }
      this.generation++;
      this.changed();
    } catch (e) {
      if (!this.disposed && !abort.signal.aborted) {
        const status = typeof e === 'object' && e !== null && 'status' in e ? e.status : null;
        if (task.request.kind !== 'seed' && (status === 503 || status === 504)) {
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
    this.queue = [];
    this.evictedUntil.clear();
    this.tileRetries.reset();
  }
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
