import { describe, expect, it, vi } from 'vitest';
import type { ArchiveEntry } from './archive-query.js';
import { createAtlasPathProvider } from './atlas-path.js';

const root = { path: 'backups/world.zip', name: 'world.zip', size: 1000 };
const entry = (name: string, directory = false, parent = ''): ArchiveEntry => ({
  name,
  directory,
  path: [parent, name].filter(Boolean).join('/'),
  size: 12,
});
function fixture() {
  const tree = new Map([
    ['[]:', [entry('config', true), entry('nested.zip'), entry('many', true)]],
    ['[]:config', [entry('server.json', false, 'config')]],
    ['["nested.zip"]:', [entry('inner', true)]],
    ['["nested.zip"]:inner', [entry('note.txt', false, 'inner')]],
    [
      '[]:many',
      [
        ...Array.from({ length: 220 }, (_, i) => entry(`a-${i}-target.txt`, false, 'many')),
        entry('target.txt', false, 'many'),
      ],
    ],
  ]);
  const read = vi.fn(async (source, directory, query, offset) => {
    const list = tree.get(`${JSON.stringify(source.archives ?? [])}:${directory}`);
    if (!list) throw new Error('not found');
    const selected = list.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
    return {
      directory,
      offset,
      limit: 200,
      total: selected.length,
      entries: selected.slice(offset, offset + 200),
    };
  });
  const open = vi.fn(),
    navigate = vi.fn();
  const options = {
    key: ['fixture'],
    root,
    source: root,
    directory: 'config',
    aliases: [],
    read,
    open,
    navigate,
  };
  return { options, provider: createAtlasPathProvider(options), read, open, navigate };
}
describe('Atlas Fileman path contribution', () => {
  it('shows full virtual locations and owns only the current archive namespace', () => {
    const f = fixture();
    expect(f.provider.currentPath).toBe('/backups/world.zip/config/');
    expect(f.provider.owns('backups')).toBe(false);
    expect(f.provider.owns('backups/world.zip-other')).toBe(false);
    const member = createAtlasPathProvider({
      ...f.options,
      source: { ...root, archives: ['nested.zip'], entry: 'inner/note.txt' },
    });
    expect(member.currentPath).toBe('/backups/world.zip/nested.zip/inner/note.txt');
  });
  it('completes directories and nested archives and opens members with their actual source chain', async () => {
    const f = fixture();
    expect(await f.provider.list(root.path, 'nest', new AbortController().signal)).toEqual([
      { name: 'nested.zip', is_file: false, is_symlink: false },
    ]);
    await f.provider.navigate(`${root.path}/nested.zip/inner`);
    expect(f.navigate).toHaveBeenCalledWith({
      source: expect.objectContaining({ path: root.path, archives: ['nested.zip'] }),
      directory: 'inner',
    });
    await f.provider.open(`${root.path}/nested.zip/inner/note.txt`);
    expect(f.open).toHaveBeenCalledWith(
      expect.objectContaining({
        path: root.path,
        archives: ['nested.zip'],
        entry: 'inner/note.txt',
        name: 'note.txt',
      }),
    );
    await f.provider.navigate(`${root.path}/config`);
    expect(f.navigate).toHaveBeenLastCalledWith({
      source: expect.objectContaining({ archives: [] }),
      directory: 'config',
    });
  });
  it('finds prefix matches and exact files beyond the first filtered page without recursive indexing', async () => {
    const f = fixture();
    expect(
      await f.provider.list(`${root.path}/many`, 'target', new AbortController().signal),
    ).toEqual([{ name: 'target.txt', is_file: true, is_symlink: false }]);
    await f.provider.open(`${root.path}/many/target.txt`);
    expect(f.open).toHaveBeenCalledWith(expect.objectContaining({ entry: 'many/target.txt' }));
    expect(f.read.mock.calls.some((call) => call[3] === 200)).toBe(true);
  });
  it('retains compressed container aliases without exposing the synthetic decoded member', async () => {
    const f = fixture();
    const original = { ...root, path: 'bundle.zip.gz', name: 'bundle.zip.gz' };
    const internal = { ...original, archives: ['nested.zip'] };
    const provider = createAtlasPathProvider({
      ...f.options,
      root: original,
      source: internal,
      directory: 'inner',
      aliases: [{ original, internal }],
    });
    expect(provider.currentPath).toBe('/bundle.zip.gz/inner/');
    await provider.open('bundle.zip.gz/inner/note.txt');
    expect(f.open).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'bundle.zip.gz',
        archives: ['nested.zip'],
        entry: 'inner/note.txt',
      }),
    );
  });
  it('does not commit navigation or opening after a pending request is cancelled', async () => {
    const f = fixture();
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = createAtlasPathProvider({
      ...f.options,
      read: async (...args) => {
        await pending;
        return f.options.read(args[0], args[1], args[2], args[3]);
      },
    });
    const controller = new AbortController();
    const navigation = provider.navigate(root.path, controller.signal);
    const opening = provider.open(`${root.path}/config/server.json`, controller.signal);
    controller.abort();
    release();
    await expect(navigation).rejects.toThrow();
    await expect(opening).rejects.toThrow();
    expect(f.navigate).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it('rejects traversal, missing paths and cancelled reads without navigation or real-file fallback', async () => {
    const f = fixture();
    await expect(f.provider.navigate(`${root.path}/../private`)).rejects.toMatchObject({
      messageKey: 'file.pathNotFound',
    });
    await expect(f.provider.navigate(`${root.path}/missing`)).rejects.toMatchObject({
      messageKey: 'file.pathNotFound',
    });
    await expect(f.provider.navigate('backups')).rejects.toMatchObject({
      messageKey: 'file.pathNotFound',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(f.provider.list(root.path, '', controller.signal)).rejects.toThrow();
    expect(f.navigate).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });
});
