import { DomainError } from '@nickhosting/core';
import { type PterodactylAdapter, PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { describe, expect, it, vi } from 'vitest';
import { createFilemanReadService } from './fileman-read.js';

function fixture() {
  const adapter = {
    readFile: vi.fn(),
    readFileForEditor: vi.fn(async (_id: string, path: string) => Buffer.from(path)),
    prefetchDownloads: vi.fn(async () => {}),
    listFiles: vi.fn(async () => [{ name: 'config', is_file: true, is_symlink: false, size: 5 }]),
    downloadFile: vi.fn(async () => ({ body: new Response('large').body })),
  };
  const authorize = vi.fn(async () => {});
  const files = createFilemanReadService({
    adapter: adapter as unknown as PterodactylAdapter,
    identifier: 'managed',
    authorize,
  });
  return { adapter, authorize, files };
}

describe('shared Fileman reads for trusted integrations', () => {
  it('prepares a group once, reads directly through the Fileman signed transport, and never lists for known files', async () => {
    const f = fixture();
    const requests = ['ops.json', 'whitelist.json', 'banned-players.json', 'server.properties'].map(
      (path) => ({ path, maxBytes: 1024 }),
    );
    const result = await f.files.readMany(requests);
    expect(Buffer.from(result.get('ops.json') ?? []).toString()).toBe('ops.json');
    expect(f.adapter.prefetchDownloads).toHaveBeenCalledExactlyOnceWith(
      'managed',
      requests.map(({ path }) => path),
    );
    expect(f.adapter.readFileForEditor).toHaveBeenCalledTimes(4);
    expect(f.adapter.readFile).not.toHaveBeenCalled();
    expect(f.adapter.listFiles).not.toHaveBeenCalled();
  });
  it('keeps fresh byte snapshots and deduplicates only directory metadata inside a single scope', async () => {
    const f = fixture();
    await Promise.all([f.files.list(''), f.files.list('')]);
    await f.files.read({ path: 'config', maxBytes: 1024 });
    f.adapter.readFileForEditor.mockResolvedValueOnce(Buffer.from('updated'));
    expect(
      Buffer.from((await f.files.read({ path: 'config', maxBytes: 1024 })) ?? []).toString(),
    ).toBe('updated');
    expect(f.adapter.listFiles).toHaveBeenCalledTimes(1);
    expect(f.adapter.readFileForEditor).toHaveBeenCalledTimes(2);
  });
  it('only treats an explicit 404 as an absent optional file', async () => {
    const f = fixture();
    f.adapter.readFileForEditor.mockRejectedValueOnce(
      new PterodactylError('not_found', 'client', 'rejected', 404),
    );
    expect(
      await f.files.read({ path: 'ops.json', maxBytes: 1024, missing: 'allow' }),
    ).toBeUndefined();
    f.adapter.readFileForEditor.mockRejectedValueOnce(
      new PterodactylError('unavailable', 'client', 'rejected', 503),
    );
    await expect(
      f.files.read({ path: 'ops.json', maxBytes: 1024, missing: 'allow' }),
    ).rejects.toMatchObject({ upstreamStatus: 503 });
  });
  it('rejects paths, oversized batches and revoked access before provider reads', async () => {
    const f = fixture();
    await expect(f.files.read({ path: '../secret', maxBytes: 1024 })).rejects.toBeDefined();
    await expect(
      f.files.readMany(
        Array.from({ length: 17 }, (_, i) => ({ path: `${i}`, maxBytes: 1024 ** 2 })),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    f.authorize.mockRejectedValueOnce(new DomainError('forbidden'));
    await expect(f.files.read({ path: 'config', maxBytes: 1024 })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(f.adapter.readFileForEditor).not.toHaveBeenCalled();
  });
  it('does not publish bytes after authorization is revoked during the read', async () => {
    const f = fixture();
    f.adapter.readFileForEditor.mockImplementationOnce(async () => {
      f.authorize.mockRejectedValueOnce(new DomainError('forbidden'));
      return Buffer.from('private');
    });
    await expect(f.files.read({ path: 'config', maxBytes: 1024 })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('bounds read concurrency to four and settles active workers before a failed batch returns', async () => {
    const f = fixture();
    let active = 0;
    let maximum = 0;
    f.adapter.readFileForEditor.mockImplementation(async (_id, path) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active--;
      if (path === 'bad') throw new DomainError('conflict');
      return Buffer.from(path);
    });
    await expect(
      f.files.readMany(
        ['a', 'bad', 'b', 'c', 'd', 'e', 'f'].map((path) => ({ path, maxBytes: 1024 })),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(maximum).toBe(4);
    expect(active).toBe(0);
  });
  it('uses the runtime batch transport and makes its listing reusable without downloading unrelated files', async () => {
    const f = fixture();
    const listDirectories = vi.fn(async (paths: string[]) =>
      paths.map((directory) => ({ directory, files: [] })),
    );
    const files = createFilemanReadService({
      adapter: f.adapter as unknown as PterodactylAdapter,
      identifier: 'managed',
      authorize: f.authorize,
      listDirectories,
    });
    expect(await files.listMany(['a', 'b'])).toEqual([
      { directory: 'a', files: [] },
      { directory: 'b', files: [] },
    ]);
    expect(await files.list('a')).toEqual([]);
    expect(listDirectories).toHaveBeenCalledOnce();
    expect(f.adapter.listFiles).not.toHaveBeenCalled();
    expect(f.adapter.prefetchDownloads).not.toHaveBeenCalled();
    expect(f.adapter.readFileForEditor).not.toHaveBeenCalled();
  });
  it('does not conceal a forbidden Blueprint response behind a native fallback', async () => {
    const f = fixture();
    const files = createFilemanReadService({
      adapter: f.adapter as unknown as PterodactylAdapter,
      identifier: 'managed',
      authorize: f.authorize,
      listDirectories: async () => {
        throw new PterodactylError('permission_denied', 'client', 'rejected', 403);
      },
    });
    await expect(files.listMany(['a'])).rejects.toMatchObject({ upstreamStatus: 403 });
    expect(f.adapter.listFiles).not.toHaveBeenCalled();
  });
  it('falls back only for an absent optional batch endpoint and keeps missing distinct from unavailable', async () => {
    const f = fixture();
    f.adapter.listFiles.mockImplementation(async (...args: unknown[]) => {
      const path = args[1];
      if (path === 'gone') throw new PterodactylError('not_found', 'client', 'rejected', 404);
      if (path === 'broken') throw new PterodactylError('unavailable', 'client', 'rejected', 503);
      return [];
    });
    const files = createFilemanReadService({
      adapter: f.adapter as unknown as PterodactylAdapter,
      identifier: 'managed',
      authorize: f.authorize,
      listDirectories: async () => {
        throw new PterodactylError('not_found', 'client', 'rejected', 404);
      },
    });
    expect(await files.listMany(['present', 'gone', 'broken'])).toEqual([
      { directory: 'present', files: [] },
      { directory: 'gone', error: 'not_found' },
      { directory: 'broken', error: 'unavailable' },
    ]);
    expect(f.adapter.listFiles).toHaveBeenCalledTimes(3);
    expect(f.adapter.prefetchDownloads).not.toHaveBeenCalled();
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it('bounds larger binary metadata while reading its signed stream', async () => {
    const f = fixture();
    f.adapter.downloadFile.mockResolvedValueOnce({
      body: new Response(new Uint8Array(1024 ** 2 + 2)).body,
    });
    await expect(
      f.files.read({ path: 'world/level.dat', maxBytes: 1024 ** 2 + 1 }),
    ).rejects.toMatchObject({ code: 'validation_failed', status: 413 });
    expect(f.adapter.readFileForEditor).not.toHaveBeenCalled();
  });
});
