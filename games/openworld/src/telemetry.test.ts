import { expect, it, vi } from 'vitest';
import {
  OpenworldTokenExpired,
  openworldDashboardToken,
  readOpenworldTelemetry,
} from './dashboard-api.js';
import { openworldTelemetrySchemas } from './telemetry.js';

const target = 'http://fixture.example.test:24711';
const signal = new AbortController().signal;

const nativePlayer = {
  id: 17,
  name: 'Ada',
  state: 'playing',
  admitted: true,
  mode: 'creative',
  world: 'earth',
  connectedS: 35,
  address: 'private address',
  account: 'fixture-account',
  accountVerified: true,
  skinHead: '/api/live/skin?id=17&h=12ABCDEF&view=head',
  skinBody: 'https://untrusted.example.test/skin',
  screenshots: ['capture'],
  geo: { lon: 10, lat: 20, alt: 90 },
  pos: { face: 0, x: 100, y: 90, z: 200 },
  pingMs: 33,
  heldItem: { name: 'Stone', count: 2, icon: 'data:image/mock' },
  client: { fps: 60, address: 'private address' },
  vitals: { health: 20, maxHealth: 100, air: 40 },
  inventoryKnown: true,
  inventory: {
    selected: 1,
    reportedAgoS: 0.3,
    hotbar: [null, { name: 'Stone', count: 2, icon: 'data:image/mock' }],
    bag: [],
  },
  armor: [{ name: 'Helmet', slot: 'helmet', wearPct: 10, icon: 'data:image/mock' }],
  record: { joins: 3, blocksBroken: 15, lastIp: 'private address' },
  net: { peer: 'private address' },
};

it('keeps unsupported native timestamps out of browser date formatting', () => {
  for (const invalid of [-1, 2 ** 63]) {
    expect(openworldTelemetrySchemas.history.safeParse({ t: [invalid], tps: [20] }).success).toBe(
      false,
    );
    expect(
      openworldTelemetrySchemas.player.parse({
        ...nativePlayer,
        record: { joins: 3, firstSeenMs: invalid },
      }).record,
    ).toEqual({ joins: 3, firstSeenMs: null });
  }
});

it('projects only a verified account for roster reconciliation and strips native references', () => {
  const roster = openworldTelemetrySchemas.players.parse({ players: [nativePlayer] });
  expect(roster.players[0]).toEqual({
    account: 'fixture-account',
    accountVerified: true,
    id: 17,
    name: 'Ada',
    state: 'playing',
    admitted: true,
    mode: 'creative',
    world: 'earth',
    connectedS: 35,
    skinHash: '12abcdef',
    pingMs: 33,
  });
  for (const identity of [
    { accountVerified: false },
    { account: 'guest:someone' },
    { account: 'unsafe/identifier' },
  ]) {
    expect(
      openworldTelemetrySchemas.players.parse({ players: [{ ...nativePlayer, ...identity }] })
        .players[0],
    ).not.toHaveProperty('account');
  }
  expect(openworldTelemetrySchemas.players.parse(roster)).toEqual(roster);
  expect(openworldTelemetrySchemas.players.parse({ players: [] })).toEqual({ players: [] });
});

it('preserves the explicitly readable inspection values and strips unknown nested fields', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(nativePlayer));
  const detail = await readOpenworldTelemetry(
    target,
    'fixture-token',
    'player',
    signal,
    17,
    fetcher,
  );
  expect(detail.vitals?.health).toBe(20);
  expect(detail.accountVerified).toBe(true);
  expect(detail.heldItem).toEqual({ name: 'Stone', count: 2 });
  expect(detail.client).toEqual({ fps: 60 });
  expect(detail.account).toBe('fixture-account');
  expect(detail.record).toEqual({ joins: 3, blocksBroken: 15 });
  expect(detail.inventory).toEqual({
    selected: 1,
    reportedAgoS: 0.3,
    hotbar: [null, { name: 'Stone', count: 2 }],
    bag: [],
  });
  expect(detail.armor).toEqual([{ slot: 'helmet', name: 'Helmet', wearPct: 10 }]);
  expect(detail.geo).toEqual({ lon: 10, lat: 20, alt: 90 });
  expect(detail.skinHash).toBe('12abcdef');
  expect(JSON.stringify(detail)).not.toMatch(/private address|data:image|https:|api\/live|capture/);
  expect(openworldTelemetrySchemas.player.parse(detail)).toEqual(detail);
  const [url, options] = fetcher.mock.calls[0] ?? [];
  expect(String(url)).toBe(`${target}/api/live/player?id=17`);
  expect(options).toMatchObject({
    method: 'GET',
    redirect: 'error',
    headers: { 'X-OW-Token': 'fixture-token' },
  });
});

