import { readArchiveFile, visitArchive } from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';
import type { PterodactylAdapter, ServerFile } from '@nickhosting/pterodactyl-adapter';
import { describe, expect, it, vi } from 'vitest';
import { archiveFileReader } from './file-archive-reader.js';
import { type ArchiveEntry, collectArchiveEntries, streamFileZip } from './file-browsing.js';

const entry = (name: string, is_file: boolean): ServerFile => ({
  name,
  is_file,
  size: is_file ? 4 : 0,
  is_symlink: false,
  mode: 'rw-r--r--',
  mode_bits: '644',
  mimetype: 'application/octet-stream',
  created_at: '2026-01-01T00:00:00Z',
  modified_at: '2026-01-01T00:00:00Z',
});
function fixture(count: number) {
  const region = Array.from({ length: count }, (_, i) => entry(String(i).padStart(4, '0'), true));
  const directories = new Map([
    ['', [entry('world', false)]],
    ['world', [entry('region', false)]],
    ['world/region', region],
  ]);
  const listFiles = vi.fn(async (_id: string, path: string) => directories.get(path) ?? []);
  const downloadFile = vi.fn<PterodactylAdapter['downloadFile']>(async (_id, path, input) => {
    await input.authorize?.();
    return { body: new Blob([path.slice(-4)]).stream(), contentType: 'application/octet-stream' };
  });
  const prefetchDownloads = vi.fn(async (_id: string, _paths: string[]) => {});
  const adapter = { listFiles, downloadFile, prefetchDownloads } as unknown as PterodactylAdapter;
  const authorize = vi.fn(async () => {});
  const collect = async () => collectArchiveEntries(adapter, 'fixture', '', ['world'], authorize);
  const signal = new AbortController();
  const open = async () => {
    const entries = await collect();
    const files = entries.filter((e) => e.file.is_file);
    const read = archiveFileReader(adapter, 'fixture', entries, authorize);
    const member = (i: number) => {
      const file = files[i];
      if (!file) throw Error('missing member');
      return read(file, signal.signal);
    };
    expect(await new Response(await member(0)).text()).toBe('0000');
    return member;
  };
  return {
    adapter,
    listFiles,
    downloadFile,
    prefetchDownloads,
    authorize,
    collect,
    region,
    directories,
    signal,
    open,
  };
}
describe('small-file ZIP exports', () => {
  it.each([100, 1000])(
    'writes the verified data in order and bounds sibling listings for %i files',
    async (n) => {
      const f = fixture(n);
      const entries = await f.collect();
      const zip = Buffer.from(
        await new Response(
          streamFileZip(entries, archiveFileReader(f.adapter, 'fixture', entries, f.authorize)),
        ).arrayBuffer(),
      );
      let count = 0;
      await visitArchive(zip, async (file) => {
        const expected = String(count++).padStart(4, '0');
        expect(file.path).toBe(`world/region/${expected}`);
        expect((await readArchiveFile(file, 4)).toString()).toBe(expected);
      });
      expect(count).toBe(n);
      expect(f.listFiles).toHaveBeenCalledTimes(3 + 3 * (1 + Math.ceil((n - 1) / 8)));
      expect(f.downloadFile).toHaveBeenCalledTimes(n);
      expect(
        f.prefetchDownloads.mock.calls.every(([, paths]) => paths.length > 1 && paths.length <= 8),
      ).toBe(true);
    },
  );
  it('rejects same-sized replacements after collection and before opening the group', async () => {
    const f = fixture(10),
      read = await f.open();
    f.prefetchDownloads.mockImplementation(async () => {
      const previous = f.region[4];
      if (!previous) throw Error('missing fixture');
      f.region[4] = { ...previous, created_at: '2026-01-02T00:00:00Z' };
    });
    await expect(read(1)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.downloadFile).toHaveBeenCalledTimes(1);
  });
  it('checks every ancestor again after an earlier group', async () => {
    const f = fixture(18),
      read = await f.open();
    for (let i = 1; i < 9; i++) await new Response(await read(i)).text();
    f.directories.set('world', [{ ...entry('region', false), is_symlink: true }]);
    await expect(read(9)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.downloadFile).toHaveBeenCalledTimes(9);
  });
  it('checks revoked access before handing out a buffered member', async () => {
    const f = fixture(10),
      read = await f.open();
    await new Response(await read(1)).text();
    f.authorize.mockRejectedValue(new DomainError('forbidden'));
    await expect(read(2)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.downloadFile).toHaveBeenCalledTimes(9);
  });
  it('cancels every pending upstream reader in a group', async () => {
    const f = fixture(10),
      read = await f.open();
    const ready = Promise.withResolvers<void>();
    let active = 0;
    f.downloadFile.mockImplementation(async () => ({
      body: new ReadableStream<Uint8Array>({
        start() {
          if (++active === 8) ready.resolve();
        },
        cancel() {
          active--;
        },
      }),
      contentType: 'application/octet-stream',
    }));
    const result = read(1);
    await ready.promise;
    f.signal.abort(new Error('closed'));
    await expect(result).rejects.toThrow('closed');
    expect(active).toBe(0);
  });
  it.each(['xx', 'xxxxx'])('rejects changed body length in a group', async (body) => {
    const f = fixture(10),
      read = await f.open();
    f.downloadFile.mockImplementation(async () => ({
      body: new Blob([body]).stream(),
      contentType: 'application/octet-stream',
    }));
    await expect(read(1)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('streams a large file without reading its body ahead', async () => {
    const f = fixture(17);
    const files = (await f.collect()).filter((e) => e.file.is_file);
    const big = files[1] as ArchiveEntry;
    big.file.size = 512 * 1024 + 1;
    const read = archiveFileReader(f.adapter, 'fixture', files, f.authorize);
    await new Response(await read(files[0] as ArchiveEntry, f.signal.signal)).text();
    const body = await read(big, f.signal.signal);
    expect(f.downloadFile).toHaveBeenCalledTimes(2);
    expect(f.prefetchDownloads).not.toHaveBeenCalled();
    await body.cancel();
  });
});
