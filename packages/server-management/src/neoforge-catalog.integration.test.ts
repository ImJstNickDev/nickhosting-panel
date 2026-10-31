import { createHash } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { RuntimeMetadataClient } from '@nickhosting/minecraft';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { minecraftMetadataRefreshMs } from './minecraft-metadata.js';
import {
  getNeoForgeCatalog,
  getNeoForgeCatalogSnapshot,
  refreshNeoForgeCatalog,
  requestNeoForgeCatalogRefresh,
} from './neoforge-catalog.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const base = new Date('2026-10-21T10:00:00Z');
let now = base;
const catalogUrl = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const legacyUrl = 'https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml';
function client(loader = '21.1.72') {
  const docs: Record<string, string> = {
    [catalogUrl]: `<metadata><groupId>net.neoforged</groupId><artifactId>neoforge</artifactId><versioning><versions><version>${loader}</version></versions></versioning></metadata>`,
    [legacyUrl]:
      '<metadata><groupId>net.neoforged</groupId><artifactId>forge</artifactId><versioning><versions><version>1.20.1-47.1.106</version></versions></versioning></metadata>',
  };
  return {
    read: vi.fn(async (url: string) => {
      if (!docs[url]) throw Error('Unexpected provider request');
      const bytes = Buffer.from(docs[url] ?? '');
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
  refreshNeoForgeCatalog(database.db, { client: source, now: () => now });
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  now = new Date(base);
  await database.db.deleteFrom('minecraft_metadata_sync').where('id', '=', 'neoforge').execute();
  await database.db
    .insertInto('minecraft_metadata_sync')
    .values({
      id: 'neoforge',
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
it('serves local discovery and refreshes only two aggregate documents', async () => {
  expect(await getNeoForgeCatalog(database.db, now)).toMatchObject({ versions: [], synced: false });
  const source = client();
  expect(await refresh(source)).toEqual({ state: 'updated', changed: 2 });
  const catalog = await getNeoForgeCatalog(database.db, now);
  expect(catalog).toMatchObject({ synced: true, status: { stale: false, syncState: 'idle' } });
  expect(catalog.versions.find((v) => v.minecraftVersion === '1.20.1')?.loaders[0]).toMatchObject({
    coordinate: '1.20.1-47.1.106',
    version: '1.20.1-47.1.106',
    recommended: false,
  });
  expect(catalog).not.toHaveProperty('documents');
  expect(source.read).toHaveBeenCalledTimes(2);
  expect((await refresh(source)).state).toBe('skipped');
  expect(source.read).toHaveBeenCalledTimes(2);
  now = new Date(base.getTime() + minecraftMetadataRefreshMs);
  const previous = await getNeoForgeCatalogSnapshot(database.db);
  expect((await refresh(source)).state).toBe('unchanged');
  expect(source.read).toHaveBeenCalledTimes(4);
  expect(await getNeoForgeCatalogSnapshot(database.db)).toEqual(previous);
});
it('coalesces Owner sync requests while retaining last-good entries', async () => {
  await refresh(client());
  now = new Date(base.getTime() + 10000);
  const result = await Promise.all(
    Array.from({ length: 6 }, () => requestNeoForgeCatalogRefresh(database.db, now)),
  );
  expect(result.every((c) => c.synced && c.status.syncState === 'queued')).toBe(true);
  const source = client('21.1.73');
  expect((await refresh(source)).state).toBe('skipped');
  expect(source.read).not.toHaveBeenCalled();
  now = new Date(base.getTime() + 60000);
  expect((await refresh(source)).state).toBe('updated');
  expect(
    (await getNeoForgeCatalog(database.db, now)).versions.find(
      (v) => v.minecraftVersion === '1.21.1',
    )?.loaders[0]?.version,
  ).toBe('21.1.73');
});
it('preserves snapshots and other providers when upstream fails', async () => {
  await refresh(client());
  const previous = await getNeoForgeCatalogSnapshot(database.db);
  const others = await database.db
    .selectFrom('minecraft_metadata_sync')
    .selectAll()
    .where('id', '!=', 'neoforge')
    .orderBy('id')
    .execute();
  now = new Date(base.getTime() + minecraftMetadataRefreshMs);
  const source = client();
  source.read.mockRejectedValue(Error('private upstream detail'));
  expect((await refresh(source)).state).toBe('failed');
  expect(await getNeoForgeCatalogSnapshot(database.db)).toEqual(previous);
  const result = await getNeoForgeCatalog(database.db, now);
  expect(result.status.lastError).toBe('neoforge_metadata_refresh_failed');
  expect(JSON.stringify(result)).not.toContain('private upstream');
  expect(
    await database.db
      .selectFrom('minecraft_metadata_sync')
      .selectAll()
      .where('id', '!=', 'neoforge')
      .orderBy('id')
      .execute(),
  ).toEqual(others);
});
it('skips the undeployed catalog seed without network traffic', async () => {
  await database.db.deleteFrom('minecraft_metadata_sync').where('id', '=', 'neoforge').execute();
  const source = client();
  expect((await refresh(source)).state).toBe('skipped');
  expect(source.read).not.toHaveBeenCalled();
  expect(await getNeoForgeCatalogSnapshot(database.db)).toBeNull();
  await expect(requestNeoForgeCatalogRefresh(database.db, now)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
});
