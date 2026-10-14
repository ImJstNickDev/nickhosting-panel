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
    expect(preferredViewer(file('world.gz'))).toBe('archive');
    expect(preferredViewer(file('report.PDF', 10 * 1024 * 1024))).toBe('pdf');
    expect(preferredViewer({ ...file('report.pdf'), entry: 'reports/report.pdf' })).toBe('pdf');
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
  it('retains the editor memory bound and allows nested archives but excludes nested database readers', () => {
    expect(availableViewers(file('huge.json', 2 * 1024 * 1024)).map((item) => item.id)).toEqual([
      'json',
    ]);
    expect(preferredViewer({ ...file('nested.zip'), entry: 'a/nested.zip' })).toBe('archive');
    const nested = { ...file('config.json'), entry: 'a/config.json' };
    expect(preferredViewer(nested)).toBe('json');
    expect(selectableViewers(nested).map((item) => item.id)).toContain('archive');
    expect(selectableViewers(nested).map((item) => item.id)).not.toContain('sqlite');
    expect(
      preferredViewer(nested, [{ scope: 'server', extension: 'json', viewerId: 'archive' }]),
    ).toBe('archive');
    expect(
      selectableViewers({ ...file('nested.zip'), archives: ['nested.zip'] }).map((item) => item.id),
    ).not.toContain('sqlite');
    expect(selectableViewers(file('unknown.dat')).map((item) => item.id)).toEqual([
      'image',
      'audio',
      'video',
      'archive',
      'sqlite',
      'json',
      'pdf',
      'text',
    ]);
  });
  it('offers shared CSV/TSV views within editor bounds, including read-only archive entries', () => {
    for (const name of ['users.csv', 'users.tsv']) {
      expect(preferredViewer(file(name))).toBe('sqlite');
      expect(availableViewers(file(name)).map((item) => item.id)).toEqual(['sqlite', 'text']);
      expect(preferredViewer({ ...file(name), entry: name })).toBe('sqlite');
      expect(availableViewers(file(name, 2 * 1024 * 1024))).toEqual([]);
    }
  });
});
