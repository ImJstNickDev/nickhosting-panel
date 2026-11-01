import { createHash } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  minecraftManifest,
  minecraftManifestUrl,
  quiltCatalogUrls,
  type RuntimeMetadataClient,
} from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { minecraftMetadataRefreshMs } from './minecraft-metadata.js';
import { resolveQuiltCreationChoice } from './minecraft-registry.js';
import {
  getQuiltCatalog,
  refreshQuiltCatalog,
  requestQuiltCatalogRefresh,
} from './quilt-catalog.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const base = new Date('2026-10-20T10:00:00Z');
let now = base;
function client(version = '1.0') {
  return {
    read: vi.fn(async (url: string) => {
      const entries = [
        { version, stable: false },
        { version: '0.1', stable: true },
      ];
      const value =
        url === quiltCatalogUrls.installers
          ? entries.map(({ version }) => ({
              version,
              maven: `org.quiltmc:quilt-installer:${version}`,
              url: `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/${version}/quilt-installer-${version}.jar`,
              file_size: 123,
              hashes: { sha256: 'a'.repeat(64) },
            }))
          : url === quiltCatalogUrls.loaders
            ? entries.map(({ version }) => ({
                version,
                maven: `org.quiltmc:quilt-loader:${version}`,
                file_size: 123,
                hashes: { sha256: 'b'.repeat(64) },
              }))
            : entries;
      const bytes = Buffer.from(JSON.stringify(value));
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
  refreshQuiltCatalog(database.db, { client: source, now: () => now });
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  now = new Date(base);
  await database.db.deleteFrom('minecraft_metadata_sync').where('id', '=', 'quilt').execute();
  await database.db
    .insertInto('minecraft_metadata_sync')
    .values({
      id: 'quilt',
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
it('reads empty before migration/sync, stores three lists and pins the selected installer without exposing raw documents', async () => {
  expect(await getQuiltCatalog(database.db, now)).toMatchObject({
    games: [],
    loaders: [],
    installers: [],
    synced: false,
    latestInstallerVersion: null,
  });
  const source = client();
  expect(await refresh(source)).toEqual({ state: 'updated', changed: 6 });
  expect(await getQuiltCatalog(database.db, now)).toMatchObject({
    synced: true,
    latestInstallerVersion: '1.0',
    status: { stale: false },
  });
  expect(await refresh(source)).toEqual({ state: 'skipped', changed: 0 });
  expect(source.read).toHaveBeenCalledTimes(3);
  expect(await getQuiltCatalog(database.db, now)).not.toHaveProperty('documents');
  now = new Date(now.getTime() + minecraftMetadataRefreshMs);
  expect(await refresh(source)).toEqual({ state: 'unchanged', changed: 0 });
  expect(source.read).toHaveBeenCalledTimes(6);
  await database.db.deleteFrom('minecraft_metadata_sync').where('id', '=', 'quilt').execute();
  expect((await refresh(source)).state).toBe('skipped');
  expect((await getQuiltCatalog(database.db, now)).synced).toBe(false);
});
it('retains complete last-good snapshot when one source fails and throttles retries', async () => {
  await refresh(client());
  now = new Date(now.getTime() + minecraftMetadataRefreshMs);
  const broken = client('2.0');
  const original = broken.read.getMockImplementation();
  broken.read.mockImplementation(async (url) => {
    if (url === quiltCatalogUrls.installers) throw new Error('secret upstream response');
    if (!original) throw new Error('fixture');
    return original(url);
  });
  expect((await refresh(broken)).state).toBe('failed');
  const catalog = await getQuiltCatalog(database.db, now);
  expect(catalog.games[0]?.version).toBe('1.0');
  expect(catalog.status).toMatchObject({
    stale: true,
    lastError: 'quilt_metadata_refresh_failed',
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
  await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(1));
  expect((await refresh(client('2.0'))).state).toBe('skipped');
  now = new Date(now.getTime() + 60_001);
  expect((await refresh(client('2.0'))).state).toBe('updated');
  release?.();
  expect((await pending).state).toBe('skipped');
  expect((await getQuiltCatalog(database.db, now)).latestInstallerVersion).toBe('2.0');
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
    Array.from({ length: 8 }, () => requestQuiltCatalogRefresh(database.db, now)),
  );
  expect(requests.every((catalog) => catalog.status.syncState === 'queued')).toBe(true);
  let row = await database.db
    .selectFrom('minecraft_metadata_sync')
    .selectAll()
    .where('id', '=', 'quilt')
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
    .where('id', '=', 'quilt')
    .executeTakeFirstOrThrow();
  expect(row.requested_at).toBeNull();
  expect((await getQuiltCatalog(database.db, now)).status.syncState).toBe('idle');
});
it('keeps a queued request durable throughout a slow download and coalesces in-flight clicks', async () => {
  await requestQuiltCatalogRefresh(database.db, now);
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
  await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(1));
  now = new Date(base.getTime() + 5_000);
  expect((await requestQuiltCatalogRefresh(database.db, now)).status.syncState).toBe('refreshing');
  const row = await database.db
    .selectFrom('minecraft_metadata_sync')
    .selectAll()
    .where('id', '=', 'quilt')
    .executeTakeFirstOrThrow();
  expect(row.requested_at).toEqual(base);
  unblock?.();
  expect((await pending).state).toBe('updated');
  expect((await getQuiltCatalog(database.db, now)).status.syncState).toBe('idle');
});
it('recovers a crashed worker request and fences stale failures as well as publications', async () => {
  await requestQuiltCatalogRefresh(database.db, now);
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
  await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(1));
  now = new Date(base.getTime() + 60_001);
  expect((await getQuiltCatalog(database.db, now)).status.syncState).toBe('queued');
  expect((await refresh(client('2.0'))).state).toBe('updated');
  unblock?.();
  expect((await pending).state).toBe('skipped');
  expect(await getQuiltCatalog(database.db, now)).toMatchObject({
    latestInstallerVersion: '2.0',
    status: { lastError: null, syncState: 'idle' },
  });
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
  expect(source.read).toHaveBeenCalledTimes(1);
  expect((await getQuiltCatalog(database.db, now)).synced).toBe(false);
});
it('safely serves old cache and skips work before migration 046', async () => {
  await sql`alter table minecraft_metadata_sync drop column requested_at`.execute(database.db);
  try {
    expect((await getQuiltCatalog(database.db, now)).status.syncState).toBe('idle');
    await expect(requestQuiltCatalogRefresh(database.db, now)).rejects.toMatchObject({
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

it('lazily pins exact Quilt versions and cached installer while rejecting legacy eggs', async () => {
  await refresh(client('1.21.1'));
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
      runtime_id: 'quilt',
      image_mode: 'integration',
      docker_image: '',
      startup: 'java -Xms128M -XX:MaxRAMPercentage=95.0 -jar {{SERVER_JARFILE}} nogui',
      environment: '{}',
      port_roles: JSON.stringify([{ role: 'game', protocols: ['tcp'], primary: true }]),
    })
    .where('id', '=', f.mappingId)
    .execute();
  const mapping = await f.db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', f.mappingId)
    .executeTakeFirstOrThrow();
  let variables = [
    'MC_VERSION',
    'QUILT_LOADER_VERSION',
    'QUILT_INSTALLER_VERSION',
    'SERVER_JARFILE',
  ];
  const adapter = {
    ...f.adapter,
    getEgg: vi.fn(async () => ({
      id: mapping.egg_id,
      nest: mapping.nest_id,
      docker_image: image,
      relationships: {
        variables: { data: variables.map((env_variable) => ({ attributes: { env_variable } })) },
      },
    })),
  } as unknown as PterodactylAdapter;
  const releaseUrl = 'https://piston-meta.mojang.com/v1/packages/fixture/quilt.json';
  const release = Buffer.from(
    JSON.stringify({
      id: '1.21.1',
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
  const pair = 'https://meta.quiltmc.org/v3/versions/loader/1.21.1/1.21.1';
  const data: Record<string, unknown> = {
    [minecraftManifestUrl]: {
      versions: [
        {
          id: '1.21.1',
          type: 'release',
          url: releaseUrl,
          sha1: createHash('sha1').update(release).digest('hex'),
        },
      ],
    },
    [pair]: {
      loader: {
        version: '1.21.1',
        maven: 'org.quiltmc:quilt-loader:1.21.1',
        hashes: { sha256: 'b'.repeat(64) },
      },
    },
    [`${pair}/server/json`]: {
      id: 'quilt-loader-1.21.1-1.21.1',
      inheritsFrom: '1.21.1',
      mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotServer',
      launcherMainClass: 'org.quiltmc.loader.impl.launch.server.QuiltServerLauncher',
      libraries: [
        {
          name: 'org.quiltmc:quilt-loader:1.21.1',
          url: 'https://maven.quiltmc.org/repository/release/',
        },
      ],
    },
  };
  const read = vi.fn(async (url: string) => {
    const bytes = url === releaseUrl ? release : Buffer.from(JSON.stringify(data[url] ?? null));
    if (!data[url] && url !== releaseUrl) throw new Error('Unexpected upstream catalog read');
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
          '1.21.1',
          {
            release: '1.21.1',
            releaseType: 'release' as const,
            protocolId: 767,
            family: 'netty' as const,
            transfer: true,
          },
        ],
      ]),
    })),
  };
  const input = { choiceId: `quilt:${f.mappingId}:1.21.1`, loaderVersion: '1.21.1' };
  variables = ['MC_VERSION', 'SERVER_JARFILE'];
  await expect(
    resolveQuiltCreationChoice(f.db, adapter, f.context, input, {}, options),
  ).rejects.toMatchObject({ code: 'configuration_invalid' });
  variables = ['MC_VERSION', 'QUILT_LOADER_VERSION', 'QUILT_INSTALLER_VERSION', 'SERVER_JARFILE'];
  read.mockClear();
  const resolved = await resolveQuiltCreationChoice(f.db, adapter, f.context, input, {}, options);
  expect(resolved.combination).toMatchObject({
    profile: 'quilt',
    release: '1.21.1',
    loaderVersion: '1.21.1',
    installerVersion: '1.21.1',
  });
  expect(resolved.row.binding).toMatchObject({
    installationKind: 'quilt-installer',
    bindings: {
      release: 'MC_VERSION',
      loaderVersion: 'QUILT_LOADER_VERSION',
      installerVersion: 'QUILT_INSTALLER_VERSION',
    },
    artifactPaths: { server: 'server.jar' },
  });
  expect(read).toHaveBeenCalledTimes(4);
  expect(
    (await resolveQuiltCreationChoice(f.db, adapter, f.context, input, {}, options)).row.id,
  ).toBe(resolved.row.id);
  expect(read).toHaveBeenCalledTimes(4);
  await expect(
    resolveQuiltCreationChoice(
      f.db,
      adapter,
      f.context,
      { ...input, loaderVersion: 'missing' },
      {},
      options,
    ),
  ).rejects.toMatchObject({ code: 'validation_failed' });
});
