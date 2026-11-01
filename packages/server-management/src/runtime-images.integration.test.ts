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
    .values({ id: 'minecraft', version: '1.0.0', manifest: JSON.stringify(minecraftManifest) })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
});
const input = () => ({
  id: f.mappingId,
  gameId: 'minecraft',
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
function neoforgeAdapter(
  images = [17, 21, 22, 25].map((major) => `ghcr.io/ptero-eggs/yolks:java_${major}`),
) {
  return {
    ...adapter(),
    getEgg: async () => ({
      id: 1,
      nest: 1,
      config: { stop: 'stop' },
      docker_image: images[0],
      docker_images: Object.fromEntries(images.map((value) => [value.split(':')[1], value])),
      relationships: {
        variables: {
          data: ['MC_VERSION', 'NEOFORGE_VERSION'].map((env_variable) => ({
            attributes: { env_variable },
          })),
        },
      },
    }),
  } as unknown as PterodactylAdapter;
}
function neoforgeRegistration(release: string, loader: string, java: number) {
  const existing = registration(release, java);
  const artifact = release === '1.20.1' ? 'forge' : 'neoforge';
  const metadataUrl = `https://maven.neoforged.net/releases/net/neoforged/${artifact}/maven-metadata.xml`;
  const checksumUrl = `https://maven.neoforged.net/releases/net/neoforged/${artifact}/${loader}/${artifact}-${loader}-installer.jar.sha1`;
  return {
    input: {
      mappingId: f.mappingId,
      runtime: { release, profile: 'neoforge', loaderVersion: loader },
    },
    options: {
      ...existing.options,
      metadata: {
        read: async (url: string) => {
          if (url !== metadataUrl && url !== checksumUrl)
            return existing.options.metadata.read(url);
          const bytes = Buffer.from(
            url === checksumUrl
              ? 'b'.repeat(40)
              : `<metadata><groupId>net.neoforged</groupId><artifactId>${artifact}</artifactId><versioning><versions><version>${loader}</version></versions></versioning></metadata>`,
          );
          return {
            bytes,
            evidence: {
              url,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              retrievedAt: new Date().toISOString(),
            },
          };
        },
      },
    },
  };
}
describe('integration-owned runtime images', () => {
  it('links the advertised NeoForge egg and pins its exact Java images in integration mode', async () => {
    const provider = neoforgeAdapter();
    await setRuntimeMapping(f.db, provider, f.owner, {
      ...input(),
      runtimeId: 'neoforge',
      startup: 'java @unix_args.txt',
    });
    for (const [release, loader, java] of [
      ['1.20.1', '1.20.1-47.1.106', 17],
      ['1.21.1', '21.1.72', 21],
      ['26.1', '26.1.0.1-beta', 25],
    ] as const) {
      const request = neoforgeRegistration(release, loader, java);
      const registered = await registerMinecraftCombination(
        f.db,
        provider,
        f.owner,
        request.input,
        {},
        request.options,
      );
      const choice = await inspectMinecraftCombination(f.db, registered.id);
      const expected = `ghcr.io/ptero-eggs/yolks:java_${java}`;
      expect(choice.row.binding).toMatchObject({ image: expected, imageJavaMajor: java });
      expect(mappingProvisionImage(choice.mapping, choice.row.binding)).toBe(expected);
    }
  });
  it('uses the current compiled NeoForge contract when the registered manifest predates it', async () => {
    await f.db
      .updateTable('game_integrations')
      .set({
        manifest: JSON.stringify({
          ...minecraftManifest,
          runtimes: minecraftManifest.runtimes.filter((runtime) => runtime.id !== 'neoforge'),
        }),
      })
      .where('id', '=', 'minecraft')
      .execute();
    await setRuntimeMapping(f.db, neoforgeAdapter(), f.owner, {
      ...input(),
      runtimeId: 'neoforge',
      startup: 'java @unix_args.txt',
    });
    expect(
      await f.db
        .selectFrom('runtime_egg_mappings')
        .select(['runtime_id', 'image_mode'])
        .where('id', '=', f.mappingId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      runtime_id: 'neoforge',
      image_mode: 'integration',
    });
    // The authoritative compiled contract does not rewrite Owner registration/rollout state.
    const registered = await f.db
      .selectFrom('game_integrations')
      .select('manifest')
      .where('id', '=', 'minecraft')
      .executeTakeFirstOrThrow();
    expect(
      (registered.manifest as typeof minecraftManifest).runtimes.some(
        (runtime) => runtime.id === 'neoforge',
      ),
    ).toBe(false);
  });
  it('does not use a compiled contract to implicitly register an absent game', async () => {
    const unregistered = await createTestDatabase();
    try {
      await expect(
        setRuntimeMapping(unregistered.db, neoforgeAdapter(), f.owner, {
          ...input(),
          runtimeId: 'neoforge',
          startup: 'java @unix_args.txt',
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    } finally {
      await unregistered.destroy();
    }
  });
  it('rejects NeoForge eggs with only unapproved or unsupported images', async () => {
    for (const images of [
      [image(21)],
      ['example.invalid/custom:java_21'],
      ['ghcr.io/ptero-eggs/yolks:java_22'],
    ])
      await expect(
        setRuntimeMapping(f.db, neoforgeAdapter(images), f.owner, {
          ...input(),
          runtimeId: 'neoforge',
          startup: 'java @unix_args.txt',
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
  });
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
        manifest: JSON.parse(JSON.stringify(minecraftManifest).replaceAll('minecraft', 'fixture')),
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
    // Integration-declared Vanilla installation is available under an enabled
    // mapping without manufacturing local signed compatibility evidence.
    expect(rows.every((row) => row.enabled === true)).toBe(true);
    expect(await f.db.selectFrom('minecraft_verification_evidence').select('id').execute()).toEqual(
      [],
    );
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
