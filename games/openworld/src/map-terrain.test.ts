import { expect, it, vi } from 'vitest';
import { readMapMeshBinary, readMapSurfaceBinary } from './map-binary.js';
import {
  readMapChanges,
  readMapColumns,
  readMapIndex,
  readMapPlayers,
  readMapTile,
} from './map-terrain.js';

function fixture(body: Response) {
  return {
    origin: 'http://fixture.example.test:24711',
    token: 'test-token',
    signal: AbortSignal.timeout(5000),
    fetcher: vi.fn<typeof fetch>(async () => body),
  };
}

it.each(['surface', 'mesh'] as const)(
  'distinguishes native %s deadlines from invalid data and absence',
  async (kind) => {
    const read = (f: ReturnType<typeof fixture>) =>
      kind === 'mesh'
        ? readMapMeshBinary(f, { world: 'earth', face: 0, i: 0, j: 0, lod: 0 })
        : readMapSurfaceBinary(f, { world: 'earth', face: 0, ci: 0, cj: 0, lod: 5, n: 2 });
    const expired = fixture(new Response());
    expired.signal = AbortSignal.abort(new DOMException('expired', 'TimeoutError'));
    expired.fetcher.mockImplementation(async (_, init) => {
      init?.signal?.throwIfAborted();
      throw new Error('expected signal');
    });
    for (const source of [expired, fixture(new Response(null, { status: 504 }))]) {
      await expect(read(source)).rejects.toMatchObject({
        code: 'game_request_timeout',
        status: 504,
      });
    }
    expired.signal = AbortSignal.abort();
    await expect(read(expired)).rejects.toMatchObject({ code: 'integration_unavailable' });
    for (const [status, code] of [
      [503, 'game_not_ready'],
      [429, 'rate_limited'],
      [403, 'game_authentication_failed'],
    ] as const)
      await expect(read(fixture(new Response(null, { status })))).rejects.toMatchObject({
        code,
        status,
      });
    await expect(read(fixture(new Response(new Uint8Array(4))))).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
    expect(await read(fixture(new Response(null, { status: 404 })))).toBeNull();
  },
);

