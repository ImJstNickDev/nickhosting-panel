import { describe, expect, it } from 'vitest';
import {
  availableViewers,
  preferredViewer,
  selectableViewers,
  type ViewerSource,
  viewerExtension,
} from './registry.js';

const file = (name: string, size = 100): ViewerSource => ({ name, path: `world/${name}`, size });
describe('trusted viewer selection', () => {
  it('uses compound extensions and never chooses text for binary files', () => {
    expect(viewerExtension('backup.TAR.ZST')).toBe('tar.zst');
    expect(preferredViewer(file('world.tar.xz'))).toBe('archive');
    expect(availableViewers(file('icon.ico')).map((item) => item.id)).toEqual(['image']);
    expect(preferredViewer(file('server.jar'))).toBe('archive');
    expect(preferredViewer(file('state.dat'))).toBeUndefined();
    expect(preferredViewer(file('world.gz'))).toBeUndefined();
  });
  it('honors scoped personal choices even when the extension does not suggest that viewer', () => {
    const preferences = [
      { scope: 'global', extension: 'json', viewerId: 'json' },
      { scope: 'game', extension: 'json', viewerId: 'text' },
      { scope: 'server', extension: 'json', viewerId: 'json' },
    ] as const;
    expect(preferredViewer(file('config.json'), preferences)).toBe('json');
    expect(preferredViewer(file('config.json'), preferences.slice(0, 2))).toBe('text');
    expect(
      preferredViewer(file('config.json'), [
        { scope: 'server', extension: 'json', viewerId: 'image' },
      ]),
    ).toBe('image');
    expect(
      preferredViewer(file('unusual.dat'), [
        { scope: 'server', extension: 'dat', viewerId: 'json' },
      ]),
    ).toBe('json');
    expect(
      preferredViewer(file('config.json'), [
        { scope: 'server', extension: 'json', viewerId: 'foreign:unknown' },
      ]),
    ).toBe('json');
  });
  it('retains the editor memory bound and excludes unsupported nested archive/database readers', () => {
    expect(availableViewers(file('huge.json', 2 * 1024 * 1024)).map((item) => item.id)).toEqual([
      'json',
    ]);
    expect(availableViewers({ ...file('nested.zip'), entry: 'a/nested.zip' })).toEqual([]);
    const nested = { ...file('config.json'), entry: 'a/config.json' };
    expect(preferredViewer(nested)).toBe('json');
    expect(selectableViewers(nested).map((item) => item.id)).not.toContain('archive');
    expect(selectableViewers(nested).map((item) => item.id)).not.toContain('sqlite');
    expect(
      preferredViewer(nested, [{ scope: 'server', extension: 'json', viewerId: 'archive' }]),
    ).toBe('json');
    expect(selectableViewers(file('unknown.dat')).map((item) => item.id)).toEqual([
      'image',
      'audio',
      'video',
      'archive',
      'sqlite',
      'json',
      'text',
    ]);
  });
});
