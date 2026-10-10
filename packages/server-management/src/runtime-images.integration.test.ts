import { createHash } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { minecraftDigest, minecraftManifest } from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGameModuleRegistry } from './game-modules.js';
import { minecraftModule } from './minecraft-module.js';
import {
  inspectMinecraftCombination,
  minecraftMappingDigest,
  registerMinecraftCombination,
} from './minecraft-registry.js';
import { assertMinecraftEggEnvironment } from './minecraft-runtime-evidence.js';
import { setRuntimeMapping } from './registry.js';
import { mappingProvisionImage } from './runtime-images.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
const image = (java: number) => `ghcr.io/pterodactyl/yolks:java_${java}`;
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
    .values({ id: 'minecraft-java', version: '1.0.0', manifest: JSON.stringify(minecraftManifest) })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
});
const input = () => ({
  id: f.mappingId,
  gameId: 'minecraft-java',
  runtimeId: 'vanilla',
  nodeId: f.nodeId,
  nestId: 1,
  eggId: 1,
  imageMode: 'integration',
  startup: 'java -jar server.jar',
  environment: {},
  portRoles: [{ role: 'game', protocols: ['tcp'], primary: true }],
  featureLimits: { databases: 0, allocations: 1, backups: 0 },
});
function adapter(majors = [21, 25]) {
  return {
    ...f.adapter,
    getEgg: async () => ({
      id: 1,
      nest: 1,
      config: { stop: 'stop' },
      docker_image: image(majors[0] ?? 21),
      docker_images: Object.fromEntries(majors.map((major) => [String(major), image(major)])),
      relationships: { variables: { data: [{ attributes: { env_variable: 'VERSION' } }] } },
    }),
  } as unknown as PterodactylAdapter;
}
function registration(release: string, java: number) {
  const url = `https://piston-meta.mojang.com/v1/packages/fixture/${release}.json`;
  const version = Buffer.from(
    JSON.stringify({
      id: release,
      javaVersion: { majorVersion: java },
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
          id: release,
          type: 'release',
          url,
          sha1: createHash('sha1').update(version).digest('hex'),
        },
      ],
    }),
  );
  return {
    input: {
      mappingId: f.mappingId,
      runtime: { release, profile: 'vanilla' },
      binding: {
        profile: 'vanilla',
        release,
        declaredEggVariables: ['VERSION'],
        bindings: { release: 'VERSION' },
        fixedVariables: {},
        installationKind: 'server-jar',
        artifactPaths: { server: 'server.jar' },
        supportedProperties: [],
      },
    },
    options: {
      metadata: {
        read: async (requested: string) => ({
          bytes: requested === url ? version : manifest,
          evidence: {
            url: requested,
            sha256: 'b'.repeat(64),
            retrievedAt: new Date().toISOString(),
          },
        }),
      },
      protocols: async () => ({
        source: { url: 'https://example.test/protocols', sha256: 'c'.repeat(64) },
        releases: new Map(),
      }),
    },
  };
}
describe('integration-owned runtime images', () => {
  it('dispatches a second integration immutable choice without game-specific Core logic', async () => {
    const mapping = await f.db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', f.mappingId)
      .executeTakeFirstOrThrow();
    const modules = createGameModuleRegistry([
      {
        ...minecraftModule,
        id: 'fixture',
        manifest: JSON.parse(
          JSON.stringify(minecraftManifest).replaceAll('minecraft-java', 'fixture'),
        ),
        resolveProvisionImage: (_mapping, binding) => {
          if (
            typeof binding !== 'object' ||
            binding === null ||
            !('pinnedImage' in binding) ||
            typeof binding.pinnedImage !== 'string'
          )
            throw new Error('Invalid fixture binding');
          return binding.pinnedImage;
        },
      },
    ]);
    expect(
      mappingProvisionImage(
        { ...mapping, game_id: 'fixture', image_mode: 'integration', docker_image: '' },
        { pinnedImage: 'example/fixture:2' },
        modules,
      ),
    ).toBe('example/fixture:2');
  });

  it('preserves the exact legacy static signed mapping digest', async () => {
    const mapping = await f.db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', f.mappingId)
      .executeTakeFirstOrThrow();
    const { image_mode: _mode, enabled: _enabled, ...legacy } = mapping;
    expect(minecraftMappingDigest(mapping)).toBe(minecraftDigest(legacy));
  });
  it('pins two Java images in independent combinations under one mapping', async () => {
    await setRuntimeMapping(f.db, adapter(), f.owner, input());
    const ids = [];
    for (const [release, java] of [
      ['1.21.1', 21],
      ['26.1', 25],
    ] as const) {
      const request = registration(release, java);
      ids.push(
        (
          await registerMinecraftCombination(
            f.db,
            adapter(),
            f.owner,
            request.input,
            {},
            request.options,
          )
        ).id,
      );
    }
    const rows = await f.db
      .selectFrom('minecraft_combinations')
      .selectAll()
      .where('id', 'in', ids)
      .orderBy('id')
      .execute();
    expect(new Set(rows.map((row) => (row.binding as { image: string }).image))).toEqual(
      new Set([image(21), image(25)]),
    );
    const mapping = await f.db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', f.mappingId)
      .executeTakeFirstOrThrow();
    for (const row of rows)
      expect(mappingProvisionImage(mapping, row.binding)).toBe(
        (row.binding as { image: string }).image,
      );
    const pinned = rows.find((row) => (row.binding as { image: string }).image === image(25));
    if (!pinned) throw new Error('Missing pinned fixture');
    const choice = await inspectMinecraftCombination(f.db, pinned.id);
    await expect(
      assertMinecraftEggEnvironment(adapter([21]), choice, { VERSION: '26.1' }),
    ).rejects.toThrow('configuration_invalid');
    expect(mappingProvisionImage(mapping, pinned.binding)).toBe(image(25));
    expect(mapping.docker_image).toBe('');
    expect(rows.every((row) => row.enabled === false)).toBe(true);
  });
  it('rejects unavailable egg images and client image/Java overrides', async () => {
    await setRuntimeMapping(f.db, adapter([21]), f.owner, input());
    const request = registration('26.1', 25);
    await expect(
      registerMinecraftCombination(
        f.db,
        adapter([21]),
        f.owner,
        request.input,
        {},
        request.options,
      ),
    ).rejects.toThrow('configuration_invalid');
    for (const override of [{ image: image(21) }, { imageJavaMajor: 21 }])
      await expect(
        registerMinecraftCombination(
          f.db,
          adapter(),
          f.owner,
          { ...request.input, binding: { ...request.input.binding, ...override } },
          {},
          request.options,
        ),
      ).rejects.toThrow('configuration_invalid');
  });
  it('rejects Owner-authored policies and changing mode of an existing server mapping', async () => {
    await expect(
      setRuntimeMapping(f.db, adapter(), f.owner, {
        ...input(),
        gameId: f.gameId,
        runtimeId: 'fixture',
        portRoles: [{ role: 'game', protocols: ['tcp', 'udp'], primary: true }],
      }),
    ).rejects.toThrow('configuration_invalid');
    await f.server();
    await expect(setRuntimeMapping(f.db, adapter(), f.owner, input())).rejects.toThrow('conflict');
  });
});
