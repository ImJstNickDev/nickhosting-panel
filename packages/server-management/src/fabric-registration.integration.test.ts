import { createHash } from 'node:crypto';
import { authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  minecraftDigest,
  minecraftManifestUrl,
  type RuntimeMetadataClient,
} from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  registerFabricCatalogCombination,
  syncFabricRegisteredCatalog,
} from './fabric-registration.js';
import {
  minecraftCatalog,
  registerMinecraftCombination,
  resolveFabricCreationChoice,
} from './minecraft-registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let installer: string;
const image = 'ghcr.io/ptero-eggs/yolks:java_21';
const games = ['1.21.1', '1.21'];
const loaders = ['0.17.0-beta', '0.16.10'];
const provider = vi.fn<() => Promise<PterodactylAdapter>>();
const egg = vi.fn();
async function catalog(version = '1.1.2') {
  installer = version;
  await f.db
    .updateTable('minecraft_metadata_sync')
    .set({
      last_success_at: new Date(),
      manifest_json: JSON.stringify({
        games: games.map((version) => ({ version, stable: true })),
        loaders: loaders.map((version, index) => ({ version, stable: index === 1 })),
        installers: [{ version, stable: false }],
      }),
    })
    .where('id', '=', 'fabric')
    .execute();
}
function metadata(): RuntimeMetadataClient & {
  read: ReturnType<typeof vi.fn<RuntimeMetadataClient['read']>>;
} {
  const releaseDocuments = new Map(
    games.map((id) => [
      id,
      Buffer.from(
        JSON.stringify({
          id,
          javaVersion: { majorVersion: 21 },
          downloads: {
            server: {
              url: 'https://piston-data.mojang.com/v1/objects/fixture/server.jar',
              sha1: 'a'.repeat(40),
              size: 1,
            },
          },
        }),
      ),
    ]),
  );
  const installerVersion = installer;
  const installerUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${installerVersion}/fabric-installer-${installerVersion}.jar`;
  const releaseBytes = (id: string) => {
    const bytes = releaseDocuments.get(id);
    if (!bytes) throw new Error('Unknown fixture release');
    return bytes;
  };
  return {
    read: vi.fn(async (url: string) => {
      let bytes: Uint8Array;
      if (url === minecraftManifestUrl)
        bytes = Buffer.from(
          JSON.stringify({
            versions: games.map((id) => ({
              id,
              type: 'release',
              url: `https://piston-meta.mojang.com/v1/packages/fixture/${id}.json`,
              sha1: createHash('sha1').update(releaseBytes(id)).digest('hex'),
            })),
          }),
        );
      else if (url.startsWith('https://piston-meta.mojang.com/v1/packages/fixture/'))
        bytes = releaseBytes((url.split('/').at(-1) ?? '').replace('.json', ''));
      else if (url === 'https://meta.fabricmc.net/v2/versions/installer')
        bytes = Buffer.from(JSON.stringify([{ version: installerVersion, url: installerUrl }]));
      else if (url === `${installerUrl}.sha256`) bytes = Buffer.from('b'.repeat(64));
      else if (url.startsWith('https://meta.fabricmc.net/v2/versions/loader/')) {
        const [release, loader] = url
          .slice('https://meta.fabricmc.net/v2/versions/loader/'.length)
          .split('/');
        bytes = Buffer.from(
          JSON.stringify(
            url.endsWith('/server/json')
              ? {
                  inheritsFrom: release,
                  mainClass: 'net.fabricmc.loader.impl.launch.server.FabricServerLauncher',
                }
              : {
                  loader: { version: loader },
                  intermediary: { version: release },
                  launcherMeta: { min_java_version: 8 },
                },
          ),
        );
      } else throw new Error(`Unexpected fixture URL ${url}`);
      return {
        bytes,
        evidence: {
          url,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          retrievedAt: new Date().toISOString(),
        },
      };
    }),
  };
}
const protocols = vi.fn(async () => ({
  source: { url: 'https://fixture.test/protocols', sha256: 'c'.repeat(64) },
  releases: new Map(),
}));
const request = () => ({ mappingId: f.mappingId, release: '1.21.1', loaderVersion: '0.16.10' });
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  await f.db
    .insertInto('game_integrations')
    .values({ id: 'minecraft', version: '1.0.0', manifest: '{}' })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({
      game_id: 'minecraft',
      runtime_id: 'fabric',
      nest_id: 1,
      egg_id: 1,
      image_mode: 'integration',
      docker_image: '',
      environment: '{}',
      startup: 'java -jar server.jar',
      enabled: true,
    })
    .where('id', '=', f.mappingId)
    .execute();
  await f.db
    .insertInto('game_rollouts')
    .values({ integration_id: 'minecraft', state: 'public', allowlist: [] })
    .onConflict((c) => c.column('integration_id').doUpdateSet({ state: 'public', allowlist: [] }))
    .execute();
  egg.mockReset().mockResolvedValue({
    id: 1,
    nest: 1,
    docker_image: image,
    docker_images: { 'Java 21': image },
    relationships: {
      variables: {
        data: ['MC_VERSION', 'LOADER_VERSION', 'FABRIC_VERSION'].map((env_variable) => ({
          attributes: { env_variable },
        })),
      },
    },
  });
  provider.mockReset().mockResolvedValue({ getEgg: egg } as unknown as PterodactylAdapter);
  protocols.mockClear();
  await catalog();
});
it('registers a discovered exact pair with the cached latest installer and declared installation', async () => {
  const source = metadata();
  const result = await registerFabricCatalogCombination(
    f.db,
    provider,
    f.owner,
    request(),
    {},
    { metadata: source, protocols },
  );
  const row = await f.db
    .selectFrom('minecraft_combinations')
    .selectAll()
    .where('id', '=', result.id)
    .executeTakeFirstOrThrow();
  expect(row.enabled).toBe(true);
  expect(row.combination).toMatchObject({
    profile: 'fabric',
    release: '1.21.1',
    loaderVersion: '0.16.10',
    installerVersion: '1.1.2',
    javaMajor: 21,
  });
  expect(row.binding).toMatchObject({
    bindings: {
      release: 'MC_VERSION',
      loaderVersion: 'LOADER_VERSION',
      installerVersion: 'FABRIC_VERSION',
    },
    image,
  });
  expect(
    await f.db
      .selectFrom('minecraft_verification_evidence')
      .select('id')
      .where('combination_id', '=', result.id)
      .execute(),
  ).toEqual([]);
  source.read.mockClear();
  provider.mockClear();
  expect(
    await registerFabricCatalogCombination(
      f.db,
      provider,
      f.owner,
      request(),
      {},
      { metadata: source, protocols },
    ),
  ).toEqual(result);
  expect(source.read).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
});
it('freezes a new latest installer into a separate identity without overwriting older choices', async () => {
  const first = await registerFabricCatalogCombination(
    f.db,
    provider,
    f.owner,
    request(),
    {},
    { metadata: metadata(), protocols },
  );
  await catalog('1.1.3');
  const second = await registerFabricCatalogCombination(
    f.db,
    provider,
    f.owner,
    request(),
    {},
    { metadata: metadata(), protocols },
  );
  expect(second.id).not.toBe(first.id);
  expect(
    await f.db
      .selectFrom('minecraft_combinations')
      .select('id')
      .where('mapping_id', '=', f.mappingId)
      .execute(),
  ).toHaveLength(2);
});
it('rejects unknown pairs, unsupported request fields, missing catalogs and disabled mappings before upstream access', async () => {
  const source = metadata();
  for (const input of [
    { ...request(), loaderVersion: '0.0.1' },
    { ...request(), release: '1.20' },
    { ...request(), installerVersion: '1.1.2' },
  ])
    await expect(
      registerFabricCatalogCombination(f.db, provider, f.owner, input, {}, { metadata: source }),
    ).rejects.toThrow('validation_failed');
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ enabled: false })
    .where('id', '=', f.mappingId)
    .execute();
  await expect(
    registerFabricCatalogCombination(f.db, provider, f.owner, request(), {}, { metadata: source }),
  ).rejects.toThrow('configuration_invalid');
  await f.db
    .updateTable('minecraft_metadata_sync')
    .set({ manifest_json: null })
    .where('id', '=', 'fabric')
    .execute();
  await expect(
    registerFabricCatalogCombination(f.db, provider, f.owner, request(), {}, { metadata: source }),
  ).rejects.toThrow('integration_unavailable');
  expect(source.read).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
});
it('rejects users and revalidates the Owner session even for an already registered pair', async () => {
  const source = metadata();
  await expect(
    registerFabricCatalogCombination(
      f.db,
      provider,
      f.context,
      request(),
      {},
      { metadata: source },
    ),
  ).rejects.toThrow('forbidden');
  await registerFabricCatalogCombination(
    f.db,
    provider,
    f.owner,
    request(),
    {},
    { metadata: source, protocols },
  );
  const sessionId = f.owner[authSessionId];
  if (!sessionId) throw new Error('Missing fixture session');
  await f.db.deleteFrom('session').where('id', '=', sessionId).execute();
  source.read.mockClear();
  provider.mockClear();
  await expect(
    registerFabricCatalogCombination(f.db, provider, f.owner, request(), {}, { metadata: source }),
  ).rejects.toThrow('unauthenticated');
  expect(source.read).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
});
it('scans only the recommended associated Loader, sharing metadata, protocols and egg reads across the batch', async () => {
  const source = metadata();
  const result = await syncFabricRegisteredCatalog(
    f.db,
    provider,
    f.owner,
    { mappingId: f.mappingId },
    {},
    { metadata: source, protocols },
  );
  expect(result).toMatchObject({
    total: 2,
    nextCursor: null,
    items: [
      { version: '1.21.1', status: 'registered' },
      { version: '1.21', status: 'registered' },
    ],
  });
  const rows = await f.db
    .selectFrom('minecraft_combinations')
    .select('combination')
    .where('mapping_id', '=', f.mappingId)
    .execute();
  expect(rows).toHaveLength(2);
  expect(
    rows.every((row) => (row.combination as { loaderVersion: string }).loaderVersion === '0.16.10'),
  ).toBe(true);
  expect(egg).toHaveBeenCalledTimes(1);
  expect(protocols).toHaveBeenCalledTimes(1);
  const urls = source.read.mock.calls.map(([url]) => url);
  expect(new Set(urls).size).toBe(urls.length);
  source.read.mockClear();
  provider.mockClear();
  protocols.mockClear();
  await syncFabricRegisteredCatalog(
    f.db,
    provider,
    f.owner,
    { mappingId: f.mappingId },
    {},
    { metadata: source, protocols },
  );
  expect(source.read).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(protocols).not.toHaveBeenCalled();
});
it('keeps one catalog snapshot and installer when background publication occurs between batch items', async () => {
  const source = metadata();
  const original = source.read.getMockImplementation();
  let published = false;
  source.read.mockImplementation(async (url: string) => {
    // Publish while the first item resolves, before the second item starts.
    // The entire batch must keep the snapshot accepted by its request.
    if (!published && url.endsWith('/1.21.1.json')) {
      published = true;
      await catalog('1.1.3');
    }
    if (!original) throw new Error('Missing fixture reader');
    return original(url);
  });
  const result = await syncFabricRegisteredCatalog(
    f.db,
    provider,
    f.owner,
    { mappingId: f.mappingId },
    {},
    { metadata: source, protocols },
  );
  expect(published).toBe(true);
  expect(result.items.every((item) => item.status === 'registered')).toBe(true);
  const rows = await f.db
    .selectFrom('minecraft_combinations')
    .select('combination')
    .where('mapping_id', '=', f.mappingId)
    .execute();
  expect(rows).toHaveLength(2);
  expect(
    rows.every(
      (row) => (row.combination as { installerVersion: string }).installerVersion === '1.1.2',
    ),
  ).toBe(true);
});
it('coalesces concurrent identical registrations into one immutable choice', async () => {
  const result = await Promise.all(
    Array.from({ length: 2 }, () =>
      registerFabricCatalogCombination(
        f.db,
        provider,
        f.owner,
        request(),
        {},
        { metadata: metadata(), protocols },
      ),
    ),
  );
  expect(result[0]).toEqual(result[1]);
  expect(
    await f.db
      .selectFrom('minecraft_combinations')
      .select('id')
      .where('mapping_id', '=', f.mappingId)
      .execute(),
  ).toHaveLength(1);
});
it('registers a new mapping revision without returning or replacing its stale predecessor', async () => {
  const first = await registerFabricCatalogCombination(
    f.db,
    provider,
    f.owner,
    request(),
    {},
    { metadata: metadata(), protocols },
  );
  const before = await f.db
    .selectFrom('minecraft_combinations')
    .selectAll()
    .where('id', '=', first.id)
    .executeTakeFirstOrThrow();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ startup: 'java -Xms256M -jar server.jar' })
    .where('id', '=', f.mappingId)
    .execute();
  const second = await registerFabricCatalogCombination(
    f.db,
    provider,
    f.owner,
    request(),
    {},
    { metadata: metadata(), protocols },
  );
  expect(second.id).not.toBe(first.id);
  const after = await f.db
    .selectFrom('minecraft_combinations')
    .selectAll()
    .where('id', '=', second.id)
    .executeTakeFirstOrThrow();
  expect(after.mapping_digest).not.toBe(before.mapping_digest);
  expect(after.identity_digest).not.toBe(before.identity_digest);
  expect(
    await f.db
      .selectFrom('minecraft_combinations')
      .selectAll()
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow(),
  ).toEqual(before);
});
it('reuses an unchanged legacy identity through the existing registry without rewriting its record', async () => {
  const first = await registerFabricCatalogCombination(
    f.db,
    provider,
    f.owner,
    request(),
    {},
    { metadata: metadata(), protocols },
  );
  const row = await f.db
    .selectFrom('minecraft_combinations')
    .selectAll()
    .where('id', '=', first.id)
    .executeTakeFirstOrThrow();
  const legacyIdentity = minecraftDigest({ combination: row.combination, binding: row.binding });
  await f.db
    .updateTable('minecraft_combinations')
    .set({ identity_digest: legacyIdentity })
    .where('id', '=', first.id)
    .execute();
  const legacy = await f.db
    .selectFrom('minecraft_combinations')
    .selectAll()
    .where('id', '=', first.id)
    .executeTakeFirstOrThrow();
  const result = await registerMinecraftCombination(
    f.db,
    await provider(),
    f.owner,
    {
      mappingId: f.mappingId,
      runtime: {
        profile: 'fabric',
        release: '1.21.1',
        loaderVersion: '0.16.10',
        installerVersion: '1.1.2',
      },
    },
    {},
    { metadata: metadata(), protocols },
  );
  expect(result).toEqual(first);
  expect(
    await f.db
      .selectFrom('minecraft_combinations')
      .selectAll()
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow(),
  ).toEqual(legacy);
});

