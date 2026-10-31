import { createHash } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  minecraftManifest,
  minecraftManifestUrl,
  purpurCatalogUrl,
  type RuntimeMetadataClient,
} from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { minecraftMetadataRefreshMs } from './minecraft-metadata.js';
import { resolvePurpurCreationChoice } from './minecraft-registry.js';
import {
  getPurpurCatalog,
  getPurpurCatalogSnapshot,
  refreshPurpurCatalog,
  requestPurpurCatalogRefresh,
} from './purpur-catalog.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const base = new Date('2026-10-21T10:00:00Z');
let now = base;
function client(buildId = 5) {
  const responses: Record<string, unknown> = {
    [purpurCatalogUrl]: {
      project: 'purpur',
      versions: ['1.21.11', '1.14.1'],
    },
  };
  for (const version of ['1.21.11', '1.14.1']) {
    const url = `${purpurCatalogUrl}/${version}`;
    responses[url] = {
      project: 'purpur',
      version,
      builds: { latest: String(buildId), all: [String(buildId), '1'] },
    };
    responses[`${url}/${buildId}`] = {
      project: 'purpur',
      version,
      build: String(buildId),
      result: 'SUCCESS',
      timestamp: base.getTime(),
      md5: 'a'.repeat(32),
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
  refreshPurpurCatalog(database.db, { client: source, now: () => now });
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  now = new Date(base);
  await database.db.deleteFrom('minecraft_metadata_sync').where('id', '=', 'purpur').execute();
  await database.db
    .insertInto('minecraft_metadata_sync')
    .values({
      id: 'purpur',
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
  expect(await getPurpurCatalog(database.db, now)).toMatchObject({ versions: [], synced: false });
  expect(await getPurpurCatalogSnapshot(database.db)).toBeNull();
  const source = client();
  expect(await refresh(source)).toEqual({ state: 'updated', changed: 2 });
  const catalog = await getPurpurCatalog(database.db, now);
  expect(catalog).toMatchObject({
    versions: [
      { version: '1.21.11', buildId: 5, javaMajor: 21 },
      { version: '1.14.1', buildId: 5, javaMajor: 11 },
    ],
    synced: true,
    status: { stale: false, syncState: 'idle' },
  });
  expect(catalog).not.toHaveProperty('documents');
  const snapshot = await getPurpurCatalogSnapshot(database.db);
  expect(snapshot?.documents[`${purpurCatalogUrl}/1.21.11/5`]).toBeDefined();
  expect(await refresh(source)).toEqual({ state: 'skipped', changed: 0 });
  expect(source.read).toHaveBeenCalledTimes(5);
});

it('rechecks every fifteen minutes, keeps unchanged provenance and reuses exact build documents', async () => {
  const source = client();
  await refresh(source);
  const first = await getPurpurCatalogSnapshot(database.db);
  now = new Date(base.getTime() + minecraftMetadataRefreshMs);
  expect((await getPurpurCatalog(database.db, now)).status.stale).toBe(true);
  source.read.mockClear();
  expect(await refresh(source)).toEqual({ state: 'unchanged', changed: 0 });
  expect(source.read.mock.calls.map(([url]) => url)).toEqual([
    purpurCatalogUrl,
    `${purpurCatalogUrl}/1.21.11`,
    `${purpurCatalogUrl}/1.14.1`,
  ]);
  expect(await getPurpurCatalogSnapshot(database.db)).toEqual(first);
  expect((await getPurpurCatalog(database.db, now)).status).toMatchObject({
    stale: false,
    lastSuccessAt: now.toISOString(),
    nextCheckAt: new Date(now.getTime() + minecraftMetadataRefreshMs).toISOString(),
  });
});

it('coalesces concurrent manual requests durably and limits rapid retries', async () => {
  await refresh(client());
  now = new Date(base.getTime() + 10_000);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => requestPurpurCatalogRefresh(database.db, now)),
  );
  expect(results.every((catalog) => catalog.status.syncState === 'queued')).toBe(true);
  expect(results.every((catalog) => catalog.versions[0]?.buildId === 5)).toBe(true);
  const source = client(6);
  expect((await refresh(source)).state).toBe('skipped');
  expect(source.read).not.toHaveBeenCalled();
  now = new Date(base.getTime() + 60_000);
  expect((await refresh(source)).state).toBe('updated');
  expect((await getPurpurCatalog(database.db, now)).status.syncState).toBe('idle');
  expect((await getPurpurCatalog(database.db, now)).versions[0]?.buildId).toBe(6);
});

it('retains last-good data on upstream failure and does not leak errors or modify other catalogs', async () => {
  await refresh(client());
  const first = await getPurpurCatalogSnapshot(database.db);
  const others = await database.db
    .selectFrom('minecraft_metadata_sync')
    .selectAll()
    .where('id', '!=', 'purpur')
    .orderBy('id')
    .execute();
  const combinations = await database.db.selectFrom('minecraft_combinations').selectAll().execute();
  now = new Date(base.getTime() + minecraftMetadataRefreshMs);
  const source = client();
  source.read.mockRejectedValue(new Error('secret provider response'));
  expect((await refresh(source)).state).toBe('failed');
  expect(await getPurpurCatalogSnapshot(database.db)).toEqual(first);
  const catalog = await getPurpurCatalog(database.db, now);
  expect(catalog.status).toMatchObject({
    stale: true,
    lastError: 'purpur_metadata_refresh_failed',
    lastSuccessAt: base.toISOString(),
  });
  expect(JSON.stringify(catalog)).not.toContain('secret');
  expect((await refresh(source)).state).toBe('skipped');
  expect(source.read).toHaveBeenCalledOnce();
  expect(
    await database.db
      .selectFrom('minecraft_metadata_sync')
      .selectAll()
      .where('id', '!=', 'purpur')
      .orderBy('id')
      .execute(),
  ).toEqual(others);
  expect(await database.db.selectFrom('minecraft_combinations').selectAll().execute()).toEqual(
    combinations,
  );
});

it('elects one downloader and fences a previous worker after its lease expires', async () => {
  await requestPurpurCatalogRefresh(database.db, now);
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
  expect((await requestPurpurCatalogRefresh(database.db, now)).status.syncState).toBe('refreshing');
  expect((await refresh(client(6))).state).toBe('skipped');
  now = new Date(base.getTime() + 60_001);
  expect((await getPurpurCatalog(database.db, now)).status.syncState).toBe('queued');
  expect((await refresh(client(6))).state).toBe('updated');
  release?.();
  expect((await pending).state).toBe('skipped');
  expect(source.read).toHaveBeenCalledOnce();
  expect((await getPurpurCatalog(database.db, now)).versions[0]?.buildId).toBe(6);
});

it('safely skips absent migration seeds and pre-request schema without making provider requests', async () => {
  const source = client();
  await database.db.deleteFrom('minecraft_metadata_sync').where('id', '=', 'purpur').execute();
  expect((await refresh(source)).state).toBe('skipped');
  expect(await getPurpurCatalogSnapshot(database.db)).toBeNull();
  expect((await getPurpurCatalog(database.db, now)).synced).toBe(false);
  await expect(requestPurpurCatalogRefresh(database.db, now)).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
  await sql`insert into minecraft_metadata_sync (id) values ('purpur')`.execute(database.db);
  await sql`alter table minecraft_metadata_sync drop column requested_at`.execute(database.db);
  try {
    expect((await refresh(source)).state).toBe('skipped');
    await expect(requestPurpurCatalogRefresh(database.db, now)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
    expect(source.read).not.toHaveBeenCalled();
  } finally {
    await sql`alter table minecraft_metadata_sync add column requested_at timestamptz`.execute(
      database.db,
    );
  }
});

it('lazily registers exact Purpur builds and pins DL_PATH without fetching catalog metadata again', async () => {
  await refresh(client());
  const f = await managementFixture(database.db, { interactive: true });
  await f.db
    .insertInto('game_integrations')
    .values({ id: 'minecraft', version: 'fixture', manifest: JSON.stringify(minecraftManifest) })
    .onConflict((c) => c.column('id').doUpdateSet({ manifest: JSON.stringify(minecraftManifest) }))
    .execute();
  await f.db
    .insertInto('game_rollouts')
    .values({ integration_id: 'minecraft', state: 'public', allowlist: [] })
    .onConflict((c) => c.column('integration_id').doUpdateSet({ state: 'public', allowlist: [] }))
    .execute();
  const image = 'ghcr.io/ptero-eggs/yolks:java_21';
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({
      game_id: 'minecraft',
      runtime_id: 'purpur',
      image_mode: 'integration',
      docker_image: '',
      startup: 'java -jar {{SERVER_JARFILE}} nogui',
      environment: JSON.stringify({}),
      port_roles: JSON.stringify([{ role: 'game', protocols: ['tcp'], primary: true }]),
    })
    .where('id', '=', f.mappingId)
    .execute();
  const mapping = await f.db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', f.mappingId)
    .executeTakeFirstOrThrow();
  const adapter = {
    ...f.adapter,
    getEgg: vi.fn(async () => ({
      id: mapping.egg_id,
      nest: mapping.nest_id,
      docker_image: image,
      relationships: {
        variables: {
          data: ['MINECRAFT_VERSION', 'BUILD_NUMBER', 'SERVER_JARFILE', 'DL_PATH'].map(
            (env_variable) => ({ attributes: { env_variable } }),
          ),
        },
      },
    })),
  } as unknown as PterodactylAdapter;
  const releaseUrl = 'https://piston-meta.mojang.com/v1/packages/fixture/purpur-release.json';
  const release = Buffer.from(
    JSON.stringify({
      id: '1.21.11',
      javaVersion: { majorVersion: 21 },
      downloads: {
        server: {
          url: 'https://piston-data.mojang.com/v1/objects/fixture/server.jar',
          sha1: 'a'.repeat(40),
          size: 1,
        },
      },
    }),
  );
  const manifest = Buffer.from(
    JSON.stringify({
      versions: [
        {
          id: '1.21.11',
          type: 'release',
          url: releaseUrl,
          sha1: createHash('sha1').update(release).digest('hex'),
        },
      ],
    }),
  );
  const read = vi.fn(async (url: string) => {
    const bytes =
      url === minecraftManifestUrl ? manifest : url === releaseUrl ? release : undefined;
    if (!bytes) throw new Error('unexpected provider request');
    return {
      bytes,
      evidence: {
        url,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        retrievedAt: now.toISOString(),
      },
    };
  });
  const options = {
    metadata: { read },
    protocols: vi.fn(async () => ({
      source: { url: 'https://example.test/protocols', sha256: 'b'.repeat(64) },
      releases: new Map([
        [
          '1.21.11',
          {
            release: '1.21.11',
            releaseType: 'release' as const,
            protocolId: 774,
            family: 'netty' as const,
            transfer: true,
          },
        ],
      ]),
    })),
  };
  const input = { choiceId: `purpur:${f.mappingId}:1.21.11` };
  const resolved = await resolvePurpurCreationChoice(f.db, adapter, f.context, input, {}, options);
  expect(resolved.combination).toMatchObject({
    profile: 'purpur',
    release: '1.21.11',
    buildId: '5',
  });
  expect(resolved.row.resolved_runtime).toMatchObject({
    artifacts: [
      { role: 'server', url: `${purpurCatalogUrl}/1.21.11/5/download`, md5: 'a'.repeat(32) },
    ],
  });
  expect(resolved.row.binding).toMatchObject({
    bindings: {
      release: 'MINECRAFT_VERSION',
      buildId: 'BUILD_NUMBER',
      serverArtifactUrl: 'DL_PATH',
    },
  });
  expect(read).toHaveBeenCalledTimes(2);
  const replay = await resolvePurpurCreationChoice(f.db, adapter, f.context, input, {}, options);
  expect(replay.row.id).toBe(resolved.row.id);
  expect(read).toHaveBeenCalledTimes(2);
  await expect(
    resolvePurpurCreationChoice(
      f.db,
      adapter,
      f.context,
      { choiceId: `purpur:${f.mappingId}:1.99` },
      {},
      options,
    ),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ enabled: false })
    .where('id', '=', f.mappingId)
    .execute();
  await expect(
    resolvePurpurCreationChoice(f.db, adapter, f.context, input, {}, options),
  ).rejects.toMatchObject({ code: 'integration_unavailable' });
});
