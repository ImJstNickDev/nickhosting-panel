import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readArchiveFile,
  visitArchive,
} from '../../../../../packages/content-providers/src/archive.js';
import {
  planMinecraftWorldFolder,
  prepareMinecraftWorldFolder,
  WorldFolderArchiveError,
} from './world-folder-archive.js';
import {
  createWorldFolderZip,
  worldFolderZipEnd,
  worldFolderZipLayout,
} from './world-folder-archive.worker.js';

function file(path: string, body: BlobPart = 'fixture') {
  const result = new File([body], path.split('/').at(-1) ?? '');
  Object.defineProperty(result, 'webkitRelativePath', { value: path });
  return result;
}
afterEach(() => vi.unstubAllGlobals());

describe('Minecraft folder import ZIP preparation', () => {
  it('roundtrips nested Unicode/binary/empty files through the real archive reader and CRC checks', async () => {
    const files = [
      file('My world/level.dat', new Uint8Array([0, 255, 10])),
      file('My world/region/世界.mca', new Uint8Array([23, 91, 0, 128])),
      file('My world/data/empty.dat', ''),
    ];
    const progress = vi.fn();
    const archive = await createWorldFolderZip(planMinecraftWorldFolder(files), {
      onProgress: progress,
    });
    const found = new Map<string, Buffer>();
    await visitArchive(new Uint8Array(await archive.arrayBuffer()), async (entry) => {
      found.set(entry.path, await readArchiveFile(entry, 100));
    });
    expect([...found.keys()]).toEqual(['level.dat', 'region/世界.mca', 'data/empty.dat']);
    expect(found.get('level.dat')).toEqual(Buffer.from([0, 255, 10]));
    expect(found.get('region/世界.mca')).toEqual(Buffer.from([23, 91, 0, 128]));
    expect(found.get('data/empty.dat')).toHaveLength(0);
    expect(archive.name).toBe('My world.zip');
    expect(progress.mock.calls.at(-1)?.[0]).toEqual({ processedBytes: 7, totalBytes: 7 });
  });
  it('requires the actual world root and rejects ambiguous, escaping, conflicting selections before reads', () => {
    for (const files of [
      [],
      [file('root/nested/level.dat')],
      [file('one/level.dat'), file('two/region/a')],
      [file('root/level.dat'), file('root/../escape')],
      [file('root/level.dat'), file('root/LEVEL.DAT')],
      [file('root/level.dat'), file('root/region'), file('root/region/a')],
    ])
      expect(() => planMinecraftWorldFolder(files)).toThrow(WorldFolderArchiveError);
  });
  it('uses ZIP64 aggregate offsets and directory records above 4 GiB without allocating file payloads', () => {
    const layout = worldFolderZipLayout([
      { path: 'level.dat', size: 32 },
      { path: 'region/huge.mca', size: 2 ** 32 },
      { path: 'region/last.mca', size: 1 },
    ]);
    expect(layout.entries[2]?.offset).toBeGreaterThan(2 ** 32);
    const end = new DataView(worldFolderZipEnd(layout));
    expect(end.getUint32(0, true)).toBe(0x06064b50);
    expect(end.getBigUint64(48, true)).toBe(BigInt(layout.directoryOffset));
    expect(end.getBigUint64(64, true)).toBe(BigInt(layout.directoryOffset + layout.directorySize));
    expect(end.getUint32(92, true)).toBe(0xffffffff);
  });
  it('enforces total archive overhead and entry budgets before reading bytes', async () => {
    const source = file('root/level.dat');
    Object.defineProperty(source, 'size', { value: 8 * 1024 ** 3 });
    const read = vi.spyOn(source, 'slice');
    await expect(createWorldFolderZip(planMinecraftWorldFolder([source]))).rejects.toThrow(
      'limit_exceeded',
    );
    expect(read).not.toHaveBeenCalled();
    expect(() =>
      worldFolderZipLayout(
        Array.from({ length: 10001 }, (_, index) => ({ path: `${index}`, size: 0 })),
      ),
    ).toThrow('limit_exceeded');
  });
  it('reads bounded chunks and cancellation prevents further I/O', async () => {
    const source = file('root/level.dat', new Uint8Array(2 * 1024 ** 2 + 3));
    const read = vi.spyOn(source, 'slice');
    const archive = await createWorldFolderZip(planMinecraftWorldFolder([source]));
    expect(read.mock.calls).toEqual([
      [0, 1024 ** 2],
      [1024 ** 2, 2 * 1024 ** 2],
      [2 * 1024 ** 2, 3 * 1024 ** 2],
    ]);
    expect(archive.size).toBeGreaterThan(source.size);
    read.mockClear();
    const abort = new AbortController();
    await expect(
      createWorldFolderZip(planMinecraftWorldFolder([source]), {
        signal: abort.signal,
        onProgress: () => abort.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });
  it('sends explicit relative paths and terminates the worker on cancellation', async () => {
    const instances: {
      terminate: ReturnType<typeof vi.fn>;
      postMessage: ReturnType<typeof vi.fn>;
    }[] = [];
    vi.stubGlobal(
      'Worker',
      class {
        terminate = vi.fn();
        postMessage = vi.fn();
        constructor() {
          instances.push(this);
        }
      },
    );
    const abort = new AbortController();
    const input = file('root/level.dat');
    const result = prepareMinecraftWorldFolder([input], { signal: abort.signal });
    expect(instances[0]?.postMessage).toHaveBeenCalledWith({
      root: 'root',
      entries: [{ file: input, path: 'level.dat' }],
    });
    abort.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(instances[0]?.terminate).toHaveBeenCalledOnce();
  });
});
