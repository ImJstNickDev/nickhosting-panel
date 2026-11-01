import { describe, expect, it } from 'vitest';
import { filenameSelection, validFilename } from './inline-file-rename-model.js';

describe('inline file rename', () => {
  it.each([
    ['server.properties', 'server'],
    ['archive.tar.gz', 'archive.tar'],
    ['.env', '.env'],
    ['.env.local', '.env'],
    ['README', 'README'],
    ['trailing.', 'trailing.'],
    ['🌍 mondo.json', '🌍 mondo'],
  ])('selects the editable basename in %s', (name, expected) => {
    const [start, end] = filenameSelection(name);
    expect(name.slice(start, end)).toBe(expected);
  });

  it('retains legal spaces, Unicode, dotfiles and punctuation without normalization', () => {
    for (const name of [' world name .json', '玩家.json', '.env', 'name.', '...', 'a:b.txt'])
      expect(validFilename(name)).toBe(true);
  });

  it.each([
    '',
    '.',
    '..',
    '/file',
    'folder/file',
    'folder\\file',
    'x%2fy',
    'x\0',
    'x\n',
    'x\u007f',
  ])('rejects unsafe basename %j', (name) => expect(validFilename(name)).toBe(false));

  it('matches the adapter path-length bound without inventing a separate Unicode byte bound', () => {
    expect(validFilename('x'.repeat(4096))).toBe(true);
    expect(validFilename('x'.repeat(4097))).toBe(false);
    expect(validFilename('界'.repeat(256))).toBe(true);
  });
});
