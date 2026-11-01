import { createHash } from 'node:crypto';
import { authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  fetchForgeCatalog,
  minecraftManifestUrl,
  type RuntimeMetadataClient,
} from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { minecraftCatalog, resolveForgeCreationChoice } from './minecraft-registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
const image = 'ghcr.io/ptero-eggs/yolks:java_8';
const base = 'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json';
const promos = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const release = '1.12.2';
const loader = '14.23.5.2860';
const universalChecksumUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${release}-${loader}/forge-${release}-${loader}-universal.jar.sha1`;
const checksumUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${release}-${loader}/forge-${release}-${loader}-installer.jar.sha1`;
const versionUrl = `https://piston-meta.mojang.com/v1/packages/fixture/${release}.json`;
const egg = vi.fn();
const protocols = vi.fn(async () => ({
  source: { url: 'https://fixture.test/protocols', sha256: 'c'.repeat(64) },
  releases: new Map([
    [
      release,
      {
        release,
        releaseType: 'release' as const,
        protocolId: 767,
        family: 'netty' as const,
        transfer: true,
      },
    ],
  ]),
}));
function metadata(
  selectedLoader = loader,
): RuntimeMetadataClient & { read: ReturnType<typeof vi.fn<RuntimeMetadataClient['read']>> } {
  const version = JSON.stringify({
    id: release,

    downloads: {
      server: {
        url: 'https://piston-data.mojang.com/v1/objects/fixture/server.jar',
        sha1: 'a'.repeat(40),
        size: 1,
      },
    },
  });
  const docs: Record<string, unknown> = {
    [minecraftManifestUrl]: {
      versions: [
        {
          id: release,
          type: 'release',
          url: versionUrl,
          sha1: createHash('sha1').update(version).digest('hex'),
        },
      ],
    },
    [versionUrl]: JSON.parse(version),
    [base]: { [release]: [`${release}-${selectedLoader}`] },
    [promos]: {
      promos: { [`${release}-recommended`]: selectedLoader, [`${release}-latest`]: selectedLoader },
    },
  };
  return {
    read: vi.fn(async (url) => {
      if (!docs[url] && url !== checksumUrl && url !== universalChecksumUrl)
        throw Error(`Unexpected fixture URL ${url}`);
      const bytes = Buffer.from(
        [checksumUrl, universalChecksumUrl].includes(url)
          ? 'b'.repeat(40)
          : JSON.stringify(docs[url]),
      );
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
async function catalog(selectedLoader = loader) {
  const snapshot = await fetchForgeCatalog(metadata(selectedLoader));
  await f.db
    .updateTable('minecraft_metadata_sync')
    .set({ manifest_json: JSON.stringify(snapshot), last_success_at: new Date() })
    .where('id', '=', 'forge')
    .execute();
}
const input = () => ({ choiceId: `forge:${f.mappingId}:${release}`, loaderVersion: loader });
const resolve = (source = metadata()) =>
  resolveForgeCreationChoice(
    f.db,
    { getEgg: egg } as unknown as PterodactylAdapter,
    f.context,
    input(),
    {},
    { metadata: source, protocols },
  );
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  await f.db.updateTable('runtime_egg_mappings').set({ enabled: false }).execute();
  await f.db
    .insertInto('game_integrations')
    .values({ id: 'minecraft', version: '1.0.0', manifest: '{}' })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({
      game_id: 'minecraft',
      runtime_id: 'forge',
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
    docker_images: { 'Java 8': image },
    relationships: {
      variables: {
        data: ['MC_VERSION', 'FORGE_VERSION', 'SERVER_JARFILE', 'BUILD_TYPE'].map(
          (env_variable) => ({ attributes: { env_variable } }),
        ),
      },
    },
  });
  protocols.mockClear();
  await catalog();
});
it('browses local versions then freezes the exact loader once, without downloading a matrix', async () => {
  const choices = await minecraftCatalog(f.db, f.context);
  expect(choices.filter((c) => c.runtime === 'forge')).toEqual([
    expect.objectContaining({ id: input().choiceId, version: release, runtime: 'forge' }),
  ]);
  expect(egg).not.toHaveBeenCalled();
  const source = metadata();
  const choice = await resolve(source);
  expect(choice.combination).toMatchObject({
    profile: 'forge',
    loaderVersion: loader,
    javaMajor: 8,
  });
  expect(choice.capabilities).toMatchObject({ installation: true, gateway: true, sleepWake: true });
  expect(choice.row.binding).toMatchObject({
    bindings: { release: 'MC_VERSION', loaderCoordinate: 'FORGE_VERSION' },
    fixedVariables: { SERVER_JARFILE: 'server.jar' },
  });
  expect(source.read.mock.calls.map(([url]) => url)).toEqual([
    minecraftManifestUrl,
    versionUrl,
    checksumUrl,
    universalChecksumUrl,
  ]);
  egg.mockClear();
  source.read.mockClear();
  expect((await resolve(source)).row.id).toBe(choice.row.id);
  expect(egg).not.toHaveBeenCalled();
  expect(source.read).not.toHaveBeenCalled();
  await catalog('14.23.5.2861');
  await expect(resolve(source)).rejects.toMatchObject({ code: 'validation_failed' });
  expect(
    (
      await f.db
        .selectFrom('minecraft_combinations')
        .select('combination')
        .where('id', '=', choice.row.id)
        .executeTakeFirstOrThrow()
    ).combination,
  ).toMatchObject({ loaderVersion: loader });
});
it('rejects a loader absent from the selected Minecraft catalog before external reads', async () => {
  await expect(
    resolveForgeCreationChoice(
      f.db,
      { getEgg: egg } as unknown as PterodactylAdapter,
      f.context,
      { ...input(), loaderVersion: '47.1.0' },
      {},
      { metadata: metadata(), protocols },
    ),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  expect(egg).not.toHaveBeenCalled();
});
it('keeps the selected accepted snapshot if sync changes during registration', async () => {
  const original = egg.getMockImplementation();
  egg.mockImplementationOnce(async () => {
    await catalog('14.23.5.2861');
    return original?.();
  });
  expect((await resolve()).combination.loaderVersion).toBe(loader);
});
it.each(['mapping', 'node', 'rollout', 'session'] as const)(
  'rejects revoked %s access before provider work',
  async (kind) => {
    if (kind === 'mapping')
      await f.db
        .updateTable('runtime_egg_mappings')
        .set({ enabled: false })
        .where('id', '=', f.mappingId)
        .execute();
    if (kind === 'node')
      await f.db
        .updateTable('managed_nodes')
        .set({ enabled: false })
        .where('id', '=', f.nodeId)
        .execute();
    if (kind === 'rollout')
      await f.db
        .updateTable('game_rollouts')
        .set({ state: 'disabled-for-new-servers' })
        .where('integration_id', '=', 'minecraft')
        .execute();
    if (kind === 'session')
      await f.db
        .deleteFrom('session')
        .where('id', '=', f.context[authSessionId] ?? 'missing')
        .execute();
    await expect(resolve()).rejects.toThrow();
    expect(egg).not.toHaveBeenCalled();
  },
);
it('rechecks mapping revision after provider metadata work', async () => {
  const source = metadata();
  egg.mockImplementationOnce(async () => {
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ startup: 'changed' })
      .where('id', '=', f.mappingId)
      .execute();
    return {
      id: 1,
      nest: 1,
      docker_image: image,
      docker_images: { 'Java 8': image },
      relationships: {
        variables: {
          data: ['MC_VERSION', 'FORGE_VERSION', 'SERVER_JARFILE', 'BUILD_TYPE'].map(
            (env_variable) => ({
              attributes: { env_variable },
            }),
          ),
        },
      },
    };
  });
  await expect(resolve(source)).rejects.toMatchObject({ code: 'conflict' });
});
