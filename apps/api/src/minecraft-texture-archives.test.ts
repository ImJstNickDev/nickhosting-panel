import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ZipFile as ReadZip } from 'yauzl';
import { ZipFile } from 'yazl';
import { openTextureArchive } from './minecraft-texture-archives.js';
import { ViewerCache, type ViewerReadSource } from './viewer-cache.js';

it('reuses only validated ZIP locators across source leases and rechecks entry contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nh-zip-locators-'));
  const cache = new ViewerCache({ root });
  const listing = vi.spyOn(ReadZip.prototype, 'eachEntry');
  try {
    const path = 'assets/example/models/item/example.json';
    const file = new ZipFile();
    file.addBuffer(Buffer.from('original model'), path, { compress: false });
    file.addBuffer(Buffer.from('ignored'), 'META-INF/unused', { compress: false });
    file.end();
    const chunks: Buffer[] = [];
    for await (const part of file.outputStream) chunks.push(Buffer.from(part));
    const bytes = Buffer.concat(chunks);
    const jar = {
      path: 'mods/example.jar',
      size: bytes.length,
      modifiedAt: new Date(0).toISOString(),
    };
    function lease(data: Buffer, key = 'same source revision', freshMtime = 0) {
      const source: ViewerReadSource = {
        size: data.length,
        mtimeMs: 0,
        read: async (offset, length) => data.subarray(offset, offset + length),
        stream: vi.fn(
          (start, end) =>
            new ReadableStream({
              start(controller) {
                controller.enqueue(data.subarray(start, end));
                controller.close();
              },
            }),
        ),
      };
      return {
        source,
        key,
        cache,
        signal: new AbortController().signal,
        restat: async () => ({ size: data.length, mtimeMs: freshMtime, mode: 0o644 }),
        close: vi.fn(async () => {}),
      };
    }
    const first = lease(bytes);
    const scanned = await openTextureArchive(jar, first);
    expect([...scanned.assets()]).toEqual([path]);
    await scanned.close();
    expect(first.close).toHaveBeenCalledOnce();
    const next = lease(bytes);
    const reused = await openTextureArchive(jar, next);
    expect(listing).toHaveBeenCalledOnce();
    await expect(reused.read(path, 2)).rejects.toMatchObject({ code: 'viewer_archive_budget' });
    expect(next.source.stream).not.toHaveBeenCalled();
    expect(await reused.read(path, 64)).toEqual(Buffer.from('original model'));
    expect(next.source.stream).toHaveBeenCalledOnce();
    expect(first.source.stream).not.toHaveBeenCalled();
    await reused.close();
    const damaged = Buffer.from(bytes);
    damaged[damaged.indexOf('original model')] = 0;
    const broken = await openTextureArchive(jar, lease(damaged));
    await expect(broken.read(path, 64)).rejects.toMatchObject({ code: 'viewer_archive_integrity' });
    await broken.close();
    const changed = await openTextureArchive(jar, lease(bytes, 'new source revision', 100));
    expect(listing).toHaveBeenCalledTimes(2);
    await expect(changed.close()).rejects.toMatchObject({ code: 'conflict' });
    const retried = await openTextureArchive(jar, lease(bytes, 'new source revision'));
    expect(listing).toHaveBeenCalledTimes(3);
    await retried.close();
  } finally {
    listing.mockRestore();
    await cache.close();
    await rm(root, { recursive: true, force: true });
  }
});
