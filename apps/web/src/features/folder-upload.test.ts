import { describe, expect, it, vi } from 'vitest';
import {
  FolderUploadError,
  type FolderUploadFilesystem,
  planFolderUpload,
  prepareFolderUpload,
} from './folder-upload.js';

const file = (path: string, name = path.split('/').at(-1) ?? '') => {
  const result = new File(['content'], name);
  Object.defineProperty(result, 'webkitRelativePath', { value: path });
  return result;
};
const directory = (name: string) => ({ name, is_file: false, is_symlink: false });

function filesystem() {
  const inventory = new Map<string, ReturnType<typeof directory>[]>([['', []]]);
  const list = vi.fn(async (path: string) => {
    const entries = inventory.get(path);
    if (!entries) throw new Error('missing_directory');
    return entries;
  });
  const mkdir = vi.fn(async (parent: string, name: string) => {
    inventory.get(parent)?.push(directory(name));
    inventory.set([parent, name].filter(Boolean).join('/'), []);
  });
  return { inventory, list, mkdir };
}

describe('folder upload planning', () => {
  it('preserves the selected Unicode root, nested paths and original files', () => {
    const original = [file('Móndo/玩家/level.dat'), file('Móndo/server.properties')];
    const plan = planFolderUpload(original, 'backups/october');
    expect(plan.root).toBe('Móndo');
    expect(plan.directories).toEqual(['backups/october/Móndo', 'backups/october/Móndo/玩家']);
    expect(plan.entries).toEqual([
      { file: original[0], path: 'backups/october/Móndo/玩家/level.dat' },
      { file: original[1], path: 'backups/october/Móndo/server.properties' },
    ]);
  });

  it.each([
    '/world/a',
    'world//a',
    'world/../a',
    'world/./a',
    'world\\a',
    'C:/world/a',
    'world/a\0',
    'world/a\u007f',
    'world/%2e%2e/a',
    'world/a/',
    'single-file.txt',
  ])('rejects unsafe or non-directory browser paths: %s', (path) => {
    expect(() => planFolderUpload([file(path)], '')).toThrow('invalid_path');
  });

  it('requires a nonempty selection, one root and the actual filename', () => {
    expect(() => planFolderUpload([], '')).toThrow('empty_selection');
    expect(() => planFolderUpload([file('one/a'), file('two/b')], '')).toThrow('multiple_roots');
    expect(() => planFolderUpload([file('world/a', 'b')], '')).toThrow('invalid_path');
    expect(() => planFolderUpload([file('world/a')], '../uploads')).toThrow('invalid_path');
    expect(() => planFolderUpload([file('world/a')], '/uploads')).toThrow('invalid_path');
  });

  it.each([
    ['world/a', 'world/a'],
    ['world/A.txt', 'world/a.txt'],
    ['world/Foo/a', 'world/foo/b'],
    ['world/café/a', 'world/cafe\u0301/b'],
    ['world/file', 'world/file/child'],
    ['world/file/child', 'world/file'],
  ])('rejects duplicate, case/Unicode or parent-file collisions: %s, %s', (a, b) => {
    expect(() => planFolderUpload([file(a), file(b)], '')).toThrow('collision');
  });

  it('bounds metadata, full destination depth and path length before filesystem work', () => {
    expect(() =>
      planFolderUpload(
        Array.from({ length: 10000 }, (_, n) => file(`world/${n}`)),
        '',
      ),
    ).toThrow('limit_exceeded');
    expect(() => planFolderUpload([file('world/a')], Array(63).fill('x').join('/'))).toThrow(
      'limit_exceeded',
    );
    expect(() => planFolderUpload([file(`world/${'a'.repeat(4096)}`)], '')).toThrow(
      'limit_exceeded',
    );
  });
});

