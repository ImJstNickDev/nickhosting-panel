import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { describe, expect, it, vi } from 'vitest';
import { createScopedProviderAdapter } from './scoped-provider-adapter.js';
import { createUploadTiming } from './upload-timing.js';

describe('managed owner Client credential dispatch', () => {
  it.each([
    'getClientServer',
    'getClientPermissions',
    'getResources',
    'power',
    'reinstall',
    'sendCommand',
    'listFiles',
    'readFile',
    'readFileForEditor',
    'prefetchDownloads',
    'invalidateFileDownloads',
    'writeFile',
    'deleteFiles',
    'createDirectory',
    'renameFiles',
    'listBackups',
    'listBackupActivity',
    'listPowerActivity',
    'getBackup',
    'createBackup',
    'deleteBackup',
    'restoreBackup',
    'downloadBackup',
    'downloadFile',
    'uploadFile',
    'prepareUpload',
    'prepareUploadBatch',
    'relayConsole',
  ] as const)('scopes %s to the managed owner', async (method) => {
    const result = {};
    const owner = { [method]: vi.fn().mockResolvedValue(result) } as unknown as PterodactylAdapter;
    const resolve = vi.fn().mockResolvedValue(owner);
    const scoped = createScopedProviderAdapter({} as PterodactylAdapter, resolve);
    expect(await Reflect.apply(scoped[method], scoped, ['managed-identifier'])).toBe(result);
    expect(resolve).toHaveBeenCalledWith('managed-identifier');
  });

  it('keeps concurrent read timings request-local through credential resolution and content dispatch', async () => {
    const body = new Uint8Array([1]);
    const readFile = vi.fn(async () => body);
    const resolve = vi.fn(async () => ({ readFile }) as unknown as PterodactylAdapter);
    const scoped = createScopedProviderAdapter({} as PterodactylAdapter, resolve);
    const first = createUploadTiming(),
      second = createUploadTiming();
    await Promise.all([
      scoped.readFile('server-a', 'a.txt', 100, first),
      scoped.readFile('server-b', 'b.txt', 100, second),
    ]);
    expect(resolve).toHaveBeenCalledWith('server-a', first);
    expect(resolve).toHaveBeenCalledWith('server-b', second);
    expect(readFile).toHaveBeenCalledWith('server-a', 'a.txt', 100, first);
    expect(readFile).toHaveBeenCalledWith('server-b', 'b.txt', 100, second);
    await scoped.readFile('server-a', 'a.txt');
    expect(resolve).toHaveBeenLastCalledWith('server-a');
    expect(readFile).toHaveBeenLastCalledWith('server-a', 'a.txt');
  });

  it('discovers Application scopes without probing a nonexistent shared Client key', async () => {
    const application = {
      discoverCapabilities: vi.fn().mockResolvedValue({ nodes: { available: true } }),
    } as unknown as PterodactylAdapter;
    const resolve = vi.fn();
    const scoped = createScopedProviderAdapter(application, resolve);
    expect(await scoped.discoverCapabilities()).toEqual({ nodes: { available: true } });
    expect(application.discoverCapabilities).toHaveBeenCalledWith(false);
    expect(resolve).not.toHaveBeenCalled();
  });
  it('routes composites by identifier, streams unchanged, and keeps Application calls shared', async () => {
    const application = {
      getNode: vi.fn().mockResolvedValue({ id: 1 }),
    } as unknown as PterodactylAdapter;
    const stream = new ReadableStream();
    const owner = {
      stopWithConfirmation: vi.fn().mockResolvedValue({ confirmed: true }),
      downloadFile: vi.fn().mockResolvedValue(stream),
    } as unknown as PterodactylAdapter;
    const resolve = vi.fn().mockResolvedValue(owner);
    const scoped = createScopedProviderAdapter(application, resolve);
    await scoped.stopWithConfirmation(123, 'abcdefgh', {} as never);
    expect(resolve).toHaveBeenCalledWith('abcdefgh');
    expect(owner.stopWithConfirmation).toHaveBeenCalledWith(123, 'abcdefgh', {});
    expect(await scoped.downloadFile('abcdefgh', 'world.zip', {} as never)).toBe(stream);
    await scoped.getNode(1);
    expect(application.getNode).toHaveBeenCalledWith(1);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it('does not cache credentials across rotation or fall back for unknown servers', async () => {
    const first = { power: vi.fn().mockResolvedValue(undefined) } as unknown as PterodactylAdapter;
    const second = { power: vi.fn().mockResolvedValue(undefined) } as unknown as PterodactylAdapter;
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockRejectedValue(new Error('unlinked'));
    const scoped = createScopedProviderAdapter({} as PterodactylAdapter, resolve);
    await scoped.power('abcdefgh', 'start');
    await scoped.power('abcdefgh', 'stop');
    expect(first.power).toHaveBeenCalledWith('abcdefgh', 'start');
    expect(second.power).toHaveBeenCalledWith('abcdefgh', 'stop');
    await expect(scoped.power('foreign', 'start')).rejects.toThrow('unlinked');
    await expect(scoped.listClientServers(true)).rejects.toThrow();
    await expect(scoped.getAccount()).rejects.toThrow();
  });
});
