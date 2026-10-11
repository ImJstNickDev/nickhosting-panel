import { describe, expect, it } from 'vitest';
import { filePathCandidates, parseFilePathInput } from './file-path-model.js';
import type { ServerFile } from './service-contracts.js';

const file = (name: string, is_file = true, is_symlink = false) =>
  ({ name, is_file, is_symlink }) as ServerFile;

describe('file path completion', () => {
  it('queries only the parent directory while a filename prefix changes', () => {
    for (const prefix of ['r', 're', 'reg', 'region'])
      expect(parseFilePathInput(`/world/${prefix}`)).toEqual({
        path: `world/${prefix}`,
        parent: 'world',
        prefix,
        directoryInput: false,
      });
    expect(parseFilePathInput('/world/')).toEqual({
      path: 'world',
      parent: 'world',
      prefix: '',
      directoryInput: true,
    });
    expect(parseFilePathInput('/')).toEqual({
      path: '',
      parent: '',
      prefix: '',
      directoryInput: true,
    });
  });
  it('preserves spaces, Unicode names and relative input without resolving dot segments', () => {
    expect(parseFilePathInput('/ worlds / 玩家 / level ')).toEqual({
      path: ' worlds / 玩家 / level ',
      parent: ' worlds / 玩家 ',
      prefix: ' level ',
      directoryInput: false,
    });
    expect(parseFilePathInput('world/settings.json')?.parent).toBe('world');
  });
  it.each([
    '../world',
    '/world/../x',
    '/world/./x',
    '/world//x',
    '//world',
    '/x\\y',
    '/x%2fy',
    '/x\0',
    '/x\u007f',
    'C:/world',
    '/'.repeat(3),
  ])('rejects unsafe path %s', (path) => expect(parseFilePathInput(path)).toBeUndefined());
  it('bounds path length and nesting', () => {
    expect(parseFilePathInput('x'.repeat(4097))).toBeUndefined();
    expect(parseFilePathInput(Array(65).fill('x').join('/'))).toBeUndefined();
  });
  it('sorts directories first, filters locally and omits links/unsafe provider names', () => {
    const files = [
      file('World.txt'),
      file('world two', false),
      file('world10', false),
      file('world2', false),
      file('world link', false, true),
      file('world/other'),
      file('../world'),
      file('world%2fx'),
      file('unrelated'),
    ];
    expect(filePathCandidates(files, 'WOR').map((entry) => entry.name)).toEqual([
      'world two',
      'world2',
      'world10',
      'World.txt',
    ]);
    expect(files[0]?.name).toBe('World.txt');
    expect(filePathCandidates([file(' world ')], ' ').map((entry) => entry.name)).toEqual([
      ' world ',
    ]);
  });
});
