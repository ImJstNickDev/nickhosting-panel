import { mountNative } from './native-view.mjs';

export async function mount(profile) {
  const host = document.querySelector('#scene');
  const fixture = await (await fetch(`/valley?radius=${profile.radius}`)).json();
  let controller,
    pending = 0,
    requests = 0,
    bytes = 0,
    lastLoad = 0;
  let draws = 0,
    triangles = 0,
    paintEvents = 0;
  let firstDataFrame = null,
    firstFocusMesh = null,
    firstRegionRequest = null;
  let gpuGl, timer, openQuery;
  const gpuQueries = [],
    gpuTimes = [];
  let measureGpu = false;
  const harvest = () => {
    if (!gpuGl || !timer) return;
    if (gpuGl.getParameter(timer.GPU_DISJOINT_EXT)) {
      for (const q of gpuQueries) gpuGl.deleteQuery(q);
      gpuQueries.length = 0;
      return;
    }
    while (
      gpuQueries.length &&
      gpuGl.getQueryParameter(gpuQueries[0], gpuGl.QUERY_RESULT_AVAILABLE)
    ) {
      const q = gpuQueries.shift();
      gpuTimes.push(gpuGl.getQueryParameter(q, gpuGl.QUERY_RESULT) / 1e6);
      gpuGl.deleteQuery(q);
    }
  };
  const meshKeys = new Set();
  let nativeReads = 0;
  const failures = [],
    placemarks = [];
  const glProbe = document.createElement('canvas').getContext('webgl2');
  if (!glProbe) throw Error('WebGL2 unavailable');
  const gpu = glProbe.getParameter(
    glProbe.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL,
  );
  glProbe.getExtension('WEBGL_lose_context')?.loseContext();
  const prototype = WebGL2RenderingContext.prototype;
  for (const [method, countAt, instanceAt] of [
    ['drawElements', 1, 0],
    ['drawArrays', 2, 0],
    ['drawElementsInstanced', 1, 4],
    ['drawArraysInstanced', 2, 3],
  ]) {
    const original = prototype[method];
    prototype[method] = function (...args) {
      if (measureGpu && !openQuery) {
        if (!gpuGl) {
          gpuGl = this;
          timer = this.getExtension('EXT_disjoint_timer_query_webgl2');
        }
        if (timer) {
          harvest();
          openQuery = this.createQuery();
          this.beginQuery(timer.TIME_ELAPSED_EXT, openQuery);
        }
      }
      draws++;
      const primitive = args[0],
        count = args[countAt],
        instances = instanceAt ? args[instanceAt] : 1;
      if (primitive === this.TRIANGLES) triangles += Math.floor(count / 3) * instances;
      else if (primitive === this.TRIANGLE_STRIP || primitive === this.TRIANGLE_FAN)
        triangles += Math.max(0, count - 2) * instances;
      return original.apply(this, args);
    };
  }
  const dataCtxt = CanvasRenderingContext2D.prototype,
    drawImage = dataCtxt.drawImage;
  dataCtxt.drawImage = function (...args) {
    if (this.canvas.parentElement) paintEvents++;
    return drawImage.apply(this, args);
  };
  async function binary(kind, params, signal) {
    firstRegionRequest ??= performance.now();
    pending++;
    requests++;
    nativeReads += kind === 'meshes' ? params.cells.split(';').length : 1;
    try {
      const q = new URLSearchParams({ ...params, radius: profile.radius });
      const res = await fetch(`/fixture/${kind}?${q}`, { signal });
      if (!res.ok) throw Error(`Unexpected fixture status ${res.status}`);
      const buffer = await res.arrayBuffer();
      if (kind === 'mesh') meshKeys.add(`${params.i}/${params.j}`);
      bytes += buffer.byteLength;
      return buffer;
    } catch (e) {
      if (e.name !== 'AbortError') failures.push(String(e));
      throw e;
    } finally {
      pending--;
      lastLoad = performance.now();
    }
  }
  const started = performance.now();
  function drew() {
    if (openQuery) {
      gpuGl.endQuery(timer.TIME_ELAPSED_EXT);
      gpuQueries.push(openQuery);
      openQuery = null;
    }
    if (
      controller &&
      firstRegionRequest !== null &&
      (firstDataFrame === null || (profile.mode !== 'plan' && firstFocusMesh === null))
    ) {
      const detail = controller.coverage();
      if (
        firstDataFrame === null &&
        (detail.samples || detail.near.length) &&
        (draws || paintEvents)
      )
        firstDataFrame = performance.now() - firstRegionRequest;
      if (firstFocusMesh === null && detail.near.some(([i, j]) => i === 16 && j === 16))
        firstFocusMesh = performance.now() - firstRegionRequest;
    }
    if (controller)
      for (const { node, x, y, z } of placemarks) {
        const at = controller.project(x, z, y);
        node.style.transform = `translate(${Math.round(at.x)}px,${Math.round(at.y)}px)`;
      }
  }
  if (profile.renderer === 'native') {
    controller = await mountNative(host, profile, fixture, binary, drew);
  } else {
    const { AtlasScene } = await import('/src/integrations/openworld/atlas-scene.ts');
    const { decodeAtlasMeshes } = await import('/src/integrations/openworld/map-atlas-data.ts');
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    const atlas = new AtlasScene(canvas, {
      face: 0,
      edge: fixture.edge,
      initialView: { x: profile.x, z: profile.z, span: profile.span },
      load: (r, signal) => binary(r.kind, r, signal),
      loadTexture: async (id, signal) => (await fetch(`/material.png?id=${id}`, { signal })).blob(),
      loadMeshes: async (reqs, signal) => {
        const cells = reqs.map((r) => `${r.i},${r.j}`).join(';');
        const raw = await binary('meshes', { cells, lod: reqs[0].lod }, signal);
        const data = decodeAtlasMeshes(raw, reqs);
        for (let i = 0; i < reqs.length; i++)
          if (data[i]) meshKeys.add(`${reqs[i].i}/${reqs[i].j}`);
        return data;
      },
      onFrame: drew,
      onUnavailable: () => failures.push('WebGL unavailable'),
      onError: (e) => failures.push(String(e)),
    });
    // Both camera controllers normally infer a slightly different target elevation
    // at coarse LOD. Fix that one measurement input immediately before projection.
    const draw = atlas.gpu.draw.bind(atlas.gpu);
    let lockAltitude = true;
    atlas.gpu.draw = (camera, stream) => {
      if (lockAltitude) camera.y = 35;
      return draw(camera, stream);
    };
    atlas.setPalette(fixture.materials);
    atlas.setCoverage(fixture.columns);
    atlas.setMode(profile.mode);
    if (profile.mode === 'fly') {
      // Set up a real fly camera with its eye below the deck; the normal drag input looks upward.
      window.pickBridgeCeiling = () => atlas.pick(120, 40);
      window.prepareBridgeInspection = async () => {
        lockAltitude = false;
        atlas.setView({ x: 260, z: 252, span: 12 });
        for (let i = 0; i < 14; i++) await new Promise((r) => requestAnimationFrame(r));
        const c = atlas.camera;
        const eyeY = c.y - c.basis.forward[1] * c.distance;
        atlas.move(0, 0, 27 - eyeY);
        return {
          eye: [
            c.x - c.basis.forward[0] * c.distance,
            c.y - c.basis.forward[1] * c.distance,
            c.z - c.basis.forward[2] * c.distance,
          ],
          deckBottom: 33.5,
        };
      };
    }
    controller = {
      move: (x, z) => atlas.setView({ x, z, span: profile.span }),
      project: (x, z, y) => atlas.project(x, z, y),
      coverage: () => {
        const detailed = new Map();
        for (const { request, value } of atlas.stream.visible) {
          if (
            request.kind !== 'mesh' ||
            value?.kind !== 'quads' ||
            (!value.opaque.length && !value.blend.length)
          )
            continue;
          const key = `${request.i}/${request.j}`,
            prev = detailed.get(key);
          if (!prev || prev[2] > request.lod)
            detailed.set(key, [request.i, request.j, request.lod]);
        }
        return {
          near: [...detailed.values()],
          samples: atlas.stream.visible.filter((e) => e.value?.kind === 'raster').length,
        };
      },
    };
  }
  for (const m of fixture.markers) {
    const node = document.createElement('span');
    node.className = 'pin';
    node.title = m.name;
    document.querySelector('#markers').appendChild(node);
    placemarks.push({ ...m, node });
  }
  const tick = () => new Promise((resolve) => requestAnimationFrame(resolve));
  async function settle() {
    const begin = performance.now();
    let lastActivity = begin,
      signature = '';
    // Wait for both network completion and stable output from deferred mesh workers.
    while (performance.now() - begin < 30000) {
      const now = await tick();
      if (failures.length) throw Error(failures.join(','));
      const counts = `${requests}/${bytes}`;
      if (signature !== counts) {
        signature = counts;
        lastActivity = now;
      }
      if (
        pending === 0 &&
        requests > 0 &&
        firstDataFrame !== null &&
        now - Math.max(lastActivity, lastLoad) > 550
      )
        return performance.now() - started;
    }
    throw Error(
      `Scene did not settle: ${JSON.stringify({ requests, pending, firstDataFrame, failures })}`,
    );
  }
  async function pass() {
    const elapsed = [],
      dispatches = [],
      prims = [];
    const before = { requests, bytes, draws, triangles };
    let prev = await tick(),
      begun = prev,
      priorDraws = draws,
      priorTriangles = triangles;
    for (;;) {
      const t = await tick(),
        dt = t - prev,
        u = Math.min(1, (t - begun) / profile.duration);
      elapsed.push(dt);
      dispatches.push(draws - priorDraws);
      prims.push(triangles - priorTriangles);
      priorDraws = draws;
      priorTriangles = triangles;
      prev = t;
      controller.move(
        profile.x + profile.travel * Math.sin(2 * Math.PI * u),
        profile.z + (profile.travel / 2) * Math.sin(4 * Math.PI * u),
      );
      if (u === 1) break;
    }
    const percentile = (series, p) =>
      series.toSorted((a, b) => a - b)[Math.ceil(series.length * p) - 1] ?? 0;
    return {
      frames: elapsed.length,
      p50: percentile(elapsed, 0.5),
      p95: percentile(elapsed, 0.95),
      p99: percentile(elapsed, 0.99),
      worst: Math.max(...elapsed),
      stalls50: elapsed.filter((v) => v > 50).length,
      drawCallsP50: percentile(
        dispatches.filter((v) => v > 0),
        0.5,
      ),
      trianglesP50: percentile(
        prims.filter((v) => v > 0),
        0.5,
      ),
      requests: requests - before.requests,
      bytes: bytes - before.bytes,
    };
  }
  const cold = await pass(),
    settled = await settle(),
    coldTotals = { requests, bytes },
    warm = await pass();
  await settle();
  const c = controller.coverage();
  if (profile.mode !== 'plan') {
    // Timestamp queries happen after both measured passes, so they cannot stall the frame sample.
    measureGpu = true;
    for (let frame = 0; frame <= 60; frame++) {
      controller.move(
        profile.x + profile.travel * Math.sin((2 * Math.PI * frame) / 60),
        profile.z + (profile.travel / 2) * Math.sin((4 * Math.PI * frame) / 60),
      );
      await tick();
    }
    measureGpu = false;
    for (let i = 0; i < 6 && gpuQueries.length; i++) {
      await tick();
      harvest();
    }
  }
  const landmarks = fixture.markers.map((m) => {
    const p = controller.project(m.x, m.z, m.y);
    return { name: m.name, x: Math.round(p.x), y: Math.round(p.y) };
  });
  const hist = {};
  const selected = new Set(c.near.map(([i, j]) => `${i}/${j}`));
  const missing = fixture.columns.filter(([i, j]) => !selected.has(`${i}/${j}`));
  const fullRadius = missing.reduce(
    (m, [i, j]) =>
      Math.min(
        m,
        Math.hypot(
          Math.max(0, Math.abs((i + 0.5) * 16 - profile.x) - 8),
          Math.max(0, Math.abs((j + 0.5) * 16 - profile.z) - 8),
        ),
      ),
    profile.radius * 16,
  );
  for (const [, , lod] of c.near ?? []) hist[lod] = (hist[lod] ?? 0) + 1;
  const canvas = host.querySelector('canvas');
  if (canvas.width !== 800 || canvas.height !== 480)
    throw Error(`Drawing buffer size mismatch: ${canvas.width}x${canvas.height}`);
  return {
    gpu,
    firstDataFrameMs: firstDataFrame,
    firstCenterMeshMs: firstFocusMesh,
    gpuDrawP50Ms: gpuTimes.length
      ? gpuTimes.sort((a, b) => a - b)[Math.floor(gpuTimes.length / 2)]
      : null,
    gpuSamples: gpuTimes.length,
    settledMs: settled,
    cold,
    coldTotals,
    warm,
    requests,
    bytes,
    textureReads: performance
      .getEntriesByType('resource')
      .filter((e) => e.name.includes('/material.png')).length,
    textureBytes: performance
      .getEntriesByType('resource')
      .filter((e) => e.name.includes('/material.png'))
      .reduce((sum, e) => sum + e.encodedBodySize, 0),
    nativeReads,
    knownColumns: fixture.columns.length,
    meshColumns: meshKeys.size,
    visibleMeshes: c.near?.length,
    meshLods: hist,
    completeMeshRadiusMeters: fullRadius,
    landmarks,
    checkpoints: placemarks.length,
    failures,
    cssSize: [host.clientWidth, host.clientHeight],
  };
}
