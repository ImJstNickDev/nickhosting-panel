import type { FilemanEntry, FilemanReadService } from '@nickhosting/game-sdk';
import { expect, it, vi } from 'vitest';
import { readOpenworldRuleFiles } from './rule-files.js';

const file = (name: string, kind: FilemanEntry['kind'] = 'file', size = 100): FilemanEntry => ({
  name,
  kind,
  size,
});
it('batches only regular, bounded rule files from the configured data directory', async () => {
  const encode = (s: string) => new TextEncoder().encode(s);
  const list = vi.fn(async (dir: string) =>
    dir === ''
      ? [file('server.json'), file('roles.json'), file('saves', 'directory')]
      : [file('zones.json'), file('borders.json'), file('private.json')],
  );
  const readMany = vi.fn<FilemanReadService['readMany']>(
    async (requests) => new Map(requests.map(({ path }) => [path, encode(path)])),
  );
  const files: FilemanReadService = {
    list,
    read: async () => encode('{"dataDir":"./saves"}'),
    readMany,
    prepare: vi.fn(),
    listMany: vi.fn(),
  };
  expect(await readOpenworldRuleFiles(files)).toEqual({
    roles: encode('roles.json'),
    zones: encode('saves/zones.json'),
    borders: encode('saves/borders.json'),
  });
  expect(readMany.mock.calls[0]?.[0].map((r) => r.path)).toEqual([
    'roles.json',
    'saves/zones.json',
    'saves/borders.json',
  ]);
  list.mockImplementation(async (dir) =>
    dir === ''
      ? [file('server.json'), file('roles.json', 'symlink'), file('saves', 'directory')]
      : [file('zones.json', 'file', 1024 * 1024)],
  );
  expect(await readOpenworldRuleFiles(files)).toEqual({
    roles: undefined,
    zones: undefined,
    borders: undefined,
  });
  expect(readMany).toHaveBeenCalledTimes(1);
});
