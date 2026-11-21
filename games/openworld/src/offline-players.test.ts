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
    statsAt: at,
    world: 'earth',
    mode: 'survival',
    position: { x: 0, y: 4, z: 5, face: 0 },
    stats: { joins: 4, walkedMeters: 30 },
    inventory: { selected: 0, hotbar: [{ code: 123, count: 2 }, null], bag: [] },
  });
  values.set('stats', bytes({ uuid: 'guest_Ada', joins: 4 }));
  expect(projectSavedPlayer(ref, values)?.stats).toBeNull();
  values.delete('save');
  expect(projectSavedPlayer(ref, values)).toBeNull();
  values.set('stats', bytes({ uuid: 'Elsewhere', pseudo: 'Ada' }));
  expect(projectSavedPlayer(ref, values)).toBeNull();
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
