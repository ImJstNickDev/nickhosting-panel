// This adapter imports a locally installed official server. No game assets are redistributed.
export async function mountNative(host, profile, fixture, binary, drew) {
  const [{ MapData }, { Plan2D }, { Scene3D }, { makeLook }] = await Promise.all([
    import('/reference/map/mapdata.js'),
    import('/reference/map/plan2d.js'),
    import('/reference/map/scene3d.js'),
    import('/reference/map/paint.js'),
  ]);
  const mode = profile.mode === 'fly' ? '3d' : profile.mode;
  const data = new MapData({
    getBinary: (url, params, signal) => binary(url.split('/').pop(), params, signal),
  });
  data.setWorld({ key: 'earth', faceEdgeMeters: fixture.edge, seaLevelMeters: 17 });
  // Both views receive the same already-authorized index and palette before the timed first region load.
  data.materials = fixture.materials.map((m) => ({
    ...m,
    texture: m.textured ? `/material.png?id=${m.id}` : null,
    rgb: [1, 3, 5].map((n) => Number.parseInt(m.color.substring(n, n + 2), 16)),
  }));
  data.matVersion++;
  const look = makeLook(data.materials);
  const items = fixture.columns;
  data.index = {
    faces: [
      {
        face: 0,
        count: items.length,
        i0: 16 - profile.radius,
        j0: 16 - profile.radius,
        i1: 15 + profile.radius,
        j1: 15 + profile.radius,
      },
    ],
  };
  // Feed column membership through the native column decoder as in a real map.
  const net = data.net;
  data.net = { ...net, getBinary: () => Promise.resolve(new Int32Array(items.flat()).buffer) };
  await data.loadColumns(0);
  data.net = net;
  const view = {
    world: 'earth',
    face: 0,
    cx: profile.x,
    cz: profile.z,
    mpp: profile.span / host.clientWidth,
    ty: 35,
    // Openworld measures azimuth from the target toward the camera.
    az: (7 * Math.PI) / 4,
    el3d: Math.PI / 6,
    mode,
  };
  let scene;
  const app = {
    view,
    data,
    layers: {},
    sky: {},
    creatures: { list: [], version: 0 },
    checkpoints: { list: [] },
    followPos: () => null,
    sel: null,
    follow: null,
    atmosphere: true,
    look: () => look,
    hooks: {
      afterFrame: drew,
      requestRender: () => scene.requestRender(),
      onScale() {},
      onCursor() {},
      onUserMove() {},
    },
  };
  // Frame invalidation is normally wired by the native dashboard's world-map pane.
  scene = mode === 'plan' ? new Plan2D(host, app) : new Scene3D(host, app);
  for (const event of ['block', 'materials', 'columns', 'index'])
    data.on(event, () => scene.requestRender());
  if (mode !== 'plan') {
    const update = scene.updateCamera.bind(scene);
    scene.updateCamera = () => {
      view.ty = 35;
      return update();
    };
    scene.setMode(mode);
  }
  scene.setActive(true);
  return {
    move(x, z) {
      view.cx = x;
      view.cz = z;
      scene.requestRender();
    },
    project(x, z, y) {
      return mode !== 'plan'
        ? scene.project(x, y, z)
        : { x: scene.sx(x), y: scene.sy(z), visible: true };
    },
    coverage() {
      return {
        near: Array.from(scene.columns?.shown ?? [], (e) => [e.i, e.j, e.lod]),
        quads: scene.columns?.stats.quads,
        samples: data.blocks.size,
      };
    },
  };
}