describe('folder upload preparation', () => {
  it('prepares a new tree in order without writing any file contents', async () => {
    const fs = filesystem();
    fs.inventory.set('', [directory('uploads')]);
    fs.inventory.set('uploads', []);
    const plan = planFolderUpload(
      [file('world/region/a'), file('world/config/settings/b')],
      'uploads',
    );
    expect(await prepareFolderUpload(plan, fs)).toBe(plan);
    expect(fs.mkdir.mock.calls).toEqual([
      ['uploads', 'world', undefined],
      ['uploads/world', 'region', undefined],
      ['uploads/world', 'config', undefined],
      ['uploads/world/config', 'settings', undefined],
    ]);
    expect(fs.inventory.get('uploads/world/region')).toEqual([]);
  });

  it.each([
    directory('world'),
    { ...directory('WORLD'), is_file: true },
    { ...directory('world'), is_symlink: true },
  ])('never merges or replaces an existing root: %j', async (existing) => {
    const fs = filesystem();
    fs.inventory.set('', [existing]);
    await expect(
      prepareFolderUpload(planFolderUpload([file('world/a')], ''), fs),
    ).rejects.toMatchObject({
      code: 'collision',
      createdDirectories: [],
    });
    expect(fs.mkdir).not.toHaveBeenCalled();
  });

  it.each([
    { ...directory('uploads'), is_symlink: true },
    { ...directory('uploads'), is_file: true },
    directory('Uploads'),
  ])('rejects unsafe, missing or ambiguously cased ancestors: %j', async (entry) => {
    const fs = filesystem();
    fs.inventory.set('', [entry]);
    await expect(
      prepareFolderUpload(planFolderUpload([file('world/a')], 'uploads'), fs),
    ).rejects.toMatchObject({
      code: 'unsafe_destination',
      createdDirectories: [],
    });
    expect(fs.mkdir).not.toHaveBeenCalled();
  });

  it('does not adopt a descendant another writer created during preparation', async () => {
    const fs = filesystem();
    const create = fs.mkdir.getMockImplementation();
    fs.mkdir.mockImplementation(async (parent, name) => {
      await create?.(parent, name);
      if (name === 'world') fs.inventory.set('world', [directory('region')]);
    });
    await expect(
      prepareFolderUpload(planFolderUpload([file('world/region/a')], ''), fs),
    ).rejects.toMatchObject({
      code: 'collision',
      createdDirectories: ['world'],
    });
    expect(fs.mkdir).toHaveBeenCalledTimes(1);
    expect(fs.inventory.get('world')).toEqual([directory('region')]);
  });

  it('preserves partial work and reports an uncertain mkdir without pretending rollback', async () => {
    const fs = filesystem();
    const create = fs.mkdir.getMockImplementation();
    fs.mkdir.mockImplementation(async (parent, name) => {
      await create?.(parent, name);
      if (name === 'region') throw new Error('lost response');
    });
    await expect(
      prepareFolderUpload(planFolderUpload([file('world/region/a')], ''), fs),
    ).rejects.toMatchObject({
      code: 'preparation_failed',
      createdDirectories: ['world'],
      uncertainDirectory: 'world/region',
    });
    expect(fs.inventory.has('world/region')).toBe(true);
  });

  it('rejects a newly created directory that is observed as a symlink', async () => {
    const fs = filesystem();
    fs.mkdir.mockImplementation(async (_parent, name) => {
      fs.inventory.set('', [{ ...directory(name), is_symlink: true }]);
    });
    await expect(
      prepareFolderUpload(planFolderUpload([file('world/region/a')], ''), fs),
    ).rejects.toMatchObject({
      code: 'unsafe_destination',
      createdDirectories: ['world'],
    });
    expect(fs.mkdir).toHaveBeenCalledTimes(1);
  });

  it('cancels before work and between directories without removing prepared data', async () => {
    const controller = new AbortController();
    const fs = filesystem();
    const create = fs.mkdir.getMockImplementation();
    fs.mkdir.mockImplementation(async (parent, name) => {
      await create?.(parent, name);
      controller.abort();
    });
    const plan = planFolderUpload([file('world/region/a')], '');
    await expect(prepareFolderUpload(plan, fs, controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
      createdDirectories: ['world'],
    });
    expect(fs.mkdir).toHaveBeenCalledTimes(1);
    expect(fs.inventory.has('world')).toBe(true);
    fs.mkdir.mockClear();
    fs.list.mockClear();
    await expect(prepareFolderUpload(plan, fs, controller.signal)).rejects.toBeInstanceOf(
      FolderUploadError,
    );
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.list).not.toHaveBeenCalled();
  });

  it('passes cancellation to the request and records its uncertain effect', async () => {
    const controller = new AbortController();
    const fs: FolderUploadFilesystem = {
      list: async () => [],
      mkdir: async (_parent, _name, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      },
    };
    await expect(
      prepareFolderUpload(planFolderUpload([file('world/a')], ''), fs, controller.signal),
    ).rejects.toMatchObject({
      code: 'cancelled',
      createdDirectories: [],
      uncertainDirectory: 'world',
    });
  });
});
