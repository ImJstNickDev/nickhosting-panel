import { createHash } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { paperCatalogUrl, type RuntimeMetadataClient } from '@nickhosting/minecraft';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { minecraftMetadataRefreshMs } from './minecraft-metadata.js';
import {
  getPaperCatalog,
  getPaperCatalogSnapshot,
  refreshPaperCatalog,
  requestPaperCatalogRefresh,
} from './paper-catalog.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const base = new Date('2026-10-21T10:00:00Z');
let now = base;
function client(buildId = 5) {
  const responses: Record<string, unknown> = {
    [paperCatalogUrl]: {
      project: { id: 'paper' },
      versions: { fixtures: ['1.21.11', '1.7.10'] },
    },
  };
  for (const version of ['1.21.11', '1.7.10']) {
    const url = `${paperCatalogUrl}/versions/${version}`;
    responses[url] = {
      version: { id: version, java: { version: { minimum: version === '1.7.10' ? 6 : 21 } } },
      builds: [buildId, 1],
    };
    responses[`${url}/builds/${buildId}`] = {
      id: buildId,
      time: base.toISOString(),
      channel: 'STABLE',
      downloads: {
        'server:default': {
          url: 'https://fill-data.papermc.io/v1/objects/pinned/server.jar',
          checksums: { sha256: 'a'.repeat(64) },
          size: 1234,
        },
      },
    };
  }
  return {
    read: vi.fn(async (url: string) => {
      const json = responses[url];
      if (!json) throw new Error('missing fixture');
      const bytes = new TextEncoder().encode(JSON.stringify(json));
      return {
        bytes,
        evidence: {
          url,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          retrievedAt: now.toISOString(),
        },
      };
    }),
  } satisfies RuntimeMetadataClient;
}
const refresh = (source: RuntimeMetadataClient) =>
  refreshPaperCatalog(database.db, { client: source, now: () => now });
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  now = new Date(base);
  await database.db.deleteFrom('minecraft_metadata_sync').where('id', '=', 'paper').execute();
  await database.db
    .insertInto('minecraft_metadata_sync')
    .values({
      id: 'paper',
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

it('serves local versions and exact-build metadata without foreground downloads or provider details in the response', async () => {
  expect(await getPaperCatalog(database.db, now)).toMatchObject({ versions: [], synced: false });
  expect(await getPaperCatalogSnapshot(database.db)).toBeNull();
  const source = client();
  expect(await refresh(source)).toEqual({ state: 'updated', changed: 2 });
  const catalog = await getPaperCatalog(database.db, now);
  expect(catalog).toMatchObject({
    versions: [
      { version: '1.21.11', buildId: 5, javaMajor: 21 },
      { version: '1.7.10', buildId: 5, javaMajor: 8 },
    ],
    synced: true,
    status: { stale: false, syncState: 'idle' },
  });
  expect(catalog).not.toHaveProperty('documents');
  const snapshot = await getPaperCatalogSnapshot(database.db);
  expect(snapshot?.documents[`${paperCatalogUrl}/versions/1.21.11/builds/5`]).toBeDefined();
  expect(await refresh(source)).toEqual({ state: 'skipped', changed: 0 });
  expect(source.read).toHaveBeenCalledTimes(5);
});

it('rechecks every fifteen minutes, keeps unchanged provenance and reuses exact build documents', async () => {
  const source = client();
  await refresh(source);
  const first = await getPaperCatalogSnapshot(database.db);
  now = new Date(base.getTime() + minecraftMetadataRefreshMs);
  expect((await getPaperCatalog(database.db, now)).status.stale).toBe(true);
  source.read.mockClear();
  expect(await refresh(source)).toEqual({ state: 'unchanged', changed: 0 });
  expect(source.read.mock.calls.map(([url]) => url)).toEqual([
    paperCatalogUrl,
    `${paperCatalogUrl}/versions/1.21.11`,
    `${paperCatalogUrl}/versions/1.7.10`,
  ]);
  expect(await getPaperCatalogSnapshot(database.db)).toEqual(first);
  expect((await getPaperCatalog(database.db, now)).status).toMatchObject({
    stale: false,
    lastSuccessAt: now.toISOString(),
    nextCheckAt: new Date(now.getTime() + minecraftMetadataRefreshMs).toISOString(),
  });
});

it('coalesces concurrent manual requests durably and limits rapid retries', async () => {
  await refresh(client());
  now = new Date(base.getTime() + 10_000);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => requestPaperCatalogRefresh(database.db, now)),
  );
  expect(results.every((catalog) => catalog.status.syncState === 'queued')).toBe(true);
  expect(results.every((catalog) => catalog.versions[0]?.buildId === 5)).toBe(true);
  const source = client(6);
  expect((await refresh(source)).state).toBe('skipped');
  expect(source.read).not.toHaveBeenCalled();
  now = new Date(base.getTime() + 60_000);
  expect((await refresh(source)).state).toBe('updated');
  expect((await getPaperCatalog(database.db, now)).status.syncState).toBe('idle');
  expect((await getPaperCatalog(database.db, now)).versions[0]?.buildId).toBe(6);
});

