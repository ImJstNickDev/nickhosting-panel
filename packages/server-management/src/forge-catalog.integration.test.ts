import { createHash } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { RuntimeMetadataClient } from '@nickhosting/minecraft';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  getForgeCatalog,
  getForgeCatalogSnapshot,
  refreshForgeCatalog,
  requestForgeCatalogRefresh,
} from './forge-catalog.js';
import { minecraftMetadataRefreshMs } from './minecraft-metadata.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const base = new Date('2026-10-21T10:00:00Z');
let now = base;
const catalogUrl = 'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json';
const promotionsUrl =
  'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
function client(loader = '14.23.5.2860') {
  const docs: Record<string, unknown> = {
    [catalogUrl]: { '1.12.2': [`1.12.2-${loader}`], '1.7.10': ['1.7.10-10.13.4.1614-1.7.10'] },
    [promotionsUrl]: {
      promos: {
        '1.12.2-recommended': loader,
        '1.12.2-latest': loader,
        '1.7.10-recommended': '10.13.4.1614',
      },
    },
  };
  return {
    read: vi.fn(async (url: string) => {
      if (!docs[url]) throw Error('Unexpected provider request');
      const bytes = Buffer.from(JSON.stringify(docs[url]));
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
  refreshForgeCatalog(database.db, { client: source, now: () => now });
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  now = new Date(base);
  await database.db.deleteFrom('minecraft_metadata_sync').where('id', '=', 'forge').execute();
  await database.db
    .insertInto('minecraft_metadata_sync')
    .values({
      id: 'forge',
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
  expect(await getForgeCatalog(database.db, now)).toMatchObject({ versions: [], synced: false });
  const source = client();
  expect(await refresh(source)).toEqual({ state: 'updated', changed: 2 });
  const catalog = await getForgeCatalog(database.db, now);
  expect(catalog).toMatchObject({ synced: true, status: { stale: false, syncState: 'idle' } });
  expect(catalog.versions.find((v) => v.minecraftVersion === '1.7.10')?.loaders[0]).toMatchObject({
    coordinate: '1.7.10-10.13.4.1614-1.7.10',
    version: '10.13.4.1614-1.7.10',
    recommended: true,
  });
  expect(catalog).not.toHaveProperty('documents');
  expect(source.read).toHaveBeenCalledTimes(2);
  expect((await refresh(source)).state).toBe('skipped');
  expect(source.read).toHaveBeenCalledTimes(2);
  now = new Date(base.getTime() + minecraftMetadataRefreshMs);
  const previous = await getForgeCatalogSnapshot(database.db);
  expect((await refresh(source)).state).toBe('unchanged');
  expect(source.read).toHaveBeenCalledTimes(4);
  expect(await getForgeCatalogSnapshot(database.db)).toEqual(previous);
});
it('coalesces Owner sync requests while retaining last-good entries', async () => {
  await refresh(client());
  now = new Date(base.getTime() + 10000);
  const result = await Promise.all(
    Array.from({ length: 6 }, () => requestForgeCatalogRefresh(database.db, now)),
  );
  expect(result.every((c) => c.synced && c.status.syncState === 'queued')).toBe(true);
  const source = client('14.23.5.2861');
  expect((await refresh(source)).state).toBe('skipped');
  expect(source.read).not.toHaveBeenCalled();
  now = new Date(base.getTime() + 60000);
  expect((await refresh(source)).state).toBe('updated');
  expect(
    (await getForgeCatalog(database.db, now)).versions.find((v) => v.minecraftVersion === '1.12.2')
      ?.loaders[0]?.version,
  ).toBe('14.23.5.2861');
});
it('preserves snapshots and other providers when upstream fails', async () => {
  await refresh(client());
  const previous = await getForgeCatalogSnapshot(database.db);
  const others = await database.db
    .selectFrom('minecraft_metadata_sync')
    .selectAll()
    .where('id', '!=', 'forge')
    .orderBy('id')
    .execute();
  now = new Date(base.getTime() + minecraftMetadataRefreshMs);
  const source = client();
  source.read.mockRejectedValue(Error('private upstream detail'));
  expect((await refresh(source)).state).toBe('failed');
  expect(await getForgeCatalogSnapshot(database.db)).toEqual(previous);
  const result = await getForgeCatalog(database.db, now);
  expect(result.status.lastError).toBe('forge_metadata_refresh_failed');
  expect(JSON.stringify(result)).not.toContain('private upstream');
  expect(
    await database.db
      .selectFrom('minecraft_metadata_sync')
      .selectAll()
      .where('id', '!=', 'forge')
      .orderBy('id')
      .execute(),
  ).toEqual(others);
});
it('skips the undeployed catalog seed without network traffic', async () => {
  await database.db.deleteFrom('minecraft_metadata_sync').where('id', '=', 'forge').execute();
  const source = client();
  expect((await refresh(source)).state).toBe('skipped');
  expect(source.read).not.toHaveBeenCalled();
  expect(await getForgeCatalogSnapshot(database.db)).toBeNull();
  await expect(requestForgeCatalogRefresh(database.db, now)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
});