it('passes world keys as data and decodes little endian columns and revision deltas', async () => {
  const native = fixture(
    Response.json({ stamp: 1, faces: [{ face: 3, count: 1, i0: 123, j0: 0, i1: 123, j1: 0 }] }),
  );
  const index = await readMapIndex(native, 'earth&face=0');
  expect(index.faces[0]?.i0).toBe(123);
  const [url, init] = native.fetcher.mock.calls[0] ?? [];
  expect(new URL(String(url)).searchParams.get('world')).toBe('earth&face=0');
  expect(init?.redirect).toBe('error');
  const buf = new ArrayBuffer(8);
  new DataView(buf).setInt32(0, 90436, true);
  expect(await readMapColumns(fixture(new Response(buf)), 'earth', 3)).toEqual({
    columns: [[90436, 0]],
  });
  const delta = { stamp: 3, reset: false, columns: [[3, 90436, 0, 123]] };
  expect(await readMapChanges(fixture(Response.json(delta)), 'earth', 1)).toEqual({
    ...delta,
    columns: [[3, 90436, 0]],
  });
});
it.each([1, 2])(
  'projects only explored samples for OWMS v%i at the requested position',
  async (version) => {
    const len = version === 1 ? 80 : 96,
      buf = new ArrayBuffer(32 + 64 * 4 + len),
      v = new DataView(buf);
    v.setUint32(0, 0x4f574d53);
    v.setUint16(4, version, true);
    v.setUint16(6, 4, true);
    v.setInt32(8, 3, true);
    v.setInt32(12, 8, true);
    v.setInt32(16, 24, true);
    v.setUint16(20, 8, true);
    v.setUint16(22, 4, true);
    const marker = 32 + 10 * 4;
    v.setUint32(marker, 1, true);
    v.setUint16(marker + 4, 424, true);
    v.setUint8(marker + 4 + 64, 2);
    const native = fixture(new Response(buf));
    const tile = await readMapTile(native, 'moon', 3, 8, 24);
    expect(tile.samples).toHaveLength(1024);
    expect(tile.samples.filter((n) => n !== -1)).toHaveLength(16);
    expect(tile.samples[4 * 32 + 8]).toBeGreaterThan(0);
    expect(tile.samples[4 * 32 + 7]).toBe(-1);
    expect(tile.samples[4 * 32 + 8]).not.toBe(tile.samples[4 * 32 + 9]);
    expect(new URL(String(native.fetcher.mock.calls[0]?.[0])).searchParams.get('n')).toBe('8');
    await expect(
      readMapTile(fixture(new Response(buf.slice(0, -1))), 'moon', 3, 8, 24),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
    await expect(readMapTile(fixture(new Response(buf)), 'moon', 2, 8, 24)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
  },
);
it('keeps unknown terrain separate from game failures and rejects invalid requests before forwarding', async () => {
  const missing = await readMapTile(
    fixture(new Response(null, { status: 404 })),
    'earth',
    1,
    32,
    40,
  );
  expect(missing.samples.every((v) => v === -1)).toBe(true);
  for (const status of [401, 500])
    await expect(
      readMapTile(fixture(new Response(null, { status })), 'earth', 0, 0, 0),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
  const f = fixture(new Response(new Uint8Array(12)));
  await expect(readMapTile(f, 'earth', 0, 3, 0)).rejects.toMatchObject({
    code: 'validation_failed',
  });
  await expect(readMapChanges(f, 'earth', -1)).rejects.toMatchObject({ code: 'validation_failed' });
  expect(f.fetcher).not.toHaveBeenCalled();
  await expect(readMapColumns(f, 'earth', 0)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
});
it('projects the located players from one roster read with a reconnect guard and no other details', async () => {
  const player = {
    name: 'Ada',
    id: 0,
    world: 'moon',
    pos: { face: 2, x: 0, z: 32 },
    account: 'hidden',
    connectedS: 30,
  };
  const f = fixture(
    Response.json({
      players: [player, { ...player, id: 1, inSpace: true }, { name: 'Connecting', id: 2 }],
    }),
  );
  const { players } = await readMapPlayers(f);
  expect(players).toHaveLength(1);
  expect(players[0]).toEqual({
    id: 0,
    name: 'Ada',
    world: 'moon',
    face: 2,
    x: 0,
    z: 32,
    joinedAt: expect.any(Number),
  });
  expect(Math.abs((players[0]?.joinedAt ?? 0) - (Date.now() - 30000))).toBeLessThan(1000);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

it('preserves an outlying int32 column in the index, binary footprint and delta', async () => {
  const i = 13000007,
    j = 980011;
  const face = { face: 0, count: 500, i0: 42000, j0: 75000, i1: i, j1: j };
  expect(
    (await readMapIndex(fixture(Response.json({ stamp: 500, faces: [face] })), 'earth')).faces,
  ).toEqual([face]);
  const bytes = new ArrayBuffer(16),
    view = new DataView(bytes);
  for (const [index, n] of [i, j, 2147483647, 2147483647].entries())
    view.setInt32(index * 4, n, true);
  expect((await readMapColumns(fixture(new Response(bytes)), 'earth', 0)).columns).toEqual([
    [i, j],
    [2147483647, 2147483647],
  ]);
  const delta = { stamp: 501, reset: false, columns: [[0, i, j]] };
  expect(await readMapChanges(fixture(Response.json(delta)), 'earth', 500)).toEqual(delta);
});
it('recognizes an indexed tile outside the native face as unknown; unrelated rejections remain visible', async () => {
  const ci = 13000000,
    cj = 980008;
  for (const [axis, value] of [
    ['ci', ci],
    ['cj', cj],
  ]) {
    const response = Response.json(
      { error: `paramètre « ${axis} » hors de [0, 90436] : ${value}` },
      { status: 400 },
    );
    const tile = await readMapTile(fixture(response), 'earth', 0, ci, cj);
    expect(tile.samples.every((v) => v === -1)).toBe(true);
  }
  for (const message of ['unknown world', 'paramètre « ci » hors de [0, 800] : 888']) {
    await expect(
      readMapTile(fixture(Response.json({ error: message }, { status: 400 })), 'earth', 0, ci, cj),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
  }
  const f = fixture(new Response());
  await expect(readMapTile(f, 'earth', 0, 2147483648, 0)).rejects.toMatchObject({
    code: 'validation_failed',
  });
  expect(f.fetcher).not.toHaveBeenCalled();
});
