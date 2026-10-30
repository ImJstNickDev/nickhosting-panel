import { createTestDatabase } from '@nickhosting/database/testing';
import { fabricCatalogUrls, type RuntimeMetadataClient } from '@nickhosting/minecraft';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  getFabricCatalog,
  refreshFabricCatalog,
  requestFabricCatalogRefresh,
} from './fabric-catalog.js';
import { minecraftMetadataRefreshMs } from './minecraft-metadata.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const base = new Date('2026-10-20T10:00:00Z');
let now = base;
function client(version = '1.0') {
  return {
    read: vi.fn(async (url: string) => ({
      bytes: new TextEncoder().encode(
        JSON.stringify(
          url.startsWith(`${fabricCatalogUrls.loaders}/`)
            ? [{ loader: { version } }, { loader: { version: '0.1' } }]
            : [
                { version, stable: false },
                { version: '0.1', stable: true },
              ],
        ),
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
  await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(2));
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

it('durably coalesces concurrent requests, bypasses the interval and respects attempt cooldown', async () => {
  await refresh(client());
  now = new Date(base.getTime() + 10_000);
  const requests = await Promise.all(
    Array.from({ length: 8 }, () => requestFabricCatalogRefresh(database.db, now)),
  );
  expect(requests.every((catalog) => catalog.status.syncState === 'queued')).toBe(true);
  let row = await database.db
    .selectFrom('minecraft_metadata_sync')
    .selectAll()
    .where('id', '=', 'fabric')
    .executeTakeFirstOrThrow();
  expect(row.requested_at).toEqual(now);
  expect(row.next_check_at).toEqual(new Date(base.getTime() + 60_000));
  const source = client();
  expect((await refresh(source)).state).toBe('skipped');
  expect(source.read).not.toHaveBeenCalled();
  now = new Date(base.getTime() + 60_000);
  expect((await refresh(source)).state).toBe('unchanged');
  row = await database.db
    .selectFrom('minecraft_metadata_sync')
    .selectAll()
    .where('id', '=', 'fabric')
    .executeTakeFirstOrThrow();
  expect(row.requested_at).toBeNull();
  expect((await getFabricCatalog(database.db, now)).status.syncState).toBe('idle');
});
it('keeps a queued request durable throughout a slow download and coalesces in-flight clicks', async () => {
  await requestFabricCatalogRefresh(database.db, now);
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const source = client();
  const read = source.read.getMockImplementation();
  if (!read) throw new Error('missing fixture');
  source.read.mockImplementation(async (url) => {
    await blocked;
    return read(url);
  });
  const pending = refresh(source);
  await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(2));
  now = new Date(base.getTime() + 5_000);
  expect((await requestFabricCatalogRefresh(database.db, now)).status.syncState).toBe('refreshing');
  const row = await database.db
    .selectFrom('minecraft_metadata_sync')
    .selectAll()
    .where('id', '=', 'fabric')
    .executeTakeFirstOrThrow();
  expect(row.requested_at).toEqual(base);
  unblock?.();
  expect((await pending).state).toBe('updated');
  expect((await getFabricCatalog(database.db, now)).status.syncState).toBe('idle');
});
it('recovers a crashed worker request and fences stale failures as well as publications', async () => {
  await requestFabricCatalogRefresh(database.db, now);
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const source: RuntimeMetadataClient = {
    read: vi.fn(async () => {
      await blocked;
      throw new Error('old failure');
    }),
  };
  const pending = refresh(source);
  await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(2));
  now = new Date(base.getTime() + 60_001);
  expect((await getFabricCatalog(database.db, now)).status.syncState).toBe('queued');
  expect((await refresh(client('2.0'))).state).toBe('updated');
  unblock?.();
  expect((await pending).state).toBe('skipped');
  expect(await getFabricCatalog(database.db, now)).toMatchObject({
    latestInstallerVersion: '2.0',
    status: { lastError: null, syncState: 'idle' },
  });
});
it('replaces historical relation snapshots with independent lists without per-game reads', async () => {
  const old = {
    games: [{ version: '1.0', stable: true }],
    loaders: [{ version: '1.0', stable: true }],
    installers: [{ version: '1.0', stable: true }],
    relations: {
      checkedAt: base.toISOString(),
      loaderSets: [['1.0']],
      gameLoaderSets: { '1.0': 0 },
    },
  };
  await database.db
    .updateTable('minecraft_metadata_sync')
    .set({ manifest_json: JSON.stringify(old), last_success_at: base })
    .where('id', '=', 'fabric')
    .execute();
  expect((await getFabricCatalog(database.db, now)).relations).toBeDefined();
  const source = client();
  expect((await refresh(source)).state).toBe('updated');
  expect(source.read.mock.calls.map(([url]) => url)).toEqual(Object.values(fabricCatalogUrls));
  expect((await getFabricCatalog(database.db, now)).relations).toBeUndefined();
});
it('renews a live lease between root batches and retains unchanged snapshots', async () => {
  const source = client();
  const read = source.read.getMockImplementation();
  if (!read) throw new Error('Missing fixture implementation');
  source.read.mockImplementation(async (url) => {
    now = new Date(now.getTime() + 15_000);
    return read(url);
  });
  expect((await refresh(source)).state).toBe('updated');
  now = new Date(now.getTime() + 24 * 60 * 60_000);
  const next = client();
  expect((await refresh(next)).state).toBe('unchanged');
  expect(next.read).toHaveBeenCalledTimes(3);
});
it('does not publish after the run deadline', async () => {
  const source = client();
  const read = source.read.getMockImplementation();
  if (!read) throw new Error('Missing fixture implementation');
  source.read.mockImplementation(async (url) => {
    now = new Date(now.getTime() + 100_000);
    return read(url);
  });
  expect((await refresh(source)).state).toBe('skipped');
  expect(source.read).toHaveBeenCalledTimes(2);
  expect((await getFabricCatalog(database.db, now)).synced).toBe(false);
});
it('safely serves old cache and skips work before migration 046', async () => {
  await sql`alter table minecraft_metadata_sync drop column requested_at`.execute(database.db);
  try {
    expect((await getFabricCatalog(database.db, now)).status.syncState).toBe('idle');
    await expect(requestFabricCatalogRefresh(database.db, now)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
    const source = client();
    expect((await refresh(source)).state).toBe('skipped');
    expect(source.read).not.toHaveBeenCalled();
  } finally {
    await sql`alter table minecraft_metadata_sync add column requested_at timestamptz`.execute(
      database.db,
    );
  }
});
