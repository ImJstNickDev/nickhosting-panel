import { AtlasBackoff } from './atlas-backoff.js';
import type { AtlasCamera } from './atlas-camera.js';
import {
  flightBoxVisible,
  flightDepthBands,
  flightDepthSplit,
  flightFarNearClip,
} from './atlas-flight-plan.js';
import { type QuadBatch, type Raster, regionColumns } from './atlas-geometry.js';
import { changedMaskArea } from './atlas-mask.js';
import { materialAppearance } from './atlas-materials.js';
import { pickAtlas } from './atlas-pick.js';
import { AtlasSeamCache, type SeamPage } from './atlas-seams.js';
import {
  coverageFragment,
  coverageVertex,
  quadFragment,
  quadVertex,
  seamFragment,
  seamVertex,
  terrainFragment,
  terrainVertex,
} from './atlas-shaders.js';
import type { AtlasStream, Entry } from './atlas-stream.js';
import type { AtlasFrame, AtlasMaterial, AtlasOptions, AtlasSeedStyle } from './atlas-types.js';

type GL = WebGL2RenderingContext;
type Uniforms = Record<string, WebGLUniformLocation | null>;
function pipeline(gl: GL, vertex: string, fragment: string) {
  const program = gl.createProgram();
  if (!program) throw new Error('WebGL program unavailable');
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('WebGL shader unavailable');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader) ?? 'Openworld shader compilation failed';
      gl.deleteShader(shader);
      gl.deleteProgram(program);
      throw new Error(error);
    }
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const msg = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(msg ?? 'Unable to link Openworld shader');
  }
  const u: Uniforms = {};
  for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
    const name = gl.getActiveUniform(program, i)?.name;
    if (name) u[name] = gl.getUniformLocation(program, name);
  }
  return { program, u: u as Record<string, WebGLUniformLocation> };
}
function texture(
  gl: GL,
  internal: number,
  width: number,
  height: number,
  format: number,
  type: number,
  data: ArrayBufferView | null,
) {
  const tex = gl.createTexture();
  if (!tex) throw new Error('WebGL texture unavailable');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
  return tex;
}
function grid(gl: GL, side: number) {
  const vertices = new Float32Array((side + 1) ** 2 * 2),
    indices = new Uint16Array(side * side * 6);
  let k = 0;
  for (let j = 0; j <= side; j++)
    for (let i = 0; i <= side; i++) {
      vertices[k++] = i / side;
      vertices[k++] = j / side;
    }
  k = 0;
  for (let j = 0; j < side; j++)
    for (let i = 0; i < side; i++) {
      const a = j * (side + 1) + i,
        b = a + side + 1;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = a + 1;
      indices[k++] = a + 1;
      indices[k++] = b;
      indices[k++] = b + 1;
    }
  const vao = gl.createVertexArray(),
    vbo = gl.createBuffer(),
    ibo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  return { vao, vbo, ibo, count: indices.length };
}
type ImageTile = { tex: WebGLTexture; id: number; used: number; bytes: number };
type VoxelGroup = {
  layout: number;
  serials: number[];
  vbo: WebGLBuffer | null;
  vao: WebGLVertexArrayObject | null;
  count: number;
  bytes: number;
  used: number;
};
type Region = {
  key: string;
  depthBands: number;
  x: number;
  z: number;
  minY: number;
  maxY: number;
  entries: Entry[];
  opaque: boolean;
  blend: boolean;
};
const rgb = (hex: string) =>
  /^#[a-f\d]{6}$/i.test(hex) ? Number.parseInt(hex.slice(1), 16) : 0x7d827e;
const gpuLimit = 96 * 1024 * 1024;
export class AtlasGpu {
  private readonly terrain;
  private readonly quads;
  private readonly cover;
  private readonly seams;
  private readonly seamCache: AtlasSeamCache;
  private seamPages: SeamPage[] = [];
  private readonly seamBuffers = new Map<
    string,
    {
      vao: WebGLVertexArrayObject | null;
      buffer: WebGLBuffer | null;
      pages: SeamPage[];
      floats: number;
      capacity: number;
    }
  >();
  private workingSeams = false;
  private planSeams = false;
  private residentGeneration = -1;
  private seamLayout = -1;

