import { expect, it, vi } from 'vitest';
import { OpenworldTokenExpired } from './dashboard-api.js';
import { readOpenworldFactories } from './factories.js';

const native = {
  origin: 'http://fixture.test:24711',
  signal: new AbortController().signal,
  token: 'fixture-token',
};

it('reads the native simulation, scheduling, topology, flows and history in one authenticated snapshot', async () => {
  const top = {
    world: 'earth',
    face: 0,
    i: 166,
    j: 165,
    x: 2664,
    z: 2648,
    usPerS: 385.62,
    share: 0.413,
    nodes: 10,
    nets: 8,
  };
  const data = {
    enabled: true,
    paused: false,
    scope: 'world',
    targetHz: 20,
    hz: 20.0002,
    cappedHz: 20,
    speed: 1.00001,
    cpuMs: 0.036,
    lateMsP95: 0.4,
    debtMs: 0,
    droppedPerSecond: 0,
    duty: 0.0009,
    priority: -1,
    qos: 'user-interactive',
    stepMs: { mean: 0.047, p95: 0.06, max: 0.221 },
    phasesMs: {
      commands: 0.001,
      topology: 0.002,
      signals: 0.003,
      rotation: 0.004,
      electric: 0.005,
      fluids: 0.006,
      items: 0.007,
      radio: 0.008,
      events: 0,
    },
    steps: 1240,
    simSeconds: 62,
    uptimeSeconds: 62.1,
    counts: {
      nodes: 34,
      nets: 46,
      pieces: 489,
      frozen: 1,
      tooLong: 2,
      tripped: 0,
      byDevice: { pump: 10, signal_writer: 24 },
      byMedium: { item: 8, fluid: 10, electric: 6, signal: 14, rotation: 8 },
    },
    loadedColumns: 15,
    memory: {
      totalBytes: 8192,
      nodes: 960,
      links: 708,
      transit: 96,
      systems: 256,
      index: 704,
      topology: 3072,
      other: 2396,
    },
    power: { producedW: 708.5, usedW: 708.5, storedJ: 0, capacityJ: 0, systems: 2 },
    transit: { items: 3, fluidVoxels: 0, itemTypes: [{ name: 'Iron ore', count: 3 }] },
    rotation: { systems: 2, jammed: 1, deliveredW: 120.5 },
    radio: { emitters: 2, receivers: 3, channels: 1 },
    pumps: { count: 10, pumpedVoxels: 150, pendingTerrainVoxels: 0 },
    history: [
      { t: 1750000000.1, hz: 20.2, stepMs: 0.054, cpuMs: 0.042, nodes: 34 },
      { t: 1750000001.2, hz: 20, stepMs: 0.047, cpuMs: null, nodes: 34 },
    ],
    topColumns: [top],
  };
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      ...data,
      privateField: 'internal',
      history: data.history.map((point) => ({ ...point, privateField: 'internal' })),
      phasesMs: { ...data.phasesMs, privateField: 'internal' },
      transit: {
        ...data.transit,
        itemTypes: [{ ...data.transit.itemTypes[0], privateField: 'internal' }],
      },
      topColumns: [{ ...top, extra: 'undeclared' }],
    }),
  );
  expect(await readOpenworldFactories({ ...native, fetcher })).toEqual(data);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(new URL('/api/live/ovm', native.origin), {
    headers: { accept: 'application/json', 'X-OW-Token': native.token },
    redirect: 'error',
    signal: native.signal,
  });
});
it('preserves valid costs and zero counts when native coordinates are unmappable or absent', async () => {
  const data = {
    enabled: true,
    counts: { nodes: 0 },
    topColumns: [{ world: 'not /a planet', face: 8, i: -1, j: 0, usPerS: 50 }],
  };
  expect(
    await readOpenworldFactories({ ...native, fetcher: async () => Response.json(data) }),
  ).toEqual({
    enabled: true,
    counts: { nodes: 0 },
    topColumns: [{ world: null, face: null, i: null, j: 0, usPerS: 50 }],
  });
  for (const data of [{}, { enabled: false }, { enabled: true, paused: true, scope: 'loaded' }])
    expect(
      await readOpenworldFactories({ ...native, fetcher: async () => Response.json(data) }),
    ).toEqual(data);
});
it('keeps unsupported versions, token refresh and temporary failures distinct', async () => {
  const run = (response: Response) =>
    readOpenworldFactories({ ...native, fetcher: async () => response });
  await expect(run(new Response(null, { status: 401 }))).rejects.toBeInstanceOf(
    OpenworldTokenExpired,
  );
  await expect(run(new Response(null, { status: 404 }))).rejects.toMatchObject({
    code: 'game_request_unsupported',
  });
  await expect(run(new Response(null, { status: 503 }))).rejects.toMatchObject({
    code: 'game_not_ready',
  });
  await expect(run(Response.json({ topColumns: 'invalid' }))).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
  await expect(run(new Response('x'.repeat(2 * 1024 * 1024 + 1)))).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
});

it('requires a token before contacting the dashboard', async () => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(readOpenworldFactories({ ...native, token: '', fetcher })).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it('bounds breakdowns, item names and history received from the game', async () => {
  const inputs = [
    {
      counts: {
        byDevice: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`node_${i}`, 0])),
      },
    },
    { counts: { byMedium: { 'invalid/medium': 1 } } },
    { transit: { itemTypes: [{ name: 'x'.repeat(257), count: 1 }] } },
    { transit: { itemTypes: Array.from({ length: 1025 }, () => ({ name: 'ore', count: 0 })) } },
    { history: [{ t: 8_640_000_000_000_001 }] },
  ];
  for (const input of inputs) {
    await expect(
      readOpenworldFactories({ ...native, fetcher: async () => Response.json(input) }),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
  }
});

it('keeps the latest 600 native samples when a server retains a longer history', async () => {
  const history = Array.from({ length: 604 }, (_, t) => ({ t, nodes: 100 + t }));
  const { history: samples, hz } = await readOpenworldFactories({
    ...native,
    fetcher: async () => Response.json({ hz: 20, history }),
  });
  expect(hz).toBe(20);
  expect(samples).toHaveLength(600);
  expect(samples?.[0]).toEqual({ t: 4, nodes: 104 });
  expect(samples?.at(-1)).toEqual({ t: 603, nodes: 703 });
});
