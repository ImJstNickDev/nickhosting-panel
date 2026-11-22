import { AtlasBackoff } from './atlas-backoff.js';
import type { AtlasCamera } from './atlas-camera.js';
import { type QuadBatch, type Raster, regionColumns } from './atlas-geometry.js';
import { pickAtlas } from './atlas-pick.js';
import {
  coverageFragment,
  coverageVertex,
  quadFragment,
  quadVertex,
  terrainFragment,
  terrainVertex,
} from './atlas-shaders.js';
import type { AtlasStream, Entry } from './atlas-stream.js';
import type { AtlasMaterial, AtlasOptions, AtlasSeedStyle } from './atlas-types.js';

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
  signature: string;
  vbo: WebGLBuffer | null;
  vao: WebGLVertexArrayObject | null;
  count: number;
  bytes: number;
  used: number;
};
const rgb = (hex: string) =>
  /^#[a-f\d]{6}$/i.test(hex) ? Number.parseInt(hex.slice(1), 16) : 0x7d827e;
const gpuLimit = 96 * 1024 * 1024;
export class AtlasGpu {
  private readonly terrain;
  private readonly quads;
  private readonly cover;
  private readonly mask;
  private readonly palette;
  private readonly biomes;
  private readonly textureIndex;
  private readonly textures;
  private readonly slots: number;
  private readonly grids = new Map<number, ReturnType<typeof grid>>();
  private readonly rasters = new Map<string, ImageTile>();
  private readonly groups = new Map<string, VoxelGroup>();
  private readonly materialStatus = new Map<number, AtlasMaterial>();
  private readonly loadedImages = new Map<number, number>();
  private readonly loadingImages = new Map<number, AbortController>();
  private readonly imageBackoff: AtlasBackoff;
  private readonly failedImages = new Set<number>();
  private readonly textureLut = new Float32Array(256 * 256 * 2);
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
    this.terrain = pipeline(gl, terrainVertex, terrainFragment);
    this.quads = pipeline(gl, quadVertex, quadFragment);
    this.cover = pipeline(gl, coverageVertex, coverageFragment);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.mask = texture(gl, gl.R8UI, 1, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(1));
    this.palette = texture(gl, gl.RGBA8, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.biomes = texture(gl, gl.RGBA8, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.textureIndex = texture(gl, gl.RG32F, 256, 256, gl.RG, gl.FLOAT, this.textureLut);
    this.textures = gl.createTexture();
    this.slots = Math.min(512, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textures);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 6, gl.RGBA8, 32, 32, this.slots);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
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
      colors[p + 3] = 255;
      this.textureLut[m.id * 2 + 1] = m.tileMeters && m.tileMeters > 0 ? m.tileMeters : 1;
      this.materialStatus.set(m.id, m);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.palette);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, colors);
    this.voxelSize = voxel;
    this.syncTextureIndex();
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
  private syncTextureIndex() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.textureIndex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 256, gl.RG, gl.FLOAT, this.textureLut);
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
          });
          if (this.disposed || ac.signal.aborted) return;
          let slot = this.loadedImages.size;
          if (slot >= this.slots) {
            const unused = [...this.loadedImages.keys()].find((k) => !ids.has(k));
            if (unused === undefined) return;
            slot = this.loadedImages.get(unused) ?? 0;
            this.loadedImages.delete(unused);
            this.textureLut[unused * 2] = 0;
          }
          const gl = this.gl;
          gl.activeTexture(gl.TEXTURE5);
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textures);
          gl.texSubImage3D(
            gl.TEXTURE_2D_ARRAY,
            0,
            0,
            0,
            slot,
            32,
            32,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            bitmap,
          );
          gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
          this.loadedImages.set(id, slot);
          this.textureLut[id * 2] = slot + 1;
          this.syncTextureIndex();
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
  private coverage(cam: AtlasCamera, stream: AtlasStream) {
    const gl = this.gl;
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
    if (cam.mode !== 'plan' || !this.coverSize) return;
    this.view(this.cover, cam);
    gl.bindVertexArray(this.coverVao);
    gl.uniform1f(this.cover.u.uStride ?? null, stream.stride);
    gl.uniform3f(this.cover.u.uOrigin ?? null, -cam.x, 0, -cam.z);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.coverSize);
  }
  private uploadMask(cam: AtlasCamera, stream: AtlasStream, rasters: Entry[], meshes: Entry[]) {
    const b = cam.getFrame().bounds;
    const stride =
      2 ** Math.max(0, Math.ceil(Math.log2(Math.max(b.i1 - b.i0 + 1, b.j1 - b.j0 + 1) / 480)));
    const xi = Math.floor(b.i0 / (16 * stride)) * 16 * stride,
      zj = Math.floor(b.j0 / (16 * stride)) * 16 * stride;
    const width = Math.ceil((b.i1 + 1 - xi) / (16 * stride)) * 16,
      height = Math.ceil((b.j1 + 1 - zj) / (16 * stride)) * 16;
    const signature = [
      xi,
      zj,
      width,
      height,
      stride,
      stream.generation,
      cam.mode === 'plan',
      rasters.map((e) => e.serial).join(','),
      meshes.map((e) => e.serial).join(','),
    ].join('/');
    if (this.maskSignature === signature) return;
    this.maskSignature = signature;
    this.maskX = xi * 16;
    this.maskZ = zj * 16;
    this.maskStride = stride;
    const bytes = new Uint8Array(width * height);
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
      for (const [i, j] of stream.columns) {
        const s = stream.stride;
        if (i + s <= xi || j + s <= zj || i >= xi + width * stride || j >= zj + height * stride)
          continue;
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
      }
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
    this.maskBytes = bytes;
    this.maskWidth = width;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
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
  private group(key: string, entries: Entry[], pass: 'opaque' | 'blend') {
    let group = this.groups.get(key);
    const signature = entries.map((e) => e.serial).join(',');
    if (group?.signature === signature) {
      group.used = this.frame;
      return group;
    }
    const gl = this.gl;
    if (!group) {
      group = {
        vao: gl.createVertexArray(),
        vbo: gl.createBuffer(),
        signature: '',
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
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, group.vbo);
    const size = entries.reduce((sum, e) => sum + (e.value as QuadBatch)[pass].byteLength, 0);
    gl.bufferData(gl.ARRAY_BUFFER, size, gl.DYNAMIC_DRAW);
    let offset = 0;
    for (const entry of entries) {
      const quads = (entry.value as QuadBatch)[pass];
      if (!quads.length) continue;
      gl.bufferSubData(gl.ARRAY_BUFFER, offset, quads);
      offset += quads.byteLength;
    }
    group.count = size / 16;
    group.bytes = size;
    group.signature = signature;
    group.used = this.frame;
    return group;
  }
  draw(cam: AtlasCamera, stream: AtlasStream) {
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
    const bestMeshes = new Map<string, Entry>(),
      rasters: Entry[] = [];
    for (const e of stream.visible) {
      const r = e.request;
      if (r.kind === 'mesh') {
        const key = `${r.i},${r.j}`,
          p = bestMeshes.get(key);
        if (!p || (p.request.kind === 'mesh' && r.lod < p.request.lod)) bestMeshes.set(key, e);
      } else if (e.value?.kind === 'raster') rasters.push(e);
    }
    // Display the true surface even if a valid mesh has no quads at a requested LOD.
    const meshes = [...bestMeshes.values()].filter(
      (e) => e.value?.kind === 'quads' && (e.value.opaque.length || e.value.blend.length),
    );
    this.drawn = [...meshes];
    this.uploadMask(cam, stream, rasters, meshes);
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
    rasters.sort((a, b) => {
      const x = a.value as Raster,
        y = b.value as Raster;
      return Number(y.seed) - Number(x.seed) || y.mpp - x.mpp;
    });
    for (const e of rasters) {
      const raster = e.value as Raster;
      if (this.exposed(e, raster)) {
        this.drawn.push(e);
        this.raster(e, raster, cam);
      }
    }
    if (meshes.length) {
      const groups = new Map<string, Entry[]>(),
        ids = new Set<number>();
      for (const e of meshes) {
        const v = e.value as QuadBatch,
          key = `${v.regionX}:${v.regionZ}`;
        const list = groups.get(key);
        if (list) list.push(e);
        else groups.set(key, [e]);
        for (const id of v.materials) ids.add(id);
      }
      this.images(ids);
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
        const sorted =
          pass === 'opaque'
            ? groups.entries()
            : [...groups.entries()].sort(([, a], [, b]) => {
                const d = (e: Entry | undefined) => {
                  if (!e) return 0;
                  const q = e.value as QuadBatch;
                  return Math.hypot(
                    (q.regionX + regionColumns / 2) * 16 - cam.x,
                    (q.regionZ + regionColumns / 2) * 16 - cam.z,
                  );
                };
                return d(b[0]) - d(a[0]);
              });
        gl.uniform2f(u.uVoxel ?? null, this.voxelSize, pass === 'blend' ? 1 : 0);
        for (const [key, list] of sorted) {
          const group = this.group(`${key}/${pass}`, list, pass);
          if (!group.count) continue;
          const v = list[0]?.value;
          if (v?.kind !== 'quads') continue;
          gl.uniform3f(u.uOrigin ?? null, v.regionX * 16 - cam.x, -cam.y, v.regionZ * 16 - cam.z);
          gl.bindVertexArray(group.vao);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, group.count);
        }
      }
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    this.trim();
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
    );
  }
  private trim() {
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
    for (const p of [this.terrain, this.quads, this.cover]) gl.deleteProgram(p.program);
    gl.deleteVertexArray(this.coverVao);
    gl.deleteBuffer(this.coverBuffer);
  }
}
