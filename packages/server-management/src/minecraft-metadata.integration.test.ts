import { createHash } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { minecraftManifestUrl, type RuntimeMetadataClient } from '@nickhosting/minecraft';
import { afterAll, beforeAll, beforeEach, expect, it, type Mock, vi } from 'vitest';
import {
  cachedMinecraftManifest,
  getMinecraftMetadataStatus,
  minecraftMetadataRefreshMs,
  refreshMinecraftMetadata,
} from './minecraft-metadata.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const base = new Date('2026-10-10T10:00:00Z');
let now = base;
const release = (id: string, hash = 'a') => ({
  id,
  type: 'release',
  url: `https://piston-meta.mojang.com/v1/packages/${hash.repeat(40)}/${id}.json`,
  sha1: hash.repeat(40),
  releaseTime: '2026-01-01T00:00:00Z',
});
function client(
  versions: unknown[],
): RuntimeMetadataClient & { read: Mock<RuntimeMetadataClient['read']> } {
  const bytes = new TextEncoder().encode(JSON.stringify({ versions }));
  return {
    read: vi.fn(async () => ({
      bytes,
      evidence: {
        url: minecraftManifestUrl,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        retrievedAt: now.toISOString(),
      },
    })),
  };
}
const refresh = (source: RuntimeMetadataClient) =>
  refreshMinecraftMetadata(database.db, { client: source, now: () => now });
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  await database.db.deleteFrom('minecraft_release_metadata').execute();
  await database.db.deleteFrom('minecraft_metadata_sync').execute();
  now = new Date(base);
});
it('persists a validated local manifest and skips network until the 15-minute due time', async () => {
  const source = client([release('1.21.1')]);
  expect(await refresh(source)).toEqual({ state: 'updated', changed: 1 });
  expect(await refresh(source)).toEqual({ state: 'skipped', changed: 0 });
  expect(source.read).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(new TextDecoder().decode((await cachedMinecraftManifest(database.db)).bytes))
      .versions,
  ).toHaveLength(1);
  expect(await getMinecraftMetadataStatus(database.db, now)).toMatchObject({
    stale: false,
    lastSuccessAt: base.toISOString(),
    lastError: null,
  });
  now = new Date(base.getTime() + minecraftMetadataRefreshMs);
  expect(await refresh(source)).toEqual({ state: 'unchanged', changed: 0 });
  expect(source.read).toHaveBeenCalledTimes(2);
});
it('updates only new or changed entries, retaining known dates on upstream omissions', async () => {
  await refresh(client([release('1.21.1'), release('1.21.2')]));
  now = new Date(base.getTime() + minecraftMetadataRefreshMs);
  expect(
    await refresh(client([release('1.21.1'), release('1.21.2', 'b'), release('26.1')])),
  ).toEqual({ state: 'updated', changed: 2 });
  now = new Date(now.getTime() + minecraftMetadataRefreshMs);
  expect(await refresh(client([release('26.1')]))).toEqual({ state: 'updated', changed: 0 });
  expect(
    await database.db.selectFrom('minecraft_release_metadata').selectAll().execute(),
  ).toHaveLength(3);
});
it('preserves last good data on invalid or failed upstream refresh and retries with a bounded delay', async () => {
  await expect(cachedMinecraftManifest(database.db)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
  await refresh(client([release('1.21.1')]));
  now = new Date(base.getTime() + minecraftMetadataRefreshMs + 1);
  expect(await refresh(client([{ ...release('26.1'), url: 'http://localhost/private' }]))).toEqual({
    state: 'failed',
    changed: 0,
  });
  expect(await getMinecraftMetadataStatus(database.db, now)).toMatchObject({
    stale: true,
    lastSuccessAt: base.toISOString(),
    lastError: 'minecraft_metadata_refresh_failed',
  });
  expect(
    JSON.parse(new TextDecoder().decode((await cachedMinecraftManifest(database.db)).bytes))
      .versions[0].id,
  ).toBe('1.21.1');
  const failed = {
    read: vi.fn(async () => {
      throw new Error('sensitive failure');
    }),
  };
  expect((await refresh(failed)).state).toBe('skipped');
  now = new Date(now.getTime() + 60_000);
  expect((await refresh(failed)).state).toBe('failed');
  expect((await getMinecraftMetadataStatus(database.db, now)).lastError).not.toContain('sensitive');
});
it('elects one downloader across concurrent workers', async () => {
  const source = client([release('1.21.1')]);
  let releaseRead: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const firstRead = source.read.getMockImplementation();
  source.read.mockImplementation(async () => {
    await blocked;
    if (!firstRead) throw new Error('missing fixture read');
    return firstRead(minecraftManifestUrl);
  });
  const pending = refresh(source);
  await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(1));
  expect((await refresh(source)).state).toBe('skipped');
  releaseRead?.();
  expect((await pending).state).toBe('updated');
  expect(source.read).toHaveBeenCalledTimes(1);
});
it('recovers expired leases and fences late downloader commits', async () => {
  const source = client([release('old')]);
  let releaseRead: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const firstRead = source.read.getMockImplementation();
  source.read.mockImplementation(async () => {
    await blocked;
    if (!firstRead) throw new Error('missing fixture read');
    return firstRead(minecraftManifestUrl);
  });
  const pending = refresh(source);
  await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(1));
  now = new Date(now.getTime() + 60_001);
  expect((await refresh(client([release('new')]))).state).toBe('updated');
  releaseRead?.();
  expect((await pending).state).toBe('skipped');
  const rows = await database.db.selectFrom('minecraft_release_metadata').select('id').execute();
  expect(rows).toEqual([{ id: 'new' }]);
});