it('keeps missing inventory distinct from an empty reported bag', () => {
  const minimal = {
    id: 1,
    name: 'New arrival',
    inventoryKnown: false,
    skinHead: '/api/live/skin?id=2&h=12345678',
  };
  const waiting = openworldTelemetrySchemas.player.parse(minimal);
  expect(waiting.inventory).toBeUndefined();
  expect(waiting.skinHash).toBeUndefined();
  const empty = openworldTelemetrySchemas.player.parse({
    ...minimal,
    inventoryKnown: true,
    inventory: { hotbar: [], bag: [] },
  });
  expect(empty.inventory?.bag).toEqual([]);
});

it('rejects invalid connection identifiers, departed players and cross-connection replies', async () => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    readOpenworldTelemetry(target, 'fixture-token', 'player', signal, -1, fetcher),
  ).rejects.toThrow('not_found');
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(
    readOpenworldTelemetry(target, 'fixture-token', 'player', signal, 17, fetcher),
  ).rejects.toThrow('not_found');
  fetcher.mockResolvedValueOnce(Response.json({ ...nativePlayer, id: 18 }));
  await expect(
    readOpenworldTelemetry(target, 'fixture-token', 'player', signal, 17, fetcher),
  ).rejects.toThrow('not_found');
});

it('distinguishes startup and expired credentials and rejects invalid/oversized snapshots', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ tps: 20 }))
    .mockResolvedValueOnce(new Response('x'.repeat(65537)));
  const read = () =>
    readOpenworldTelemetry(target, 'fixture-token', 'status', signal, undefined, fetcher);
  await expect(read()).rejects.toThrow('game_not_ready');
  await expect(read()).rejects.toBeInstanceOf(OpenworldTokenExpired);
  await expect(read()).rejects.toThrow('integration_unavailable');
  await expect(read()).rejects.toThrow('integration_unavailable');
});

it('retains instantaneous rates, named tick phases, history alignment and tenant storage usage', () => {
  const status = openworldTelemetrySchemas.status.parse({
    tps: 20,
    players: { online: 0, slots: 5 },
    net: { sentKbps: 12, recvKbps: 34 },
    phasesMs: { sim: 0.4, unknown: 9 },
    seed: 'secret',
    chunks: { diskFreeBytes: 111 },
  });
  expect(status).toEqual({
    tps: 20,
    players: { online: 0, slots: 5 },
    net: { sentKbps: 12, recvKbps: 34 },
    phasesMs: { sim: 0.4 },
    chunks: {},
  });
  expect(
    openworldTelemetrySchemas.history.parse({
      t: [1000, 2000],
      recvKbps: [null, 42],
      other: [1, 2],
    }),
  ).toEqual({ t: [1000, 2000], recvKbps: [null, 42] });
  expect(openworldTelemetrySchemas.history.safeParse({ t: [1000], tps: [20, 20] }).success).toBe(
    false,
  );
  const data = openworldTelemetrySchemas.storage.parse({
    dataDir: '/private',
    diskCapacityBytes: 12345,
    totalBytes: 170,
    worlds: [{ key: 'earth', savedBytes: 160 }],
    parts: [{ key: 'logs', bytes: 10, files: 1 }],
  });
  expect(data).toEqual({
    totalBytes: 170,
    worlds: [{ key: 'earth', savedBytes: 160 }],
    parts: [{ key: 'logs', bytes: 10, files: 1 }],
  });
});

it('maps a malformed or interrupted native login to the telemetry unavailable state', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ required: true, loopback: false, canAct: false }))
    .mockResolvedValueOnce(Response.json({ token: null }))
    .mockRejectedValueOnce(new TypeError('fetch failed'));
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(openworldDashboardToken(target, 'local fixture', signal, fetcher)).rejects.toThrow(
      'integration_unavailable',
    );
});
