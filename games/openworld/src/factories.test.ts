import { expect, it, vi } from 'vitest';
import { OpenworldTokenExpired } from './dashboard-api.js';
import { readOpenworldFactories } from './factories.js';

const native = {
  origin: 'http://fixture.test:24711',
  signal: new AbortController().signal,
  token: 'fixture-token',
};

it('reads the OVM snapshot once with native authentication and projects diagnostic fields', async () => {
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
    stepMs: { mean: 0.047, p95: 0.06, max: 0.221 },
    counts: { nodes: 34, nets: 46, pieces: 489 },
    power: { producedW: 708.5, usedW: 708.5, storedJ: 0, capacityJ: 0 },
    transit: { items: 0, fluidVoxels: 0 },
    topColumns: [top],
  };
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      ...data,
      history: [{ tick: 12 }],
      counts: { ...data.counts, byDevice: { pump: 1 } },
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
