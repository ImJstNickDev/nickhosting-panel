import { describe, expect, it } from 'vitest';
import { viewerDownloadPath } from './access.js';
import { compressedArchiveOptions, decodedMember, isSingleCompressed } from './compressed.js';
import { preferredViewer } from './registry.js';

const source = { path: 'data/config.json.gz', name: 'config.json.gz', size: 40 };
const page = {
  total: 1,
  entries: [{ name: 'config.json', path: 'config.json', size: 20, directory: false }],
};

describe('single compressed viewer source resolution', () => {
  it('decodes each supported single stream while preserving compound tar browsing', () => {
    for (const extension of ['gz', 'bz2', 'xz', 'zst']) {
      expect(
        isSingleCompressed({ ...source, name: `config.json.${extension.toUpperCase()}` }),
      ).toBe(true);
      expect(isSingleCompressed({ ...source, name: `backup.tar.${extension}` })).toBe(false);
    }
    expect(isSingleCompressed({ ...source, name: 'backup.tgz' })).toBe(false);
  });
  it('uses the real member name and size for selection without changing the original identity', () => {
    const decoded = decodedMember(source, page);
    expect(preferredViewer(decoded)).toBe('json');
    expect(
      preferredViewer(decoded, [{ scope: 'server', extension: 'json', viewerId: 'text' }]),
    ).toBe('text');
    expect(decoded.entry).toBe('config.json');
    expect(decoded.path).toBe(source.path);
    expect(source.name).toBe('config.json.gz');
    expect(viewerDownloadPath('test', source)).toBe(
      '/v1/servers/test/files/content?path=data%2Fconfig.json.gz',
    );
    expect(viewerDownloadPath('test', decoded)).toContain(
      'archive/content?path=data%2Fconfig.json.gz&entry=config.json&download=true',
    );
  });
  it('addresses nested compressed containers and their decoded members independently', () => {
    const nested = { ...source, path: 'backup.zip', archives: ['config.json.gz'] };
    const decoded = decodedMember(nested, page);
    const originalUrl = new URL(viewerDownloadPath('test', nested), 'https://local.invalid');
    const decodedUrl = new URL(viewerDownloadPath('test', decoded), 'https://local.invalid');
    expect(originalUrl.searchParams.get('archives')).toBeNull();
    expect(originalUrl.searchParams.get('entry')).toBe('config.json.gz');
    expect(decodedUrl.searchParams.get('archives')).toBe('["config.json.gz"]');
    expect(decodedUrl.searchParams.get('entry')).toBe('config.json');
    expect(compressedArchiveOptions('test', 'user', nested).queryKey).toEqual([
      'viewer-archive',
      'user',
      'test',
      'backup.zip',
      '["config.json.gz"]',
      '',
      '',
      'name',
      'asc',
      0,
    ]);
  });
  it('refuses to invent a decoded member for ambiguous or malformed listings', () => {
    expect(() => decodedMember(source, { total: 0, entries: [] })).toThrow();
    expect(() => decodedMember(source, { ...page, total: 2 })).toThrow();
    expect(() =>
      decodedMember(source, {
        total: 1,
        entries: [{ name: 'directory', path: 'directory', size: 0, directory: true }],
      }),
    ).toThrow();
  });
});
