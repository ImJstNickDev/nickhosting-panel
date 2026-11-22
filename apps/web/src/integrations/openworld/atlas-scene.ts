import { AtlasCamera, clamp } from './atlas-camera.js';
import { AtlasGpu } from './atlas-gpu.js';
import { AtlasStream } from './atlas-stream.js';
import type {
  AtlasBounds,
  AtlasController,
  AtlasMaterial,
  AtlasMode,
  AtlasOptions,
  AtlasPoint,
  AtlasSeedStyle,
  AtlasView,
} from './atlas-types.js';

type Contact = {
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
  button: number;
};
export class AtlasUnsupported extends Error {}

/** Render on demand. Only held flight keys, camera input, streaming uploads and resize schedule frames. */
export class AtlasScene implements AtlasController {
  private readonly gl: WebGL2RenderingContext;
  private gpu: AtlasGpu;
  private readonly camera: AtlasCamera;
  private readonly stream: AtlasStream;
  private readonly observer: ResizeObserver;
  private readonly events = new AbortController();
  private readonly pointers = new Map<number, Contact>();
  private readonly keys = new Set<string>();
  private frameRequest = 0;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private planDirty = true;
  private lastPlan = -Infinity;
  private previousTime = 0;
  private disposed = false;
  private suspended = false;
  private groundAtTarget = true;
  private snapGround = false;
  private materials: readonly AtlasMaterial[] = [];
  private voxelSize = 0.25;
  private biomes: readonly { id: number; color: string }[] = [];
  private seedStyle: AtlasSeedStyle = 'surface';
  private oldTouchAction: string;
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: AtlasOptions,
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new AtlasUnsupported('WebGL2 unavailable');
    this.gl = gl;
    this.camera = new AtlasCamera(options.edge, options.initialView);
    this.gpu = new AtlasGpu(gl, options, this.redraw);
    try {
      this.stream = new AtlasStream(options, this.terrainChanged);
    } catch (e) {
      this.gpu.destroy();
      throw e;
    }
    this.oldTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = 'none';
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    const listen = { signal: this.events.signal };
    canvas.addEventListener('pointerdown', this.down, listen);
    canvas.addEventListener('pointermove', this.drag, listen);
    canvas.addEventListener('pointerup', this.release, listen);
    canvas.addEventListener('pointercancel', this.cancel, listen);
    canvas.addEventListener('lostpointercapture', this.cancel, listen);
    canvas.addEventListener('wheel', this.wheel, { ...listen, passive: false });
    canvas.addEventListener('keydown', this.keydown, listen);
    canvas.addEventListener('keyup', this.keyup, listen);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), listen);
    canvas.addEventListener('blur', this.clearKeys, listen);
    window.addEventListener('blur', this.clearKeys, listen);
    canvas.addEventListener('webglcontextlost', this.contextLost, listen);
    canvas.addEventListener('webglcontextrestored', this.contextRestored, listen);
    document.addEventListener('visibilitychange', this.visibility, listen);
    this.resize();
  }
  private redraw = () => {
    if (!this.disposed && !this.suspended && !document.hidden && !this.frameRequest)
      this.frameRequest = requestAnimationFrame(this.draw);
  };
  private terrainChanged = () => {
    this.planDirty = true;
    this.redraw();
  };
  private draw = (now: number) => {
    this.frameRequest = 0;
    if (this.disposed || this.suspended || document.hidden) return;
    const dt = Math.min(0.06, Math.max(0, (now - this.previousTime) / 1000));
    this.previousTime = now;
    if (this.keys.size) this.stepKeys(dt);
    if (this.planDirty && now - this.lastPlan >= 40) {
      this.stream.update(this.camera.getFrame(), this.camera.mode);
      this.planDirty = false;
      this.lastPlan = now;
      if (this.groundAtTarget || this.snapGround) {
        const sample = this.stream.sample(this.camera.x, this.camera.z, this.voxelSize);
        if (sample.y !== undefined) {
          this.camera.y = sample.y;
          this.snapGround = false;
        }
      }
    }
    this.gpu.draw(this.camera, this.stream);
    this.options.onFrame?.();
    if (this.planDirty || this.keys.size) this.redraw();
  };
  private resize = () => {
    if (this.disposed) return;
    const bounds = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.camera.width = Math.max(1, bounds.width);
    this.camera.height = Math.max(1, bounds.height);
    const maxRB = this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE) as number;
    const ratio = Math.min(dpr, maxRB / this.camera.width, maxRB / this.camera.height);
    this.canvas.width = Math.max(1, Math.round(this.camera.width * ratio));
    this.canvas.height = Math.max(1, Math.round(this.camera.height * ratio));
    this.moved();
  };
  private moved() {
    this.planDirty = true;
    if (this.notifyTimer === undefined) {
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = undefined;
        if (!this.disposed) this.options.onCamera?.(this.getView());
      }, 96);
    }
    this.redraw();
  }
  setView(view: AtlasView) {
    this.camera.setView(view);
    this.snapGround = true;
    this.moved();
  }
  getView() {
    return this.camera.getFrame();
  }
  setMode(mode: AtlasMode) {
    if (this.camera.mode === mode) return;
    this.keys.clear();
    this.pointers.clear();
    const ground = this.stream.sample(this.camera.x, this.camera.z, this.voxelSize).y;
    if (ground !== undefined) this.camera.y = ground;
    this.camera.setMode(mode);
    this.groundAtTarget = mode !== 'fly';
    this.snapGround = ground === undefined;
    this.moved();
  }
  setCoverage(
    columns: readonly (readonly [number, number])[],
    stride = 1,
    auditedBounds?: AtlasBounds | null,
  ) {
    this.stream.setCoverage(columns, stride, auditedBounds);
    this.terrainChanged();
  }
  setSurveyBounds(bounds: AtlasBounds | null) {
    this.stream.setSurvey(bounds);
    this.terrainChanged();
  }
  setPalette(materials: readonly AtlasMaterial[], voxelSize = 0.25) {
    this.materials = materials;
    this.voxelSize = Number.isFinite(voxelSize) && voxelSize > 0 ? voxelSize : 0.25;
    this.gpu.setPalette(materials, this.voxelSize);
    this.redraw();
  }
  setSeed(
    enabled: boolean,
    style: AtlasSeedStyle = 'surface',
    biomes: readonly { id: number; color: string }[] = [],
    faceEdgeMeters = this.options.edge,
    maxZoom = 15,
  ) {
    this.seedStyle = style;
    this.biomes = biomes;
    this.gpu.seedStyle = style;
    this.gpu.setBiomes(biomes);
    this.stream.setSeed(enabled, faceEdgeMeters, Math.max(0, Math.min(22, maxZoom)));
    this.terrainChanged();
  }
  invalidate(cells: readonly (readonly [number, number])[] | null) {
    this.stream.invalidate(cells);
    this.terrainChanged();
  }
  zoom(factor: number) {
    this.zoomAt(factor, this.camera.width / 2, this.camera.height / 2);
  }
  private zoomAt(factor: number, px: number, py: number) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const cam = this.camera,
      before = cam.mode === 'fly' ? null : this.surfaceAnchor(px, py);
    cam.span = clamp(cam.span / factor, 4, Math.max(128, cam.edge * 2));
    if (before && cam.mode !== 'fly') {
      const after = cam.atHeight(px, py, before.y ?? cam.y);
      if (after) {
        cam.x = clamp(cam.x + before.x - after.x, 0, cam.edge);
        cam.z = clamp(cam.z + before.z - after.z, 0, cam.edge);
      }
    }
    this.moved();
  }
  rotate(quarterTurns: number) {
    this.camera.look((quarterTurns * Math.PI) / 2, 0);
    this.moved();
  }
  move(right: number, forward: number, up = 0) {
    this.camera.move(right, forward, up);
    this.snapGround = false;
    this.moved();
  }
  mayNeedSeed(bounds: AtlasBounds, x: number, y: number, tileMetres: number) {
    return this.stream.needsSeed(bounds, x, y, tileMetres);
  }
  isSeedArea(x: number, z: number) {
    return this.stream.seedAllowed(Math.floor(x / 16), Math.floor(z / 16));
  }
  project(x: number, z: number, y?: number) {
    const height = y ?? this.stream.sample(x, z, this.voxelSize).y ?? this.camera.y;
    return this.camera.project(x, z, height);
  }
  pick(px: number, py: number): AtlasPoint | null {
    return this.camera.mode === 'plan'
      ? this.surfaceAnchor(px, py)
      : this.gpu.pick(this.camera, px, py);
  }
  private surfaceAnchor(px: number, py: number): AtlasPoint | null {
    const c = this.camera;
    let h = c.y,
      location = c.atHeight(px, py, h);
    if (!location) return null;
    if (c.mode !== 'plan') {
      for (let step = 0; step < 5; step++) {
        const y = this.stream.sample(location.x, location.z, this.voxelSize).y;
        if (y === undefined || Math.abs(y - h) < 0.1) break;
        const next = c.atHeight(px, py, y);
        if (!next) break;
        location = next;
        h = y;
      }
    }
    if (location.x < 0 || location.z < 0 || location.x > c.edge || location.z > c.edge) return null;
    return this.stream.sample(location.x, location.z, this.voxelSize);
  }
  retry() {
    this.gpu.retry();
    this.stream.retry();
    this.terrainChanged();
  }
  private point(e: PointerEvent | WheelEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private down = (e: PointerEvent) => {
    if (e.button > 2) return;
    const p = this.point(e);
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, {
      ...p,
      startX: p.x,
      startY: p.y,
      moved: false,
      button: e.button,
    });
    if (this.pointers.size > 1) for (const c of this.pointers.values()) c.moved = true;
    e.preventDefault();
  };
  private pan(dx: number, dy: number) {
    const metres = this.camera.span / this.camera.width;
    const forward = dy * metres * (this.camera.mode === 'iso' ? 2 : 1);
    this.camera.move(-dx * metres, forward, 0);
  }
  private drag = (e: PointerEvent) => {
    const old = this.pointers.get(e.pointerId);
    if (!old) return;
    const p = this.point(e),
      dx = p.x - old.x,
      dy = p.y - old.y;
    if (Math.hypot(p.x - old.startX, p.y - old.startY) > 3) old.moved = true;
    const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)?.[1];
    if (other) {
      const before = Math.hypot(other.x - old.x, other.y - old.y),
        after = Math.hypot(other.x - p.x, other.y - p.y);
      if (before > 4 && after > 4)
        this.zoomAt(after / before, (other.x + p.x) / 2, (other.y + p.y) / 2);
      this.pan(dx / 2, dy / 2);
    } else if (old.moved) {
      if (
        (this.camera.mode === 'fly' && !e.shiftKey) ||
        (this.camera.mode === 'iso' && old.button === 2)
      ) {
        this.camera.look(-dx * 0.006, dy * 0.005);
        this.snapGround = false;
      } else this.pan(dx, dy);
    }
    old.x = p.x;
    old.y = p.y;
    this.moved();
  };
  private release = (e: PointerEvent) => {
    const touch = this.pointers.get(e.pointerId);
    if (!touch) return;
    this.pointers.delete(e.pointerId);
    if (!touch.moved && touch.button === 0) {
      const p = this.point(e),
        at = this.pick(p.x, p.y);
      if (at) this.options.onPick?.(p.x, p.y, at);
    }
  };
  private cancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
  };
  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.point(e);
    const multiplier = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.camera.height : 1;
    this.zoomAt(Math.exp(-clamp(e.deltaY * multiplier, -250, 250) * 0.0025), p.x, p.y);
  };
  private keydown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'enter') {
      e.preventDefault();
      const x = this.camera.width / 2,
        y = this.camera.height / 2,
        p = this.pick(x, y);
      if (p) this.options.onPick?.(x, y, p);
      return;
    }
    if (['+', '=', '-', '_'].includes(key)) {
      e.preventDefault();
      this.zoom(key === '+' || key === '=' ? 1.3 : 1 / 1.3);
      return;
    }
    if (
      ![
        'a',
        'd',
        'w',
        's',
        'q',
        'e',
        'arrowleft',
        'arrowright',
        'arrowup',
        'arrowdown',
        'shift',
      ].includes(key)
    )
      return;
    e.preventDefault();
    this.keys.add(key);
    if (!e.repeat && key !== 'shift') this.stepKeys(1 / 30);
    this.redraw();
  };
  private keyup = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };
  private clearKeys = () => {
    this.keys.clear();
    this.pointers.clear();
  };
  private stepKeys(dt: number) {
    const held = (key: string) => Number(this.keys.has(key));
    const cam = this.camera;
    const speed = Math.max(6, cam.span * 0.42) * (this.keys.has('shift') ? 3 : 1) * dt;
    let right = held('d') - held('a'),
      forward = held('w') - held('s');
    if (cam.mode === 'fly') {
      const yaw = held('arrowleft') - held('arrowright'),
        pitch = held('arrowdown') - held('arrowup');
      if (yaw || pitch) cam.look(yaw * dt * 1.3, pitch * dt * 1.2);
    } else {
      right += held('arrowright') - held('arrowleft');
      forward += held('arrowup') - held('arrowdown');
    }
    cam.move(right * speed, forward * speed, (held('e') - held('q')) * speed);
    this.snapGround = false;
    this.moved();
  }
  private contextLost = (e: Event) => {
    e.preventDefault();
    this.suspended = true;
    this.clearKeys();
  };
  private contextRestored = () => {
    if (this.disposed) return;
    try {
      this.gpu.destroy();
      this.gpu = new AtlasGpu(this.gl, this.options, this.redraw);
      this.gpu.setPalette(this.materials, this.voxelSize);
      this.gpu.setBiomes(this.biomes);
      this.gpu.seedStyle = this.seedStyle;
      this.suspended = false;
      this.terrainChanged();
    } catch {
      this.options.onUnavailable?.();
    }
  };
  private visibility = () => {
    this.stream.setPaused(document.hidden);
    this.gpu.setPaused(document.hidden);
    if (document.hidden) {
      this.clearKeys();
      if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
      this.frameRequest = 0;
    } else this.terrainChanged();
  };
  destroy() {
    this.disposed = true;
    this.events.abort();
    this.observer.disconnect();
    clearTimeout(this.notifyTimer);
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    this.pointers.clear();
    this.keys.clear();
    this.stream.destroy();
    this.gpu.destroy();
    this.canvas.style.touchAction = this.oldTouchAction;
  }
}
