import { expect, it, vi } from 'vitest';
import { OpenworldTokenExpired } from './dashboard-api.js';
import { readOpenworldCreatures, readOpenworldSpace } from './map-layers.js';

const native = {
  origin: 'http://fixture.test:24711',
  token: 'fixture-only',
  signal: new AbortController().signal,
};
const species = { id: 2, key: 'dog', name: 'Dog', count: 300, hostile: false };
const marker = { species: 2, face: 3, x: 98.75, z: 42.1 };
const body = {
  index: 0,
  name: 'sun',
  label: 'Sun',
  radiusMeters: 109245016.48,
  parent: -1,
  atmosphere: false,
  isLight: true,
  world: null,
  position: [0, 0, 0],
  orientation: { y: [0, 1, 0] },
};
const checkpoint = {
  id: 1,
  world: 'earth',
  name: 'Base',
  visibility: 'players',
  helio: [-1258.35, 80, 45328],
  color: '#3E8EFF',
};
const player = {
  id: 42,
  name: 'Traveler',
  inSpace: true,
  world: null,
  helio: [3000, 4000, -820],
};

it('reads counts and species for the selected world using the smallest native list', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      total: 300,
      items: 19,
      bySpecies: [{ ...species, extra: 'private' }],
      list: [marker],
    }),
  );
  expect(await readOpenworldCreatures({ ...native, fetcher }, 'earth')).toEqual({
    world: 'earth',
    total: 300,
    items: 19,
    species: [species],
    markers: [],
    markersTruncated: false,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(
    `${native.origin}/api/live/entities?world=earth&limit=1`,
  );
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    redirect: 'error',
    headers: { 'X-OW-Token': native.token },
    signal: native.signal,
  });
});

it('bounds the creature sample, reports incomplete coverage and projects only valid face coordinates', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      total: 300,
      items: 8,
      bySpecies: [species],
      list: [
        { ...marker, y: 50, owner: 'secret' },
        { ...marker, face: 6 },
        { ...marker, x: -1 },
        { ...marker, z: 1e24 },
        { ...marker, x: '99' },
        null,
      ],
    }),
  );
  const layer = await readOpenworldCreatures({ ...native, fetcher }, 'moon', true);
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(
    `${native.origin}/api/live/entities?world=moon&limit=256`,
  );
  expect(layer).toEqual({
    world: 'moon',
    total: 300,
    items: 8,
    species: [species],
    markers: [marker],
    markersTruncated: true,
  });
  await expect(readOpenworldCreatures({ ...native, fetcher }, '../earth')).rejects.toMatchObject({
    code: 'validation_failed',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('projects orbital bodies, traveling players and only classified checkpoints with heliocentric coordinates', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      t: 128.5,
      bodies: [body],
      players: [
        { ...player, world: undefined, token: 'secret', mode: 'creative' },
        { ...player, inSpace: false },
        { ...player, inSpace: 'false' },
        { ...player, helio: [1e290, 0, 0] },
        { ...player, helio: null, cart: [1, 2, 3] },
      ],
      checkpoints: [
        { ...checkpoint, author: 'secret', note: 'secret' },
        { ...checkpoint, id: 2, visibility: 'admins' },
        { ...checkpoint, id: 3, visibility: 'unknown' },
        { ...checkpoint, id: 4, visibility: null },
        { ...checkpoint, id: 5, helio: [] },
      ],
    }),
  );
  const layer = await readOpenworldSpace({ ...native, fetcher });
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(`${native.origin}/api/live/space`);
  expect(layer).toEqual({
    t: 128.5,
    bodies: [
      {
        index: 0,
        name: 'Sun',
        world: null,
        parent: null,
        radiusMeters: 109245016.48,
        atmosphere: false,
        isLight: true,
        position: [0, 0, 0],
      },
    ],
    players: [{ id: 42, name: 'Traveler', world: null, position: [3000, 4000, -820] }],
    checkpoints: ['players', 'admins'].map((visibility, i) => ({
      id: i + 1,
      world: 'earth',
      name: 'Base',
      color: '#3E8EFF',
      visibility,
      position: [-1258.35, 80, 45328],
    })),
  });
});

it('distinguishes supported empty responses from a missing or malformed native layer', async () => {
  const get = (json: unknown) => ({ ...native, fetcher: async () => Response.json(json) });
  expect(
    await readOpenworldCreatures(
      get({ total: 0, items: 0, bySpecies: [], list: [] }),
      'earth',
      true,
    ),
  ).toMatchObject({ total: 0, items: 0, markers: [], markersTruncated: false });
  await expect(
    readOpenworldCreatures(get({ total: 0, bySpecies: [], list: [] }), 'earth'),
  ).rejects.toMatchObject({ code: 'integration_unavailable' });
  await expect(
    readOpenworldSpace(
      get({ t: 0, bodies: [{ ...body, position: [0, null, 1] }], players: [], checkpoints: [] }),
    ),
  ).rejects.toMatchObject({ code: 'integration_unavailable' });
  await expect(
    readOpenworldSpace({ ...native, fetcher: async () => new Response(null, { status: 401 }) }),
  ).rejects.toBeInstanceOf(OpenworldTokenExpired);
  await expect(
    readOpenworldSpace({ ...native, fetcher: async () => new Response(null, { status: 404 }) }),
  ).rejects.toMatchObject({ code: 'game_request_unsupported' });
  await expect(
    readOpenworldSpace({ ...native, fetcher: async () => new Response(null, { status: 503 }) }),
  ).rejects.toMatchObject({ code: 'game_not_ready' });
  await expect(
    readOpenworldSpace({
      ...native,
      fetcher: async () => new Response('oversized', { headers: { 'Content-Length': '5000000' } }),
    }),
  ).rejects.toMatchObject({ code: 'integration_unavailable' });
});
