import { createHash } from 'node:crypto';
import { authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  fetchNeoForgeCatalog,
  minecraftManifestUrl,
  type RuntimeMetadataClient,
} from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { minecraftCatalog, resolveNeoForgeCreationChoice } from './minecraft-registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
const image = 'ghcr.io/pterodactyl/yolks:java_21';
const base = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const legacy = 'https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml';
const release = '1.21.1';
const loader = '21.1.72';
const checksumUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loader}/neoforge-${loader}-installer.jar.sha1`;
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
    [base]: `<metadata><groupId>net.neoforged</groupId><artifactId>neoforge</artifactId><versioning><versions><version>${selectedLoader}</version></versions></versioning></metadata>`,
    [legacy]:
      '<metadata><groupId>net.neoforged</groupId><artifactId>forge</artifactId><versioning><versions><version>1.20.1-47.1.106</version></versions></versioning></metadata>',
  };
  return {
    read: vi.fn(async (url) => {
      if (!docs[url] && url !== checksumUrl) throw Error(`Unexpected fixture URL ${url}`);
      const bytes = Buffer.from(
        url === checksumUrl
          ? 'b'.repeat(40)
          : typeof docs[url] === 'string'
            ? (docs[url] as string)
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
  const snapshot = await fetchNeoForgeCatalog(metadata(selectedLoader));
  await f.db
    .updateTable('minecraft_metadata_sync')
    .set({ manifest_json: JSON.stringify(snapshot), last_success_at: new Date() })
    .where('id', '=', 'neoforge')
    .execute();
}
const input = () => ({ choiceId: `neoforge:${f.mappingId}:${release}`, loaderVersion: loader });
const resolve = (source = metadata()) =>
  resolveNeoForgeCreationChoice(
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
      runtime_id: 'neoforge',
      nest_id: 1,
      egg_id: 1,
      image_mode: 'integration',
      docker_image: '',
      environment: '{}',
      startup: 'java @unix_args.txt',
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
        data: ['MC_VERSION', 'NEOFORGE_VERSION'].map((env_variable) => ({
          attributes: { env_variable },
        })),
      },
    },
  });
  protocols.mockClear();
  await catalog();
});
it('browses local versions then freezes the exact loader once, without downloading a matrix', async () => {
  const choices = await minecraftCatalog(f.db, f.context);
  expect(choices.filter((c) => c.runtime === 'neoforge' && c.version === release)).toEqual([
    expect.objectContaining({ id: input().choiceId, version: release, runtime: 'neoforge' }),
  ]);
  expect(egg).not.toHaveBeenCalled();
  const source = metadata();
  const choice = await resolve(source);
  expect(choice.combination).toMatchObject({
    profile: 'neoforge',
    loaderVersion: loader,
    javaMajor: 21,
  });
  expect(choice.capabilities).toMatchObject({
    installation: true,
    gateway: false,
    sleepWake: false,
  });
  expect(choice.row.binding).toMatchObject({
    bindings: { release: 'MC_VERSION', loaderVersion: 'NEOFORGE_VERSION' },
  });
  expect(source.read.mock.calls.map(([url]) => url)).toEqual([
    minecraftManifestUrl,
    versionUrl,
    checksumUrl,
  ]);
  egg.mockClear();
  source.read.mockClear();
  expect((await resolve(source)).row.id).toBe(choice.row.id);
  expect(egg).not.toHaveBeenCalled();
  expect(source.read).not.toHaveBeenCalled();
  await catalog('21.1.73');
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
    resolveNeoForgeCreationChoice(
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
    await catalog('21.1.73');
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
      docker_images: { 'Java 21': image },
      relationships: {
        variables: {
          data: ['MC_VERSION', 'NEOFORGE_VERSION'].map((env_variable) => ({
            attributes: { env_variable },
          })),
        },
      },
    };
  });
  await expect(resolve(source)).rejects.toMatchObject({ code: 'conflict' });
});
