import { describe, expect, it } from 'vitest';
import {
  fileBreadcrumbs,
  normalizeFilePath,
  selectFileRange,
  validMoveTarget,
  visibleFiles,
} from './file-manager-model.js';
import type { ServerFile } from './service-contracts.js';

const file = (name: string, is_file = true, size = 1) =>
  ({ name, is_file, is_symlink: false, size, modified_at: '2026-01-01T00:00:00Z' }) as ServerFile;
describe('file manager navigation and selection', () => {
  it('preserves server-relative breadcrumb destinations and rejects traversal', () => {
    expect(fileBreadcrumbs('world/playerdata')).toEqual([
      { name: 'root', path: '' },
      { name: 'world', path: 'world' },
      { name: 'playerdata', path: 'world/playerdata' },
    ]);
    expect(normalizeFilePath('/world//playerdata/')).toBe('world/playerdata');
    for (const path of ['../world', 'world/../other', 'world/./x', 'world\\x', 'world\0'])
      expect(normalizeFilePath(path)).toBeUndefined();
  });
  it('keeps folders first in either sort direction and searches without mutating inventory', () => {
    const inventory = [file('a', true, 5), file('world', false), file('b', true, 9)];
    expect(visibleFiles(inventory, '', 'size', true).map((x) => x.name)).toEqual([
      'world',
      'b',
      'a',
    ]);
    expect(visibleFiles(inventory, 'WORLD', 'name', false).map((x) => x.name)).toEqual(['world']);
    expect(inventory[0]?.name).toBe('a');
  });
  it('shift selects the visible range in either direction and preserves unrelated selections', () => {
    const rows = ['a', 'b', 'c', 'd'].map((name) => file(name));
    expect([...selectFileRange(rows, new Set(['hidden']), 'd', 'b', true, true)]).toEqual([
      'hidden',
      'b',
      'c',
      'd',
    ]);
    expect([...selectFileRange(rows, new Set(['a', 'b', 'c']), 'a', 'b', true, false)]).toEqual([
      'c',
    ]);
  });
  it('rejects moves into the same folder or inside an item being moved', () => {
    expect(validMoveTarget('world', ['region'], 'world')).toBe(false);
    expect(validMoveTarget('world', ['region'], 'world/region/sub')).toBe(false);
    expect(validMoveTarget('world', ['region'], '')).toBe(true);
  });
});
