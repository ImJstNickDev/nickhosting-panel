import { describe, expect, it } from 'vitest';
import {
  fileBreadcrumbs,
  fileClipboardForScope,
  normalizeFilePath,
  selectFileClick,
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
  it('toggles additive clicks without clearing the other selections', () => {
    const rows = ['a', 'b', 'c'].map((name) => file(name));
    const modifiers = { additive: true, range: false };
    const selected = selectFileClick(rows, new Set(['a']), 'a', 'c', modifiers);
    expect([...selected]).toEqual(['a', 'c']);
    expect([...selectFileClick(rows, selected, 'c', 'a', modifiers)]).toEqual(['c']);
  });
  it('replaces the range for Shift and adds it for Ctrl/Command+Shift in visible order', () => {
    const rows = ['z', 'n', 'c', 'a'].map((name) => file(name));
    const selected = new Set(['hidden', 'a']);
    expect([
      ...selectFileClick(rows, selected, 'n', 'z', { additive: false, range: true }),
    ]).toEqual(['z', 'n']);
    expect([...selectFileClick(rows, selected, 'n', 'c', { additive: true, range: true })]).toEqual(
      ['hidden', 'a', 'n', 'c'],
    );
  });
  it('falls back to one selected row without a visible anchor and omits symlinks', () => {
    const rows = [file('a'), { ...file('b'), is_symlink: true }, file('c')];
    expect([
      ...selectFileClick(rows, new Set(['a']), 'hidden', 'c', { additive: false, range: true }),
    ]).toEqual(['c']);
    expect([
      ...selectFileClick(rows, new Set(), 'a', 'c', { additive: false, range: true }),
    ]).toEqual(['a', 'c']);
  });
  it('keeps clipboard metadata scoped to the exact actor/session and server', () => {
    const clipboard = {
      identity: 'session:actor:subject',
      serverId: 'server-a',
      source: 'world',
      names: ['level.dat'],
      action: 'move' as const,
    };
    expect(fileClipboardForScope(clipboard, clipboard.identity, clipboard.serverId)).toBe(
      clipboard,
    );
    expect(fileClipboardForScope(clipboard, 'other-session', clipboard.serverId)).toBeUndefined();
    expect(fileClipboardForScope(clipboard, undefined, clipboard.serverId)).toBeUndefined();
    expect(fileClipboardForScope(clipboard, clipboard.identity, 'server-b')).toBeUndefined();
  });
});