it('retains last-good data on upstream failure and does not leak errors or modify other catalogs', async () => {
  await refresh(client());
  const first = await getPaperCatalogSnapshot(database.db);
  const others = await database.db
    .selectFrom('minecraft_metadata_sync')
    .selectAll()
    .where('id', '!=', 'paper')
    .orderBy('id')
    .execute();
  const combinations = await database.db.selectFrom('minecraft_combinations').selectAll().execute();
  now = new Date(base.getTime() + minecraftMetadataRefreshMs);
  const source = client();
  source.read.mockRejectedValue(new Error('secret provider response'));
  expect((await refresh(source)).state).toBe('failed');
  expect(await getPaperCatalogSnapshot(database.db)).toEqual(first);
  const catalog = await getPaperCatalog(database.db, now);
  expect(catalog.status).toMatchObject({
    stale: true,
    lastError: 'paper_metadata_refresh_failed',
    lastSuccessAt: base.toISOString(),
  });
  expect(JSON.stringify(catalog)).not.toContain('secret');
  expect((await refresh(source)).state).toBe('skipped');
  expect(source.read).toHaveBeenCalledOnce();
  expect(
    await database.db
      .selectFrom('minecraft_metadata_sync')
      .selectAll()
      .where('id', '!=', 'paper')
      .orderBy('id')
      .execute(),
  ).toEqual(others);
  expect(await database.db.selectFrom('minecraft_combinations').selectAll().execute()).toEqual(
    combinations,
  );
});

it('elects one downloader and fences a previous worker after its lease expires', async () => {
  await requestPaperCatalogRefresh(database.db, now);
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = client();
  const read = source.read.getMockImplementation();
  if (!read) throw new Error('missing fixture');
  source.read.mockImplementation(async (url) => {
    await blocked;
    return read(url);
  });
  const pending = refresh(source);
  await vi.waitFor(() => expect(source.read).toHaveBeenCalledOnce());
  expect((await requestPaperCatalogRefresh(database.db, now)).status.syncState).toBe('refreshing');
  expect((await refresh(client(6))).state).toBe('skipped');
  now = new Date(base.getTime() + 60_001);
  expect((await getPaperCatalog(database.db, now)).status.syncState).toBe('queued');
  expect((await refresh(client(6))).state).toBe('updated');
  release?.();
  expect((await pending).state).toBe('skipped');
  expect(source.read).toHaveBeenCalledOnce();
  expect((await getPaperCatalog(database.db, now)).versions[0]?.buildId).toBe(6);
});

it('safely skips absent migration seeds and pre-request schema without making provider requests', async () => {
  const source = client();
  await database.db.deleteFrom('minecraft_metadata_sync').where('id', '=', 'paper').execute();
  expect((await refresh(source)).state).toBe('skipped');
  expect(await getPaperCatalogSnapshot(database.db)).toBeNull();
  expect((await getPaperCatalog(database.db, now)).synced).toBe(false);
  await expect(requestPaperCatalogRefresh(database.db, now)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
  await sql`insert into minecraft_metadata_sync (id) values ('paper')`.execute(database.db);
  await sql`alter table minecraft_metadata_sync drop column requested_at`.execute(database.db);
  try {
    expect((await refresh(source)).state).toBe('skipped');
    await expect(requestPaperCatalogRefresh(database.db, now)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
    expect(source.read).not.toHaveBeenCalled();
  } finally {
    await sql`alter table minecraft_metadata_sync add column requested_at timestamptz`.execute(
      database.db,
    );
  }
});
