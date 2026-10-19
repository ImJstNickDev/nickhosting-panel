import { createTestDatabase } from '@nickhosting/database/testing';
import { fabricCatalogUrls, type RuntimeMetadataClient } from '@nickhosting/minecraft';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { getFabricCatalog, refreshFabricCatalog } from './fabric-catalog.js';
import { minecraftMetadataRefreshMs } from './minecraft-metadata.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const base = new Date('2026-10-20T10:00:00Z');
let now = base;
function client(version = '1.0') {
  return {
    read: vi.fn(async (url: string) => ({
      bytes: new TextEncoder().encode(
        JSON.stringify([
          { version, stable: false },
          { version: '0.1', stable: true },
        ]),
      ),
      evidence: { url, sha256: 'a'.repeat(64), retrievedAt: now.toISOString() },
    })),
  } satisfies RuntimeMetadataClient;
}
const refresh = (source: RuntimeMetadataClient) =>
  refreshFabricCatalog(database.db, { client: source, now: () => now });
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  now = new Date(base);
  await database.db.deleteFrom('minecraft_metadata_sync').where('id', '=', 'fabric').execute();
  await database.db
    .insertInto('minecraft_metadata_sync')
    .values({
      id: 'fabric',
      manifest_json: null,
      manifest_hash: null,
      last_checked_at: null,
      last_success_at: null,
      next_check_at: base,
      last_error: null,
      lease_id: null,
      lease_until: null,
    })
    .execute();
});
it('reads empty before migration/sync, stores three lists and uses latest first installer regardless of stable', async () => {
  expect(await getFabricCatalog(database.db, now)).toMatchObject({
    games: [],
    loaders: [],
    installers: [],
    synced: false,
    latestInstallerVersion: null,
  });
  const source = client();
  expect(await refresh(source)).toEqual({ state: 'updated', changed: 6 });
  expect(await getFabricCatalog(database.db, now)).toMatchObject({
    synced: true,
    latestInstallerVersion: '1.0',
    status: { stale: false },
  });
  expect(await refresh(source)).toEqual({ state: 'skipped', changed: 0 });
  expect(source.read).toHaveBeenCalledTimes(3);
  now = new Date(now.getTime() + minecraftMetadataRefreshMs);
  expect(await refresh(source)).toEqual({ state: 'unchanged', changed: 0 });
  expect(source.read).toHaveBeenCalledTimes(6);
  await database.db.deleteFrom('minecraft_metadata_sync').where('id', '=', 'fabric').execute();
  expect((await refresh(source)).state).toBe('skipped');
  expect((await getFabricCatalog(database.db, now)).synced).toBe(false);
});
it('retains complete last-good snapshot when one source fails and throttles retries', async () => {
  await refresh(client());
  now = new Date(now.getTime() + minecraftMetadataRefreshMs);
  const broken = client('2.0');
  const original = broken.read.getMockImplementation();
  broken.read.mockImplementation(async (url) => {
    if (url === fabricCatalogUrls.installers) throw new Error('secret upstream response');
    if (!original) throw new Error('fixture');
    return original(url);
  });
  expect((await refresh(broken)).state).toBe('failed');
  const catalog = await getFabricCatalog(database.db, now);
  expect(catalog.games[0]?.version).toBe('1.0');
  expect(catalog.status).toMatchObject({
    stale: true,
    lastError: 'fabric_metadata_refresh_failed',
    lastSuccessAt: base.toISOString(),
  });
  expect(JSON.stringify(catalog)).not.toContain('secret');
  expect((await refresh(broken)).state).toBe('skipped');
  expect(broken.read).toHaveBeenCalledTimes(3);
  now = new Date(now.getTime() + 60_000);
  expect((await refresh(client('2.0'))).state).toBe('updated');
});
it('elects one concurrent downloader and fences expired leases', async () => {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = client();
  const original = source.read.getMockImplementation();
  source.read.mockImplementation(async (url) => {
    await blocked;
    if (!original) throw new Error('fixture');
    return original(url);
  });
  const pending = refresh(source);
  await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(3));
  expect((await refresh(client('2.0'))).state).toBe('skipped');
  now = new Date(now.getTime() + 60_001);
  expect((await refresh(client('2.0'))).state).toBe('updated');
  release?.();
  expect((await pending).state).toBe('skipped');
  expect((await getFabricCatalog(database.db, now)).latestInstallerVersion).toBe('2.0');
});
it('does not alter combinations, Mojang metadata or availability', async () => {
  const before = await database.db.selectFrom('minecraft_combinations').selectAll().execute();
  await refresh(client());
  expect(await database.db.selectFrom('minecraft_combinations').selectAll().execute()).toEqual(
    before,
  );
  expect(await database.db.selectFrom('minecraft_release_metadata').selectAll().execute()).toEqual(
    [],
  );
});