  private readonly mask;
  private readonly palette;
  private readonly biomes;
  private readonly textureIndex;
  private readonly textures;
  private readonly imageTile;
  private readonly imageFramebuffer;
  private readonly slots: number;
  private readonly grids = new Map<number, ReturnType<typeof grid>>();
  private readonly rasters = new Map<string, ImageTile>();
  private readonly groups = new Map<string, VoxelGroup>();
  private readonly materialStatus = new Map<number, AtlasMaterial>();
  private readonly loadedImages = new Map<number, number>();
  private readonly loadingImages = new Map<number, AbortController>();
  private readonly imageBackoff: AtlasBackoff;
  private readonly failedImages = new Set<number>();
  private readonly textureLut = new Float32Array(256 * 256 * 4);
  private readonly coverVao;
  private readonly coverBuffer;
  private coverSize = 0;
  private knownColumns: AtlasStream['columns'] | null = null;
  private maskSignature = '';
  private maskX = 0;
  private maskZ = 0;
  private maskStride = 1;
  private maskBytes = new Uint8Array(0);
  private maskWidth = 0;
  private maskScratch = new Uint8Array(0);
  private visible: Entry[] | null = null;
  private rastersInView: Entry[] = [];
  private readonly nearRasters: Entry[] = [];
  private readonly farRasters: Entry[] = [];
  private depthBand = 0;
  private meshesInView: Entry[] = [];
  private exposedRasters: Entry[] = [];
  private regions: Region[] = [];
  private activeRegions: Region[] = [];
  private layout = 0;
  private budgetDirty = false;
  private idsInView = new Set<number>();
  private uploadWords = new Uint16Array(0);
  private drawn: Entry[] = [];
  private frame = 0;
  private disposed = false;
  voxelSize = 0.25;
  seedStyle: AtlasSeedStyle = 'surface';
  constructor(
    private readonly gl: GL,
    private readonly options: AtlasOptions,
    private readonly changed: () => void,
  ) {
    this.imageBackoff = new AtlasBackoff(changed, (e) => options.onError?.(e));
    this.seams = pipeline(gl, seamVertex, seamFragment);
    this.seamCache = new AtlasSeamCache();
    this.terrain = pipeline(gl, terrainVertex, terrainFragment);
    this.quads = pipeline(gl, quadVertex, quadFragment);
    this.cover = pipeline(gl, coverageVertex, coverageFragment);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.mask = texture(gl, gl.R8UI, 1, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(1));
    this.palette = texture(gl, gl.RGBA8, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.biomes = texture(gl, gl.RGBA8, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.textureIndex = texture(gl, gl.RGBA32F, 256, 256, gl.RGBA, gl.FLOAT, this.textureLut);
    this.textures = gl.createTexture();
    this.slots = Math.min(512, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textures);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 6, gl.RGBA8, 32, 32, this.slots);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    // Generating mipmaps on a texture array filters *all* allocated layers,
    // including unused ones. Build each newly arrived tile in a reusable 32px
    // texture, then copy its mip chain into the assigned array layer on the GPU.
    this.imageFramebuffer = gl.createFramebuffer();
    this.imageTile = gl.createTexture();
    if (!this.imageFramebuffer || !this.imageTile)
      throw new Error('WebGL material texture unavailable');
    gl.bindTexture(gl.TEXTURE_2D, this.imageTile);
    gl.texStorage2D(gl.TEXTURE_2D, 6, gl.RGBA8, 32, 32);
    this.coverVao = gl.createVertexArray();
    this.coverBuffer = gl.createBuffer();
    gl.bindVertexArray(this.coverVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.coverBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    for (const s of [1, 8, 16, 32, 64, 128]) this.grids.set(s, grid(gl, s));
    gl.bindVertexArray(null);
  }
  setPalette(data: readonly AtlasMaterial[], voxel: number) {
    const gl = this.gl,
      colors = new Uint8Array(256 * 256 * 4);
    this.materialStatus.clear();
    for (const m of data) {
      if (!Number.isInteger(m.id) || m.id < 0 || m.id > 65535) continue;
      const value = rgb(m.color),
        p = m.id * 4;
      colors[p] = value >>> 16;
      colors[p + 1] = value >>> 8;
      colors[p + 2] = value;
      const appearance = materialAppearance(m);
      colors[p + 3] = appearance.surfaceKind;
      this.textureLut[p + 2] = appearance.opacity;
      this.textureLut[p + 3] = appearance.glow;
      this.textureLut[p + 1] = m.tileMeters && m.tileMeters > 0 ? m.tileMeters : 1;
      this.materialStatus.set(m.id, m);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.palette);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, colors);
    this.voxelSize = voxel;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.textureIndex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 256, gl.RGBA, gl.FLOAT, this.textureLut);
  }
  setBiomes(biomes: readonly { id: number; color: string }[]) {
    const colors = new Uint8Array(256 * 4);
    for (const b of biomes) {
      if (b.id < 0 || b.id >= 256) continue;
      const v = rgb(b.color);
      colors[b.id * 4] = v >>> 16;
      colors[b.id * 4 + 1] = v >>> 8;
      colors[b.id * 4 + 2] = v;
      colors[b.id * 4 + 3] = 255;
    }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.biomes);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, colors);
  }
  private syncTextureIndex(id: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.textureIndex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      id & 255,
      id >>> 8,
      1,
      1,
      gl.RGBA,
      gl.FLOAT,
      this.textureLut,
      id * 4,
    );
  }
  setPaused(paused: boolean) {
    this.imageBackoff.pause(paused);
    if (paused) for (const ac of this.loadingImages.values()) ac.abort();
  }
  retry() {
    this.failedImages.clear();
    this.imageBackoff.reset();
  }
  private images(ids: Set<number>) {
    const load = this.options.loadTexture;
    if (!load || this.imageBackoff.blocked) return;
    for (const id of ids) {
      if (this.loadingImages.size >= 2) return;
      if (
        this.loadedImages.has(id) ||
        this.loadingImages.has(id) ||
        this.failedImages.has(id) ||
        !this.materialStatus.get(id)?.textured
      )
        continue;
      if (
        this.loadedImages.size >= this.slots &&
        ![...this.loadedImages.keys()].some((key) => !ids.has(key))
      )
        return;
      const ac = new AbortController();
      this.loadingImages.set(id, ac);
      void (async () => {
        let bitmap: ImageBitmap | undefined;
        try {
          const blob = await load(id, ac.signal);
          if (!blob) {
            this.failedImages.add(id);
            return;
          }
          bitmap = await createImageBitmap(blob, {
            resizeWidth: 32,
            resizeHeight: 32,
            resizeQuality: 'pixelated',
            imageOrientation: 'flipY',
            premultiplyAlpha: 'none',
          });
          if (this.disposed || ac.signal.aborted) return;
          let slot = this.loadedImages.size;
          if (slot >= this.slots) {
            const unused = [...this.loadedImages.keys()].find((k) => !ids.has(k));
            if (unused === undefined) return;
            slot = this.loadedImages.get(unused) ?? 0;
            this.loadedImages.delete(unused);
            this.textureLut[unused * 4] = 0;
            this.syncTextureIndex(unused);
          }
          const gl = this.gl;
          gl.activeTexture(gl.TEXTURE5);
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textures);
          gl.bindTexture(gl.TEXTURE_2D, this.imageTile);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.imageFramebuffer);
          for (let level = 0; level < 6; level++) {
            gl.framebufferTexture2D(
              gl.READ_FRAMEBUFFER,
              gl.COLOR_ATTACHMENT0,
              gl.TEXTURE_2D,
              this.imageTile,
              level,
            );
            const side = 32 >> level;
            gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, slot, 0, 0, side, side);
          }
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
          this.loadedImages.set(id, slot);
          this.textureLut[id * 4] = slot + 1;
          this.syncTextureIndex(id);
        } catch (error) {
          if (!ac.signal.aborted && !this.disposed) {
            this.imageBackoff.fail(error);
          }
        } finally {
          bitmap?.close();
          this.loadingImages.delete(id);
          if (!this.disposed) this.changed();
        }
      })();
    }
  }
  private view(program: ReturnType<typeof pipeline>, cam: AtlasCamera) {
    const g = this.gl,
      u = program.u,
      b = cam.basis;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL selects a compiled shader program.
    g.useProgram(program.program);
    g.uniformMatrix3fv(u.uAxes ?? null, false, [
      b.right[0],
      b.up[0],
      b.forward[0],
      b.right[1],
      b.up[1],
      b.forward[1],
      b.right[2],
      b.up[2],
      b.forward[2],
    ]);
    g.uniform4f(
      u.uClip ?? null,
      2 / cam.span,
      (2 / cam.span) * (cam.width / cam.height),
      cam.distance,
      cam.far,
    );
    g.uniform1f(u.uPerspective ?? null, cam.mode === 'fly' ? 1 : 0);
  }
  private setDepthBand(u: Uniforms, cam: AtlasCamera, band: 0 | 1 | 2) {
    if (band) {
      const near = band === 1 ? cam.near : flightFarNearClip;
      this.gl.uniform2f(u.uDepthClip ?? null, near, band === 1 ? flightDepthSplit : cam.far);
    }
    if (this.depthBand === band) return;
    this.gl.depthRange(band === 2 ? 0.875 : 0, band === 1 ? 0.875 : 1);
    this.depthBand = band;
  }
  private coverage(cam: AtlasCamera, stream: AtlasStream) {
    const gl = this.gl;
    if (cam.mode !== 'plan') return;
    if (this.knownColumns !== stream.columns) {
      const xy = new Float32Array(stream.columns.length * 2);
      stream.columns.forEach(([i, j], k) => {
        xy[k * 2] = i;
        xy[k * 2 + 1] = j;
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, this.coverBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, xy, gl.DYNAMIC_DRAW);
      this.coverSize = stream.columns.length;
      this.knownColumns = stream.columns;
    }
    if (!this.coverSize) return;
    this.view(this.cover, cam);
    gl.bindVertexArray(this.coverVao);
    gl.uniform1f(this.cover.u.uStride ?? null, stream.stride);
    gl.uniform3f(this.cover.u.uOrigin ?? null, -cam.x, 0, -cam.z);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.coverSize);
  }
  private uploadMask(
    frame: AtlasFrame,
    plan: boolean,
    stream: AtlasStream,
    rasters: Entry[],
    meshes: Entry[],
  ) {
    const b = frame.bounds;
    // A wide flight cone still needs one rank per native column at the eye.
    // The bound also leaves room for the aligned origin on WebGL2's minimum texture size.
    const maxSide = frame.flight ? 2016 : 480;
    const stride =
      2 ** Math.max(0, Math.ceil(Math.log2(Math.max(b.i1 - b.i0 + 1, b.j1 - b.j0 + 1) / maxSide)));
    const xi = Math.floor(b.i0 / (16 * stride)) * 16 * stride,
      zj = Math.floor(b.j0 / (16 * stride)) * 16 * stride;
    const width = Math.ceil((b.i1 + 1 - xi) / (16 * stride)) * 16,
      height = Math.ceil((b.j1 + 1 - zj) / (16 * stride)) * 16;
    // prepare() already invalidates visible live ranks. Arrivals behind the camera
    // can only affect this mask independently when procedural coverage is enabled.
    const signature = [
      xi,
      zj,
      width,
      height,
      stride,
      stream.seed ? stream.generation : 0,
      plan,
    ].join('/');
    if (this.maskSignature === signature) return false;
    this.maskSignature = signature;
    this.maskX = xi * 16;
    this.maskZ = zj * 16;
    this.maskStride = stride;
    const bytes =
      this.maskScratch.length === width * height
        ? this.maskScratch
        : new Uint8Array(width * height);
    if (bytes === this.maskScratch) bytes.fill(0);
    const mark = (i: number, j: number, bit: number, replace = false) => {
      const x = Math.floor((i - xi) / stride),
        y = Math.floor((j - zj) / stride);
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const k = y * width + x,
        old = bytes[k] ?? 0;
      bytes[k] = replace ? bit : ((old | 16) & 240) | Math.max(old & 15, bit & 15);
    };
    if (stream.seed) {
      const audited = stream.audited;
      if (audited || (!stream.coverageReady && !stream.surveyBounds)) {
        bytes.fill(16);
        if (audited) {
          const x0 = Math.max(0, Math.ceil((audited.i0 - xi) / stride));
          const x1 = Math.min(width, Math.floor((audited.i1 + 1 - xi) / stride));
          const y1 = Math.min(height, Math.floor((audited.j1 + 1 - zj) / stride));
          if (x0 < x1)
            for (let y = Math.max(0, Math.ceil((audited.j0 - zj) / stride)); y < y1; y++)
              bytes.fill(0, y * width + x0, y * width + x1);
        }
      }
      // Populate coarse coverage efficiently, only within this mask.
      stream.forEachColumn(
        { i0: xi, j0: zj, i1: xi + width * stride - 1, j1: zj + height * stride - 1 },
        (i, j) => {
          const s = stream.stride;
          for (
            let y = Math.max(zj, Math.floor(j / stride) * stride);
            y < Math.min(j + s, zj + height * stride);
            y += stride
          )
            for (
              let x = Math.max(xi, Math.floor(i / stride) * stride);
              x < Math.min(i + s, xi + width * stride);
              x += stride
            )
              mark(x, y, 16);
        },
      );
      const survey = stream.surveyBounds;
      if (survey) {
        const x0 = Math.max(0, Math.floor((survey.i0 - xi) / stride)),
          x1 = Math.min(width, Math.ceil((survey.i1 + 1 - xi) / stride));
        for (
          let y = Math.max(0, Math.floor((survey.j0 - zj) / stride));
          y < Math.min(height, Math.ceil((survey.j1 + 1 - zj) / stride));
          y++
        )
          if (x1 > x0) bytes.fill(16, y * width + x0, y * width + x1);
      }
    }
    if (stream.seed && stride === 1 && (stream.surveyBounds || stream.stride > 1)) {
      for (const e of stream.visible) {
        const r = e.request;
        if (e.value || e.stale || r.kind !== 'surface') continue;
        for (let j = Math.max(zj, r.cj); j < Math.min(zj + height, r.cj + r.n); j++) {
          for (let i = Math.max(xi, r.ci); i < Math.min(xi + width, r.ci + r.n); i++) {
            if (bytes[(j - zj) * width + i - xi] === 16 && stream.seedAllowed(i, j))
              mark(i, j, 0, true);
          }
        }
      }
    }
    for (const e of rasters) {
      const r = e.request,
        v = e.value;
      if (r.kind !== 'surface' || v?.kind !== 'raster' || !v.present) continue;
      const rank = stride === 1 ? 7 - r.lod : 0;
      for (let k = 0; k < v.present.length; k++) {
        const i = r.ci + (k % r.n),
          j = r.cj + Math.floor(k / r.n);
        if (v.present[k]) mark(i, j, rank);
        else if (
          stride === 1 &&
          stream.seed &&
          (stream.surveyBounds || stream.stride > 1) &&
          stream.seedAllowed(i, j)
        ) {
          const x = i - xi,
            z = j - zj;
          if (x >= 0 && z >= 0 && x < width && z < height && bytes[z * width + x] === 16)
            mark(i, j, 0, true);
        }
      }
    }
    if (stride === 1)
      for (const e of meshes)
        if (
          e.request.kind === 'mesh' &&
          e.value?.kind === 'quads' &&
          (e.value.opaque.length || e.value.blend.length)
        )
          mark(e.request.i, e.request.j, 15);
    const sameSize = this.maskWidth === width && this.maskBytes.length === bytes.length;
    this.maskScratch = this.maskBytes;
    this.maskBytes = bytes;
    this.maskWidth = width;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    if (sameSize) {
      const dirty = changedMaskArea(this.maskScratch, bytes, width);
      if (dirty) {
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, width);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          dirty.x,
          dirty.y,
          dirty.width,
          dirty.height,
          gl.RED_INTEGER,
          gl.UNSIGNED_BYTE,
          bytes,
          dirty.y * width + dirty.x,
        );
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      }
    } else
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R8UI,
        width,
        height,
        0,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        bytes,
      );
    return true;
  }
  private exposed(entry: Entry, raster: Raster) {
    const r = entry.request;
    if (this.maskStride !== 1 || r.kind !== 'surface' || !raster.present) return true;
    const xi = this.maskX / 16,
      zj = this.maskZ / 16;
    for (let k = 0; k < raster.present.length; k++) {
      if (!raster.present[k]) continue;
      const x = r.ci + (k % r.n) - xi,
        y = r.cj + Math.floor(k / r.n) - zj;
      if (x < 0 || y < 0 || x >= this.maskWidth || y * this.maskWidth >= this.maskBytes.length)
        continue;
      if (((this.maskBytes[y * this.maskWidth + x] ?? 0) & 15) <= 7 - r.lod) return true;
    }
    return false;
  }
  private raster(entry: Entry, r: Raster, cam: AtlasCamera) {
    const gl = this.gl,
      u = this.terrain.u;
    let gpu = this.rasters.get(entry.key);
    gl.activeTexture(gl.TEXTURE0);
    if (gpu?.id !== entry.serial) {
      if (gpu) gl.deleteTexture(gpu.tex);
      const tex = texture(
        gl,
        gl.RGBA16UI,
        r.side,
        r.side,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_SHORT,
        r.pixels,
      );
      gpu = { id: entry.serial, used: this.frame, tex, bytes: r.pixels.byteLength };
      this.rasters.set(entry.key, gpu);
      this.budgetDirty = true;
    }
    gpu.used = this.frame;
    gl.bindTexture(gl.TEXTURE_2D, gpu.tex);
    gl.uniform3f(u.uOrigin ?? null, r.x - cam.x, -cam.y, r.z - cam.z);
    gl.uniform2f(u.uMaskOffset ?? null, r.x - this.maskX, r.z - this.maskZ);
    gl.uniform4f(
      u.uTile ?? null,
      r.mpp * r.side,
      this.voxelSize,
      r.seed ? 1 : 0,
      cam.mode === 'plan' ? 1 : 0,
    );
    gl.uniform3f(
      u.uSurface ?? null,
      r.mpp,
      entry.request.kind === 'surface' ? 7 - entry.request.lod : 0,
      this.seedStyle === 'biomes' ? 1 : 0,
    );
    const geometry = this.grids.get(cam.mode === 'plan' ? 1 : Math.min(128, Math.max(8, r.side)));
    if (!geometry) return;
    gl.bindVertexArray(geometry.vao);
    gl.drawElements(gl.TRIANGLES, geometry.count, gl.UNSIGNED_SHORT, 0);
  }
  private updateSeams(cam: AtlasCamera, stream: AtlasStream) {
    const plan = cam.mode === 'plan';
    if (this.seamLayout !== this.layout || plan !== this.planSeams) {
      this.seamCache.setVisible(plan ? [] : [...this.rastersInView, ...this.meshesInView]);
      this.seamLayout = this.layout;
      this.planSeams = plan;
      this.workingSeams = true;
    }
    if (this.residentGeneration !== stream.generation) {
      this.seamCache.setResident(stream.residentTerrain());
      this.residentGeneration = stream.generation;
      this.workingSeams = true;
    }
    if (!this.workingSeams) return;
    this.workingSeams = this.seamCache.advance(2);
    if (this.workingSeams) this.changed();
    const pages = plan ? [] : this.seamCache.visiblePages();
    if (pages.length === this.seamPages.length && pages.every((p, i) => p === this.seamPages[i]))
      return;
    this.seamPages = pages;
    const regions = new Map<string, SeamPage[]>();
    for (const page of pages) {
      const key = `${page.originX},${page.originZ}`;
      const region = regions.get(key);
      if (region) region.push(page);
      else regions.set(key, [page]);
    }
    const gl = this.gl;
    for (const [key, group] of this.seamBuffers)
      if (!regions.has(key)) {
        gl.deleteBuffer(group.buffer);
        gl.deleteVertexArray(group.vao);
        this.seamBuffers.delete(key);
      }
    for (const [key, pages] of regions) {
      let group = this.seamBuffers.get(key);
      if (!group) {
        group = {
          vao: gl.createVertexArray(),
          buffer: gl.createBuffer(),
          pages: [],
          floats: 0,
          capacity: 0,
        };
        gl.bindVertexArray(group.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, group.buffer);
        for (const [index, size, offset] of [
          [0, 4, 0],
          [1, 4, 16],
          [2, 2, 32],
        ] as const) {
          gl.enableVertexAttribArray(index);
          gl.vertexAttribPointer(index, size, gl.FLOAT, false, 40, offset);
          gl.vertexAttribDivisor(index, 1);
        }
        this.seamBuffers.set(key, group);
      }
      if (pages.length === group.pages.length && pages.every((p, i) => p === group.pages[i]))
        continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, group.buffer);
      const floats = pages.reduce((n, p) => n + p.data.length, 0);
      let prefix = 0;
      let offset = 0;
      if (floats > group.capacity || 2 * floats < group.capacity) {
        group.capacity = floats + Math.min(65536, Math.ceil(floats / 4));
        gl.bufferData(gl.ARRAY_BUFFER, 4 * group.capacity, gl.DYNAMIC_DRAW);
      } else {
        while (prefix < pages.length && pages[prefix] === group.pages[prefix]) {
          offset += (pages[prefix] as SeamPage).data.byteLength;
          prefix++;
        }
      }
      for (let i = prefix; i < pages.length; i++) {
        const page = pages[i] as SeamPage;
        gl.bufferSubData(gl.ARRAY_BUFFER, offset, page.data);
        offset += page.data.byteLength;
      }
      group.floats = floats;
      group.pages = pages;
    }
  }
  private drawSeams(cam: AtlasCamera) {
    if (!this.seamBuffers.size) return;
    const gl = this.gl;
    this.view(this.seams, cam);
    const u = this.seams.u;
    gl.uniform1i(u.uPalette ?? null, 1);
    gl.uniform1f(u.uVoxelSize ?? null, this.voxelSize);
    for (const group of this.seamBuffers.values()) {
      const origin = group.pages[0];
      if (!origin) continue;
      gl.bindVertexArray(group.vao);
      gl.uniform3f(u.uOrigin ?? null, origin.originX - cam.x, -cam.y, origin.originZ - cam.z);
      if (cam.mode === 'fly')
        for (const band of [1, 2] as const) {
          this.setDepthBand(u, cam, band);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, group.floats / 10);
        }
      else gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, group.floats / 10);
    }
  }
  private group(key: string, entries: Entry[], pass: 'opaque' | 'blend') {
    let group = this.groups.get(key);
    if (group?.layout === this.layout) return group;
    let prefix = 0;
    let reusableBytes = 0;
    while (group && prefix < entries.length && entries[prefix]?.serial === group.serials[prefix]) {
      reusableBytes += ((entries[prefix] as Entry).value as QuadBatch)[pass].byteLength;
      prefix++;
    }
    if (group && prefix === entries.length && prefix === group.serials.length) {
      group.layout = this.layout;
      return group;
    }
    const gl = this.gl;
    if (!group) {
      group = {
        vao: gl.createVertexArray(),
        vbo: gl.createBuffer(),
        layout: this.layout,
        serials: [],
        count: 0,
        bytes: 0,
        used: this.frame,
      };
      gl.bindVertexArray(group.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, group.vbo);
      for (const [index, count, offset] of [
        [1, 3, 0],
        [2, 3, 6],
        [3, 2, 12],
      ] as const) {
        gl.enableVertexAttribArray(index);
        gl.vertexAttribIPointer(index, count, gl.UNSIGNED_SHORT, 16, offset);
        gl.vertexAttribDivisor(index, 1);
      }
      this.groups.set(key, group);
      this.budgetDirty = true;
    }
    const size = entries.reduce((sum, e) => sum + (e.value as QuadBatch)[pass].byteLength, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, group.vbo);
    if (size > group.bytes) {
      this.budgetDirty = true;
      group.bytes = Math.max(size, Math.ceil((group.bytes * 1.5) / 16) * 16);
      gl.bufferData(gl.ARRAY_BUFFER, group.bytes, gl.DYNAMIC_DRAW);
      prefix = 0;
      reusableBytes = 0;
    }
    // Columns usually arrive in order within each region. Only replace the changed
    // suffix. One GPU submission also avoids a WebGL command per resident column.
    const words = (size - reusableBytes) / Uint16Array.BYTES_PER_ELEMENT;
    if (words) {
      if (this.uploadWords.length < words) this.uploadWords = new Uint16Array(words);
      let offset = 0;
      for (let i = prefix; i < entries.length; i++) {
        const quads = ((entries[i] as Entry).value as QuadBatch)[pass];
        this.uploadWords.set(quads, offset);
        offset += quads.length;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, reusableBytes, this.uploadWords, 0, words);
    }
    group.layout = this.layout;
    group.count = size / 16;
    group.serials = entries.map((e) => e.serial);
    group.used = this.frame;
    return group;
  }
  private prepare(visible: Entry[]) {
    this.visible = visible;
    this.layout++;
    this.budgetDirty = true;
    this.maskSignature = '';
    const bestMeshes = new Map<string, Entry>();
    const rasters: Entry[] = [];
    for (const e of visible) {
      const r = e.request;
      if (
        r.kind === 'mesh' &&
        e.value?.kind === 'quads' &&
        (e.value.opaque.length || e.value.blend.length)
      ) {
        const key = `${r.i},${r.j}`;
        const previous = bestMeshes.get(key);
        if (!previous || (previous.request.kind === 'mesh' && r.lod < previous.request.lod))
          bestMeshes.set(key, e);
      } else if (e.value?.kind === 'raster') rasters.push(e);
    }
    this.rastersInView = rasters.sort((a, b) => {
      const x = a.value as Raster,
        y = b.value as Raster;
      return Number(y.seed) - Number(x.seed) || y.mpp - x.mpp;
    });
    this.meshesInView = [];
    const groups = new Map<string, Entry[]>();
    for (const e of bestMeshes.values()) {
      const v = e.value;
      if (v?.kind !== 'quads' || !(v.opaque.length || v.blend.length)) continue;
      this.meshesInView.push(e);
      const key = `${v.regionX}:${v.regionZ}`;
      const list = groups.get(key);
      if (list) list.push(e);
      else groups.set(key, [e]);
    }
    this.regions = [];
    for (const [key, list] of groups) {
      const v = list[0]?.value;
      if (v?.kind !== 'quads') continue;
      let minY = Infinity,
        maxY = -Infinity,
        opaque = false,
        blend = false;
      for (const e of list) {
        const tile = e.value as QuadBatch;
        minY = Math.min(minY, tile.minY);
        maxY = Math.max(maxY, tile.maxY);
        opaque ||= tile.opaque.length > 0;
        blend ||= tile.blend.length > 0;
      }
      this.regions.push({
        key,
        depthBands: 1,
        x: v.regionX * 16,
        z: v.regionZ * 16,
        minY,
        maxY,
        entries: list,
        opaque,
        blend,
      });
    }
  }
  private updateActiveRegions(flight: AtlasFrame['flight']) {
    // Regions outside the actual frustum may already be decoded for an upcoming turn.
    // Keep their GPU buffers warm but upload and submit only when they can contribute pixels.
    const span = regionColumns * 64 * this.voxelSize;
    const active = flight
      ? this.regions.filter((r) => {
          const x0 = r.x - 1,
            z0 = r.z - 1,
            x1 = r.x + span + 1,
            z1 = r.z + span + 1;
          const y0 = r.minY * this.voxelSize - 1,
            y1 = r.maxY * this.voxelSize + 1;
          if (!flightBoxVisible(flight, x0, z0, x1, z1, y0, y1)) return false;
          r.depthBands = flightDepthBands(flight, x0, z0, x1, z1, y0, y1);
          return true;
        })
      : this.regions;
    if (
      this.activeRegions.length === active.length &&
      this.activeRegions.every((r, i) => r === active[i])
    )
      return;
    this.activeRegions = active;
    this.idsInView.clear();
    for (const region of active)
      for (const entry of region.entries)
        for (const id of (entry.value as QuadBatch).materials) this.idsInView.add(id);
    this.budgetDirty = true;
  }
  draw(cam: AtlasCamera, stream: AtlasStream, frame = cam.getFrame()) {
    const gl = this.gl;
    ++this.frame;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    const plan = cam.mode === 'plan';
    if (plan) gl.clearColor(0.085, 0.125, 0.13, 1);
    else gl.clearColor(0.68, 0.78, 0.81, 1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    this.coverage(cam, stream);
    if (this.visible !== stream.visible) this.prepare(stream.visible);
    this.updateActiveRegions(frame.flight);
    if (this.uploadMask(frame, plan, stream, this.rastersInView, this.meshesInView)) {
      this.exposedRasters = this.rastersInView.filter((e) => this.exposed(e, e.value as Raster));
      this.drawn = [...this.meshesInView, ...this.exposedRasters];
    }
    this.view(this.terrain, cam);
    if (!plan) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.palette);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.biomes);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    const u = this.terrain.u;
    gl.uniform1i(u.uData ?? null, 0);
    gl.uniform1i(u.uPalette ?? null, 1);
    gl.uniform1i(u.uBiomes ?? null, 2);
    gl.uniform1i(u.uMask ?? null, 3);
    gl.uniform1f(u.uMaskMetres ?? null, 16 * this.maskStride);
    this.nearRasters.length = 0;
    this.farRasters.length = 0;
    for (const e of this.exposedRasters) {
      if (!frame.flight) {
        this.raster(e, e.value as Raster, cam);
        continue;
      }
      const r = e.value as Raster,
        side = r.mpp * r.side,
        scale = r.seed ? 0.1 : this.voxelSize;
      const x1 = r.x + side,
        z1 = r.z + side,
        y0 = r.minHeight * scale,
        y1 = r.maxHeight * scale;
      if (!flightBoxVisible(frame.flight, r.x, r.z, x1, z1, y0, y1)) continue;
      const bands = flightDepthBands(frame.flight, r.x, r.z, x1, z1, y0, y1);
      if (bands & 1) this.nearRasters.push(e);
      if (bands & 2) this.farRasters.push(e);
    }
    for (const band of [1, 2] as const) {
      const tiles = band === 1 ? this.nearRasters : this.farRasters;
      if (!tiles.length) continue;
      this.setDepthBand(u, cam, band);
      for (const e of tiles) this.raster(e, e.value as Raster, cam);
    }
    this.updateSeams(cam, stream);
    if (!plan) this.drawSeams(cam);
    if (this.activeRegions.length) {
      this.images(this.idsInView);
      this.view(this.quads, cam);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.textureIndex);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textures);
      const u = this.quads.u;
      gl.uniform1i(u.uPalette ?? null, 1);
      gl.uniform1i(u.uTextureIndex ?? null, 4);
      gl.uniform1i(u.uTextures ?? null, 5);
      for (const pass of ['opaque', 'blend'] as const) {
        if (pass === 'blend') {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
        }
        const depth = (r: Region) => {
          const f = frame.flight;
          const x = r.x + regionColumns * 32 * this.voxelSize;
          const z = r.z + regionColumns * 32 * this.voxelSize;
          if (!f) return (x - cam.x) ** 2 + (z - cam.z) ** 2;
          const y = ((r.minY + r.maxY) * this.voxelSize) / 2;
          return (x - f.eyeX) * f.forwardX + (y - f.eyeY) * f.forwardY + (z - f.eyeZ) * f.forwardZ;
        };
        const sorted =
          pass === 'opaque'
            ? this.activeRegions
            : this.activeRegions.filter((r) => r.blend).sort((a, b) => depth(b) - depth(a));
        gl.uniform2f(u.uVoxel ?? null, this.voxelSize, pass === 'blend' ? 1 : 0);
        // All opaque surfaces populate depth before any translucent draw.
        // Blend the far slice first, then the near slice, each back to front.
        const bands = !frame.flight
          ? ([0] as const)
          : pass === 'blend'
            ? ([2, 1] as const)
            : ([1, 2] as const);
        for (const band of bands) {
          let configured = false;
          for (const region of sorted) {
            if (!region[pass] || (band && !(region.depthBands & band))) continue;
            const group = this.group(`${region.key}/${pass}`, region.entries, pass);
            group.used = this.frame;
            if (!group.count) continue;
            if (!configured) {
              this.setDepthBand(u, cam, band);
              configured = true;
            }
            gl.uniform3f(u.uOrigin ?? null, region.x - cam.x, -cam.y, region.z - cam.z);
            gl.bindVertexArray(group.vao);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, group.count);
          }
        }
      }
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    this.setDepthBand(u, cam, 0);
    this.trim();
  }
  getDebugDraws(perspective: boolean) {
    // A raster crossing the depth split is submitted twice but covers one tile.
    const surfaces = perspective
      ? new Set([...this.nearRasters, ...this.farRasters])
      : this.exposedRasters;
    let visibleSurfaces = 0;
    for (const entry of surfaces) if (entry.request.kind === 'surface') visibleSurfaces++;
    return {
      visibleSurfaces,
      visibleMeshes: this.activeRegions.reduce((total, region) => total + region.entries.length, 0),
    };
  }
  pick(cam: AtlasCamera, px: number, py: number) {
    return pickAtlas(
      this.drawn,
      cam.ray(px, py),
      this.voxelSize,
      cam.mode === 'fly' ? cam.far : 2 * cam.far,
      (x, z) => {
        const i = Math.floor((x - this.maskX) / (16 * this.maskStride)),
          j = Math.floor((z - this.maskZ) / (16 * this.maskStride));
        if (i < 0 || j < 0 || i >= this.maskWidth) return null;
        return this.maskBytes[j * this.maskWidth + i] ?? null;
      },
      cam.mode === 'fly' ? cam.near : 0,
      this.seamPages,
    );
  }
  private trim() {
    if (!this.budgetDirty) return;
    this.budgetDirty = false;
    let bytes = 0;
    for (const r of this.rasters.values()) bytes += r.bytes;
    for (const g of this.groups.values()) bytes += g.bytes;
    if (bytes <= gpuLimit && this.rasters.size + this.groups.size < 1400) return;
    const unused = [
      ...[...this.rasters].map(([key, v]) => ({ key, v, kind: 'r' })),
      ...[...this.groups].map(([key, v]) => ({ key, v, kind: 'g' })),
    ]
      .filter((c) => c.v.used < this.frame)
      .sort((a, b) => a.v.used - b.v.used);
    for (const c of unused) {
      if (c.kind === 'r') {
        this.gl.deleteTexture((c.v as ImageTile).tex);
        this.rasters.delete(c.key);
      } else {
        const g = c.v as VoxelGroup;
        this.gl.deleteBuffer(g.vbo);
        this.gl.deleteVertexArray(g.vao);
        this.groups.delete(c.key);
      }
      bytes -= c.v.bytes;
      if (bytes < gpuLimit * 0.85 && this.rasters.size + this.groups.size < 1200) break;
    }
  }
  destroy() {
    const gl = this.gl;
    this.disposed = true;
    this.imageBackoff.reset();
    for (const a of this.loadingImages.values()) a.abort();
    for (const gpu of this.rasters.values()) gl.deleteTexture(gpu.tex);
    for (const group of this.groups.values()) {
      gl.deleteBuffer(group.vbo);
      gl.deleteVertexArray(group.vao);
    }
    for (const g of this.grids.values()) {
      gl.deleteVertexArray(g.vao);
      gl.deleteBuffer(g.vbo);
      gl.deleteBuffer(g.ibo);
    }
    for (const t of [this.mask, this.palette, this.textureIndex, this.textures, this.biomes])
      gl.deleteTexture(t);
    for (const p of [this.terrain, this.quads, this.cover, this.seams]) gl.deleteProgram(p.program);
    for (const group of this.seamBuffers.values()) {
      gl.deleteBuffer(group.buffer);
      gl.deleteVertexArray(group.vao);
    }
    this.seamCache.destroy();
    gl.deleteVertexArray(this.coverVao);
    gl.deleteTexture(this.imageTile);
    gl.deleteFramebuffer(this.imageFramebuffer);
    gl.deleteBuffer(this.coverBuffer);
  }
}