const creation = () => ({ choiceId: `fabric:${f.mappingId}:1.21.1`, loaderVersion: '0.16.10' });
it('lists local games without registered rows or remote reads and resolves one choice as an ordinary user', async () => {
  const before = await f.db
    .selectFrom('minecraft_combinations')
    .select('id')
    .where('mapping_id', '=', f.mappingId)
    .execute();
  expect(before).toEqual([]);
  const choices = (await minecraftCatalog(f.db, f.context)).filter((choice) =>
    choice.id.startsWith(`fabric:${f.mappingId}:`),
  );
  expect(choices.map((choice) => choice.version)).toEqual(games);
  expect(choices[0]).toMatchObject({
    runtime: 'fabric',
    capabilities: { installation: true, directConnection: true, gateway: false },
  });
  expect(egg).not.toHaveBeenCalled();
  const source = metadata();
  const resolved = await resolveFabricCreationChoice(
    f.db,
    await provider(),
    f.context,
    creation(),
    {},
    { metadata: source, protocols },
  );
  expect(resolved.combination).toMatchObject({
    release: '1.21.1',
    loaderVersion: '0.16.10',
    installerVersion: '1.1.2',
  });
  expect(resolved.row.enabled).toBe(true);
  const rows = await f.db
    .selectFrom('minecraft_combinations')
    .select('id')
    .where('mapping_id', '=', f.mappingId)
    .execute();
  expect(rows).toHaveLength(1);
  source.read.mockClear();
  egg.mockClear();
  await f.db
    .updateTable('minecraft_combinations')
    .set({ enabled: false })
    .where('id', '=', resolved.row.id)
    .execute();
  const reused = await resolveFabricCreationChoice(
    f.db,
    await provider(),
    f.context,
    creation(),
    {},
    { metadata: source, protocols },
  );
  expect(reused.row.id).toBe(resolved.row.id);
  expect(reused.row.enabled).toBe(false);
  expect(source.read).not.toHaveBeenCalled();
  expect(egg).not.toHaveBeenCalled();
});
it('accepts any independently cataloged Loader and freezes latest once during resolution', async () => {
  const source = metadata();
  const original = source.read.getMockImplementation();
  source.read.mockImplementation(async (url) => {
    if (url.endsWith('/1.21.1.json')) await catalog('1.1.3');
    if (!original) throw new Error('fixture');
    return original(url);
  });
  const choice = await resolveFabricCreationChoice(
    f.db,
    await provider(),
    f.context,
    { ...creation(), loaderVersion: loaders[0] ?? '' },
    {},
    { metadata: source, protocols },
  );
  expect(choice.combination).toMatchObject({
    loaderVersion: loaders[0],
    installerVersion: '1.1.2',
  });
});
it('rejects missing catalogs, unknown selections and disabled rollout before provider reads', async () => {
  const source = metadata(),
    adapter = await provider();
  for (const input of [
    { ...creation(), loaderVersion: '0.0.0' },
    { ...creation(), choiceId: `fabric:${f.mappingId}:1.0` },
  ])
    await expect(
      resolveFabricCreationChoice(
        f.db,
        adapter,
        f.context,
        input,
        {},
        { metadata: source, protocols },
      ),
    ).rejects.toThrow('validation_failed');
  await f.db
    .updateTable('game_rollouts')
    .set({ state: 'disabled-for-new-servers' })
    .where('integration_id', '=', 'minecraft')
    .execute();
  await expect(
    resolveFabricCreationChoice(
      f.db,
      adapter,
      f.context,
      creation(),
      {},
      { metadata: source, protocols },
    ),
  ).rejects.toThrow('forbidden');
  expect(await minecraftCatalog(f.db, f.context)).toEqual([]);
  await f.db
    .updateTable('game_rollouts')
    .set({ state: 'public' })
    .where('integration_id', '=', 'minecraft')
    .execute();
  await f.db
    .updateTable('minecraft_metadata_sync')
    .set({ manifest_json: null })
    .where('id', '=', 'fabric')
    .execute();
  await expect(
    resolveFabricCreationChoice(
      f.db,
      adapter,
      f.context,
      creation(),
      {},
      { metadata: source, protocols },
    ),
  ).rejects.toThrow('integration_unavailable');
  expect(source.read).not.toHaveBeenCalled();
  expect(egg).not.toHaveBeenCalled();
});
it('revalidates user sessions and mapping revisions after metadata resolution', async () => {
  const source = metadata(),
    adapter = await provider();
  const original = source.read.getMockImplementation();
  let changed = false;
  source.read.mockImplementation(async (url) => {
    if (!changed) {
      changed = true;
      await f.db
        .updateTable('runtime_egg_mappings')
        .set({ startup: 'java -jar different.jar' })
        .where('id', '=', f.mappingId)
        .execute();
    }
    if (!original) throw new Error('fixture');
    return original(url);
  });
  await expect(
    resolveFabricCreationChoice(
      f.db,
      adapter,
      f.context,
      creation(),
      {},
      { metadata: source, protocols },
    ),
  ).rejects.toThrow('conflict');
  expect(
    await f.db
      .selectFrom('minecraft_combinations')
      .select('id')
      .where('mapping_id', '=', f.mappingId)
      .execute(),
  ).toEqual([]);
  const session = f.context[authSessionId];
  if (!session) throw new Error('fixture');
  await f.db.deleteFrom('session').where('id', '=', session).execute();
  source.read.mockClear();
  await expect(
    resolveFabricCreationChoice(
      f.db,
      adapter,
      f.context,
      creation(),
      {},
      { metadata: source, protocols },
    ),
  ).rejects.toThrow('unauthenticated');
  expect(source.read).not.toHaveBeenCalled();
});
it('does not grant creation through a disabled mapping or fabricated assisted context', async () => {
  const source = metadata(),
    adapter = await provider();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ enabled: false })
    .where('id', '=', f.mappingId)
    .execute();
  await expect(
    resolveFabricCreationChoice(
      f.db,
      adapter,
      f.context,
      creation(),
      {},
      { metadata: source, protocols },
    ),
  ).rejects.toThrow('integration_unavailable');
  await expect(
    resolveFabricCreationChoice(
      f.db,
      adapter,
      { ...f.context, sessionType: 'support' },
      creation(),
      {},
      { metadata: source, protocols },
    ),
  ).rejects.toThrow('support_invalid');
  expect(source.read).not.toHaveBeenCalled();
  expect(egg).not.toHaveBeenCalled();
});
