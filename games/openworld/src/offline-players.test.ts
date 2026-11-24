import type { FilemanReadService } from '@nickhosting/game-sdk';
import { expect, it, vi } from 'vitest';
import { listSavedPlayerFiles, projectSavedPlayer } from './offline-players.js';

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
it('projects the native save and stats files, rejects mismatched identities and preserves slot numbering', () => {
  const stem = 'guest:Ada',
    uuid = 'guest:Ada',
    at = '2026-01-12T12:00:00.000Z';
  const ref = {
    stem,
    save: { path: 'save', size: 500, time: at },
    stats: { path: 'stats', size: 400, time: at },
    revision: '',
  };
  const values = new Map([
    [
      'save',
      bytes({
        uuid,
        pseudo: 'Ada',
        gameMode: 'survival',
        savedAtMs: Date.parse(at),
        position: { world: 'earth', x: 0, y: 4, z: 5, face: 0 },
        inventory: {
          selected: 0,
          hotbar: [
            [123, 2],
            [0, 0],
          ],
          bag: [],
        },
        token: 'private',
      }),
    ],
    ['stats', bytes({ uuid, pseudo: 'Earlier name', joins: 4, walkedMeters: 30, ip: 'private' })],
  ]);
  expect(projectSavedPlayer(ref, values)).toEqual({
    uuid,
    name: 'Ada',
    savedAt: at,
    lastSeenMs: null,
    statsAt: at,
    world: 'earth',
    mode: 'survival',
    position: { x: 0, y: 4, z: 5, face: 0 },
    stats: { joins: 4, walkedMeters: 30 },
    inventory: { selected: 0, hotbar: [{ code: 123, count: 2 }, null], bag: [] },
    heldItem: { code: 123, count: 2 },
  });
  values.set('stats', bytes({ uuid: 'guest_Ada', joins: 4 }));
  expect(projectSavedPlayer(ref, values)?.stats).toBeNull();
  values.delete('save');
  expect(projectSavedPlayer(ref, values)).toBeNull();
  values.set('stats', bytes({ uuid: 'Elsewhere', pseudo: 'Ada' }));
  expect(projectSavedPlayer(ref, values)).toBeNull();
});
it('reads saved character state including empty slots, gear and air in the same units as the live API', () => {
  const save = { path: 'save', size: 512, time: null };
  const ref = { save, stats: null, revision: '', stem: 'Ada' };
  const project = (state: object) =>
    projectSavedPlayer(ref, new Map([['save', bytes({ uuid: 'Ada', ...state })]]));
  const inventory = {
    selected: 1,
    hotbar: [
      [0, 0],
      [123, 2],
    ],
    bag: [],
    armor: [0, 55, 0, 0],
    gear: [0, 88],
  };
  const vitals = { health: 67.25, food: 0, saturation: 22.5, air: 201 };
  expect(project({ format: 3, vitals, inventory })).toMatchObject({
    vitals: {
      health: 67.25,
      maxHealth: 100,
      hunger: 0,
      maxHunger: 100,
      saturation: 22.5,
      air: 10.05,
      maxAir: 20,
    },
    heldItem: { code: 123, count: 2 },
    armor: [null, { code: 55, count: 1, slot: 'chestplate' }, null, null],
    gear: [null, { code: 88, count: 1, slot: 'equipment' }],
  });
  const partial = project({
    format: 3,
    vitals: { health: 0, food: 'redacted' },
    inventory: { ...inventory, armor: [0, -3, 0, 0], selected: 0 },
  });
  expect(partial?.vitals).toEqual({ health: 0, maxHealth: 100 });
  expect(partial?.armor).toBeUndefined();
  expect(partial?.heldItem).toBeNull();
  expect(partial?.gear?.[1]?.code).toBe(88);
  expect(project({ inventory: { ...inventory, selected: 7 } })?.heldItem).toBeUndefined();
  expect(project({ inventory: {} })?.vitals).toBeUndefined();
  expect(project({ format: 4, vitals })?.vitals).toBeUndefined();
  expect(
    project({ format: 2, vitals: { health: 10, food: 15, saturation: 12, air: 151 } })?.vitals,
  ).toEqual({
    health: 50,
    maxHealth: 100,
    hunger: 75,
    maxHunger: 100,
    saturation: 50,
    air: 10.05,
    maxAir: 20,
  });
});
it('resolves dot and custom data roots, refuses traversal and symlinks before listing their contents', async () => {
  let dataDir = './';
  const list = vi.fn(async (path: string) => {
    if (path === '')
      return [
        { name: 'server.json', kind: 'file', size: 60 },
        { name: 'players', kind: 'directory', size: 0 },
        { name: 'maps', kind: 'directory', size: 0 },
        { name: 'link', kind: 'symlink', size: 0 },
      ];
    if (path === 'maps') return [{ name: 'managed', kind: 'directory', size: 0 }];
    if (path === 'maps/managed') return [{ name: 'players', kind: 'directory', size: 0 }];
    if (path.endsWith('players'))
      return [
        { name: 'a.json', kind: 'file', size: 10 },
        { name: 'b.json', kind: 'symlink', size: 10 },
      ];
    throw Error(path);
  });
  const files = { list, read: async () => bytes({ dataDir }) } as unknown as FilemanReadService;
  expect((await listSavedPlayerFiles(files)).get('a')?.save?.path).toBe('players/a.json');
  dataDir = './maps/managed/';
  expect((await listSavedPlayerFiles(files)).get('a')?.save?.path).toBe(
    'maps/managed/players/a.json',
  );
  expect((await listSavedPlayerFiles(files)).has('b')).toBe(false);
  for (dataDir of ['../data', 'maps/../etc', 'link', '/etc', 'a\\b'])
    await expect(listSavedPlayerFiles(files)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
  expect(list).not.toHaveBeenCalledWith('link');
});
