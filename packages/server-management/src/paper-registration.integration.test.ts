import { createHash } from 'node:crypto';
import { authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  fetchPaperCatalog,
  minecraftManifestUrl,
  type RuntimeMetadataClient,
} from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { minecraftCatalog, resolvePaperCreationChoice } from './minecraft-registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
const image = 'ghcr.io/ptero-eggs/yolks:java_21';
const base = 'https://fill.papermc.io/v3/projects/paper';
const release = '1.21.1';
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
  buildId = 100,
): RuntimeMetadataClient & { read: ReturnType<typeof vi.fn<RuntimeMetadataClient['read']>> } {
  const version = JSON.stringify({
    id: release,
    javaVersion: { majorVersion: 21 },
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
    [base]: { project: { id: 'paper' }, versions: { '1.21': [release] } },
    [`${base}/versions/${release}`]: {
      version: { id: release, java: { version: { minimum: 21 } } },
      builds: [buildId],
    },
    [`${base}/versions/${release}/builds/${buildId}`]: {
      id: buildId,
      time: '2026-10-20T00:00:00Z',
      channel: 'STABLE',
      downloads: {
        'server:default': {
          url: `https://fill-data.papermc.io/v1/objects/${'b'.repeat(64)}/paper-${release}-${buildId}.jar`,
          checksums: { sha256: 'b'.repeat(64) },
          size: 100,
        },
      },
    },
  };
  return {
    read: vi.fn(async (url) => {
      if (!docs[url]) throw Error(`Unexpected fixture URL ${url}`);
      const bytes = Buffer.from(JSON.stringify(docs[url]));
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
async function catalog(buildId = 100) {
  const snapshot = await fetchPaperCatalog(metadata(buildId));
  await f.db
    .updateTable('minecraft_metadata_sync')
    .set({ manifest_json: JSON.stringify(snapshot), last_success_at: new Date() })
    .where('id', '=', 'paper')
    .execute();
}
const input = () => ({ choiceId: `paper:${f.mappingId}:${release}` });
const resolve = (source = metadata()) =>
  resolvePaperCreationChoice(
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
      runtime_id: 'paper',
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
        data: ['MINECRAFT_VERSION', 'BUILD_NUMBER', 'SERVER_JARFILE', 'DL_PATH'].map(
          (env_variable) => ({ attributes: { env_variable } }),
        ),
      },
    },
  });
  protocols.mockClear();
  await catalog();
});
it('browses cached versions without provider reads, and pins latest exact build lazily', async () => {
  const choices = await minecraftCatalog(f.db, f.context);
  expect(choices.filter((c) => c.runtime === 'paper')).toEqual([
    expect.objectContaining({ id: input().choiceId, version: release, runtime: 'paper' }),
  ]);
  expect(egg).not.toHaveBeenCalled();
  const source = metadata();
  const choice = await resolve(source);
  expect(choice.combination).toMatchObject({ profile: 'paper', buildId: '100', javaMajor: 21 });
  expect(choice.capabilities).toMatchObject({ installation: true, gateway: true, sleepWake: true });
  expect(choice.row.binding).toMatchObject({
    bindings: {
      release: 'MINECRAFT_VERSION',
      buildId: 'BUILD_NUMBER',
      serverArtifactUrl: 'DL_PATH',
    },
    fixedVariables: { SERVER_JARFILE: 'server.jar' },
  });
  expect(source.read.mock.calls.map(([url]) => url)).toEqual([minecraftManifestUrl, versionUrl]);
  egg.mockClear();
  source.read.mockClear();
  expect((await resolve(source)).row.id).toBe(choice.row.id);
  expect(egg).not.toHaveBeenCalled();
  expect(source.read).not.toHaveBeenCalled();
  await catalog(101);
  const newer = await resolve(source);
  expect(newer.row.id).not.toBe(choice.row.id);
  expect(newer.combination.buildId).toBe('101');
  expect(
    (
      await f.db
        .selectFrom('minecraft_combinations')
        .select('combination')
        .where('id', '=', choice.row.id)
        .executeTakeFirstOrThrow()
    ).combination,
  ).toMatchObject({ buildId: '100' });
});
it('keeps the selected accepted snapshot if sync publishes another during registration', async () => {
  egg.mockImplementationOnce(async () => {
    await catalog(101);
    return {
      id: 1,
      nest: 1,
      docker_image: image,
      docker_images: { 'Java 21': image },
      relationships: {
        variables: {
          data: ['MINECRAFT_VERSION', 'BUILD_NUMBER', 'SERVER_JARFILE', 'DL_PATH'].map(
            (env_variable) => ({ attributes: { env_variable } }),
          ),
        },
      },
    };
  });
  expect((await resolve()).combination.buildId).toBe('100');
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
          data: ['MINECRAFT_VERSION', 'BUILD_NUMBER', 'SERVER_JARFILE'].map((env_variable) => ({
            attributes: { env_variable },
          })),
        },
      },
    };
  });
  await expect(resolve(source)).rejects.toMatchObject({ code: 'conflict' });
});
