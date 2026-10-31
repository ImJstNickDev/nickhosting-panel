import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveMinecraftImage } from './image-policy.js';
import {
  createRuntimeMetadataClient,
  type MinecraftRuntimeMapping,
  resolveMinecraftRuntime,
  trustedMinecraftArtifactUrl,
  validateMinecraftRuntimeMapping,
} from './runtime.js';

const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const releaseUrl = 'https://piston-meta.mojang.com/v1/packages/fixture/26.1.json';
const serverUrl = 'https://piston-data.mojang.com/v1/objects/fixture/server.jar';
const userAgent = 'NickHosting-Panel/Test (https://github.com/ImJstNickDev/nickhosting-panel)';
function fixture(
  extra: Record<string, unknown> = {},
  options: {
    java?: number | null;
    corrupt?: boolean;
    release?: string;
    releaseType?: 'release' | 'snapshot';
  } = {},
) {
  const release = options.release ?? '26.1';
  const version = JSON.stringify({
    id: release,
    ...(options.java === null ? {} : { javaVersion: { majorVersion: options.java ?? 25 } }),
    downloads: { server: { url: serverUrl, size: 1000, sha1: 'a'.repeat(40) } },
  });
  const responses: Record<string, unknown> = {
    [manifestUrl]: {
      versions: [
        { id: '1.14 Pre-Release 1', type: 'snapshot', url: releaseUrl, sha1: 'a'.repeat(40) },
        {
          id: release,
          type: options.releaseType ?? 'release',
          url: releaseUrl,
          sha1: options.corrupt ? '0'.repeat(40) : createHash('sha1').update(version).digest('hex'),
        },
      ],
    },
    [releaseUrl]: version,
    ...extra,
  };
  const requests: string[] = [];
  const client = createRuntimeMetadataClient({
    userAgent,
    now: () => new Date('2026-10-10T00:00:00Z'),
    fetch: async (url, init) => {
      expect(init?.redirect).toBe('error');
      expect(init?.credentials).toBe('omit');
      expect(init?.headers).toHaveProperty('User-Agent', userAgent);
      requests.push(String(url));
      const result = responses[String(url)];
      return result === undefined
        ? new Response(null, { status: 404 })
        : new Response(typeof result === 'string' ? result : JSON.stringify(result));
    },
  });
  return { client, requests };
}
describe('Minecraft exact runtime metadata', () => {
  it.each([
    ['1.14.1', 11],
    ['1.16.5', 16],
    ['1.17.1', 17],
  ] as const)(
    'resolves historical Purpur %s without Mojang Java metadata',
    async (release, javaMajor) => {
      const base = `https://api.purpurmc.org/v2/purpur/${release}`;
      const { client } = fixture(
        {
          [base]: { project: 'purpur', version: release, builds: { latest: '5', all: ['5'] } },
          [`${base}/5`]: {
            project: 'purpur',
            version: release,
            build: '5',
            result: 'SUCCESS',
            timestamp: 1770000000000,
            md5: 'a'.repeat(32),
          },
        },
        { release, java: null },
      );
      expect(
        await resolveMinecraftRuntime({ profile: 'purpur', release, buildId: 5 }, client),
      ).toMatchObject({ javaMajor });
    },
  );
  it('resolves an exact Purpur build with published MD5 and no invented SHA256', async () => {
    const base = 'https://api.purpurmc.org/v2/purpur/26.1';
    const { client, requests } = fixture({
      [base]: { project: 'purpur', version: '26.1', builds: { latest: '7', all: ['5', '7'] } },
      [`${base}/5`]: {
        project: 'purpur',
        version: '26.1',
        build: '5',
        result: 'SUCCESS',
        timestamp: 1770000000000,
        md5: 'A'.repeat(32),
      },
    });
    const runtime = await resolveMinecraftRuntime(
      { profile: 'purpur', release: '26.1', buildId: 5 },
      client,
    );
    expect(runtime.javaMajor).toBe(25);
    expect(runtime.artifacts).toEqual([
      { role: 'server', url: `${base}/5/download`, md5: 'a'.repeat(32) },
    ]);
    expect(requests).not.toContain(`${base}/7`);
    expect(runtime.evidence).toHaveLength(4);
  });
  it.each([
    { project: 'paper' },
    { version: '1.21.11' },
    { build: '6' },
    { result: 'FAILURE' },
    { md5: '' },
  ])('rejects mismatched or unsuccessful Purpur artifact %j', async (change) => {
    const base = 'https://api.purpurmc.org/v2/purpur/26.1';
    const { client } = fixture({
      [base]: { project: 'purpur', version: '26.1', builds: { latest: '5', all: ['5'] } },
      [`${base}/5`]: {
        project: 'purpur',
        version: '26.1',
        build: '5',
        result: 'SUCCESS',
        timestamp: 1770000000000,
        md5: 'a'.repeat(32),
        ...change,
      },
    });
    await expect(
      resolveMinecraftRuntime({ profile: 'purpur', release: '26.1', buildId: 5 }, client),
    ).rejects.toThrow();
  });

  it('resolves opaque 26.x release and Java25 from hash-verified Mojang metadata', async () => {
    const runtime = await resolveMinecraftRuntime(
      { release: '26.1', profile: 'vanilla' },
      fixture().client,
    );
    expect(runtime.javaMajor).toBe(25);
    expect(runtime.artifacts[0]).toMatchObject({
      role: 'server',
      sha1: 'a'.repeat(40),
      size: 1000,
    });
    expect(runtime.evidence).toHaveLength(2);
    expect(Object.isFrozen(runtime.artifacts[0])).toBe(true);
    expect(() => {
      (runtime.artifacts as unknown[]).push({});
    }).toThrow();
  });
  it('rejects metadata integrity failure, unknown releases and unsupported guessed selectors', async () => {
    await expect(
      resolveMinecraftRuntime(
        { release: '26.1', profile: 'vanilla' },
        fixture({}, { corrupt: true }).client,
      ),
    ).rejects.toMatchObject({ details: { reason: 'minecraft_metadata_integrity' } });
    await expect(
      resolveMinecraftRuntime({ release: 'future', profile: 'vanilla' }, fixture().client),
    ).rejects.toThrow();
    await expect(
      resolveMinecraftRuntime({ release: '26.1', profile: 'paper' }, fixture().client),
    ).rejects.toThrow();
    await expect(
      resolveMinecraftRuntime(
        { release: '26.1', profile: 'vanilla', loaderVersion: '0.19.5' },
        fixture().client,
      ),
    ).rejects.toThrow();
  });
  it.each(['paper', 'folia'] as const)(
    'resolves exact %s build and provider-specific Java minimum without substituting latest',
    async (profile) => {
      const base = `https://fill.papermc.io/v3/projects/${profile}/versions/26.1`;
      const { client, requests } = fixture(
        {
          [base]: { version: { id: '26.1', java: { version: { minimum: 25 } } }, builds: [4, 3] },
          [`${base}/builds/3`]: {
            id: 3,
            channel: 'STABLE',
            downloads: {
              'server:default': {
                url: 'https://fill-data.papermc.io/v1/objects/pinned/server.jar',
                checksums: { sha256: 'b'.repeat(64) },
                size: 5000,
              },
            },
          },
        },
        { java: 21 },
      );
      const runtime = await resolveMinecraftRuntime(
        { release: '26.1', profile, buildId: 3 },
        client,
      );
      expect(runtime).toMatchObject({ javaMajor: 25, buildId: 3 });
      expect(runtime.artifacts).toHaveLength(1);
      expect(requests).not.toContain(`${base}/builds/4`);
      await expect(
        resolveMinecraftRuntime({ release: '26.1', profile, buildId: 9 }, client),
      ).rejects.toThrow();
    },
  );
  it.each([
    ['1.7.10', 6, 8],
    ['1.12.2', 8, 11],
    ['1.16.5', 8, 16],
    ['1.20.4', 17, 21],
  ] as const)(
    'resolves Paper %s without absent historical Mojang Java metadata',
    async (release, minimum, expected) => {
      const base = `https://fill.papermc.io/v3/projects/paper/versions/${release}`;
      const { client } = fixture(
        {
          [base]: { version: { id: release, java: { version: { minimum } } }, builds: [5] },
          [`${base}/builds/5`]: {
            id: 5,
            channel: 'EXPERIMENTAL',
            downloads: {
              'server:default': {
                url: 'https://fill-data.papermc.io/v1/objects/pinned/server.jar',
                checksums: { sha256: 'b'.repeat(64) },
                size: 5000,
              },
            },
          },
        },
        { release, java: null },
      );
      expect(
        await resolveMinecraftRuntime({ release, profile: 'paper', buildId: 5 }, client),
      ).toMatchObject({ javaMajor: expected, upstreamChannel: 'EXPERIMENTAL', buildId: 5 });
    },
  );
  it.each([
    ['1.19.4', 17, 17],
    ['26.3', 25, 25],
    ['1.20.4', 17, 21],
  ] as const)(
    'resolves Folia %s without absent historical Mojang Java metadata',
    async (release, minimum, expected) => {
      const base = `https://fill.papermc.io/v3/projects/folia/versions/${release}`;
      const { client } = fixture(
        {
          [base]: { version: { id: release, java: { version: { minimum } } }, builds: [5] },
          [`${base}/builds/5`]: {
            id: 5,
            channel: 'EXPERIMENTAL',
            downloads: {
              'server:default': {
                url: 'https://fill-data.papermc.io/v1/objects/pinned/server.jar',
                checksums: { sha256: 'b'.repeat(64) },
                size: 5000,
              },
            },
          },
        },
        { release, java: null },
      );
      expect(
        await resolveMinecraftRuntime({ release, profile: 'folia', buildId: 5 }, client),
      ).toMatchObject({ javaMajor: expected, upstreamChannel: 'EXPERIMENTAL', buildId: 5 });
    },
  );
  it('pins Fabric loader and installer separately and carries both server and installer hashes', async () => {
    const installer =
      'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar';
    const { client } = fixture({
      'https://meta.fabricmc.net/v2/versions/loader/26.1/0.19.5': {
        loader: { version: '0.19.5' },
        intermediary: { version: '0.0.0' },
        launcherMeta: { min_java_version: 8 },
      },
      'https://meta.fabricmc.net/v2/versions/loader/26.1/0.19.5/server/json': {
        inheritsFrom: '26.1',
        mainClass: 'net.fabricmc.loader.impl.launch.server.FabricServerLauncher',
      },
      'https://meta.fabricmc.net/v2/versions/installer': [{ version: '1.1.2', url: installer }],
      [`${installer}.sha256`]: 'c'.repeat(64),
    });
    const runtime = await resolveMinecraftRuntime(
      { release: '26.1', profile: 'fabric', loaderVersion: '0.19.5', installerVersion: '1.1.2' },
      client,
    );
    expect(runtime).toMatchObject({
      javaMajor: 25,
      installation: {
        kind: 'fabric-installer',
        args: ['server', '-mcversion', '26.1', '-loader', '0.19.5', '-downloadMinecraft'],
      },
    });
    expect(runtime.artifacts).toHaveLength(2);
    expect(runtime.artifacts[1]?.sha256).toBe('c'.repeat(64));
  });
  it.each([
    ['1.14', null, 8, 8, '0.14.25', 'release'],
    ['1.14', null, undefined, 8, '0.1.0.48', 'release'],
    ['1.16.5', 8, 8, 8, '0.19.5', 'release'],
    ['1.17', 16, 8, 17, '0.11.3', 'release'],
    ['1.17.1', 16, 8, 17, '0.19.5', 'release'],
    ['1.17.1', null, 8, 17, '0.19.5', 'release'],
    ['1.18', 17, 8, 17, '0.12.5', 'release'],
    ['1.20.4', 17, 8, 17, '0.19.5', 'release'],
    ['1.20.5', 21, 8, 21, '0.19.5', 'release'],
    ['1.21.11', 21, 8, 21, '0.19.5', 'release'],
    ['26.1', 25, 8, 25, '0.19.5', 'release'],
    ['26.2', 25, 8, 25, '0.19.5', 'release'],
    ['25w03a', 21, 8, 21, '0.19.5', 'snapshot'],
    ['1.17-rc1', 16, 8, 16, '0.19.5', 'snapshot'],
    // Synthetic loader minimum proves that the exact metadata overrides the base.
    ['1.16.5', 8, 17, 17, '0.19.5', 'release'],
    ['1.17.1', 16, 21, 21, '0.19.5', 'release'],
  ] as const)(
    'selects Fabric %s / loader Java %s,%s as Java %s (%s, %s)',
    async (release, java, loaderJava, expected, loader, releaseType) => {
      const installer =
        'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar';
      const base = `https://meta.fabricmc.net/v2/versions/loader/${release}/${loader}`;
      const { client, requests } = fixture(
        {
          [base]: {
            loader: { version: loader },
            intermediary: { version: release },
            launcherMeta: { min_java_version: loaderJava },
          },
          [`${base}/server/json`]: {
            inheritsFrom: release,
            mainClass:
              loader === '0.1.0.48'
                ? 'net.minecraft.launchwrapper.Launch'
                : 'net.fabricmc.loader.impl.launch.server.FabricServerLauncher',
          },
          'https://meta.fabricmc.net/v2/versions/installer': [{ version: '1.1.2', url: installer }],
          [`${installer}.sha256`]: 'c'.repeat(64),
        },
        { release, java, releaseType },
      );
      const request = {
        release,
        profile: 'fabric',
        loaderVersion: loader,
        installerVersion: '1.1.2',
      } as const;
      const resolved = await resolveMinecraftRuntime(request, client);
      expect(resolved.javaMajor).toBe(expected);
      expect(resolveMinecraftImage(resolved).image).toBe(
        `ghcr.io/ptero-eggs/yolks:java_${expected}`,
      );
      expect(requests).toHaveLength(6);
      expect(new Set(requests).size).toBe(requests.length);
      const unavailable = fixture({}, { release, java, releaseType });
      await expect(resolveMinecraftRuntime(request, unavailable.client)).rejects.toThrow();
    },
  );
  it.each([
    ['1.7.10', '10.13.4.1614-1.7.10', 8],
    ['1.12.2', '14.23.5.2860', 8],
    ['1.17.1', '37.1.1', 16],
  ] as const)(
    'resolves Forge %s legacy Java fallback and exact Maven suffix',
    async (release, loaderVersion, javaMajor) => {
      const coordinate = `${release}-${loaderVersion}`;
      const installer = `https://maven.minecraftforge.net/net/minecraftforge/forge/${coordinate}/forge-${coordinate}-installer.jar`;
      const { client } = fixture(
        {
          'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json': {
            [release]: [coordinate],
          },
          [`${installer}.sha1`]: 'd'.repeat(40),
          [installer.replace('-installer.jar', '-universal.jar.sha1')]: 'e'.repeat(40),
        },
        { release, java: null },
      );
      const result = await resolveMinecraftRuntime(
        { release, profile: 'forge', loaderVersion },
        client,
      );
      expect(result).toMatchObject({ javaMajor, loaderVersion });
      expect(result.artifacts[1]?.url).toBe(installer);
      expect(resolveMinecraftImage(result).image).toBe(
        `ghcr.io/ptero-eggs/yolks:java_${javaMajor}`,
      );
    },
  );
  it('requires Forge exact release-coordinate membership and installer checksum', async () => {
    const installer =
      'https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.4-54.1.16/forge-1.21.4-54.1.16-installer.jar';
    const { client } = fixture(
      {
        'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json': {
          '1.21.4': ['1.21.4-54.1.16'],
        },
        [`${installer}.sha1`]: 'd'.repeat(40),
        [installer.replace('-installer.jar', '-universal.jar.sha1')]: 'e'.repeat(40),
      },
      { release: '1.21.4', java: 21 },
    );
    const runtime = await resolveMinecraftRuntime(
      { release: '1.21.4', profile: 'forge', loaderVersion: '54.1.16' },
      client,
    );
    expect(runtime.installation).toEqual({ kind: 'forge-installer', args: ['--installServer'] });
    expect(runtime.artifacts[1]).toMatchObject({ sha1: 'd'.repeat(40) });
    const mapping: MinecraftRuntimeMapping = {
      profile: 'forge',
      release: '1.21.4',
      image: 'example.invalid/java:21',
      imageJavaMajor: 21,
      declaredEggVariables: ['MINECRAFT_VERSION', 'FORGE_VERSION'],
      bindings: { release: 'MINECRAFT_VERSION', loaderCoordinate: 'FORGE_VERSION' },
      fixedVariables: {},
      installationKind: 'forge-installer',
      artifactPaths: {},
      supportedProperties: [],
    };
    expect(validateMinecraftRuntimeMapping(runtime, mapping)).toEqual({
      MINECRAFT_VERSION: '1.21.4',
      FORGE_VERSION: '1.21.4-54.1.16',
    });
    expect(
      validateMinecraftRuntimeMapping(runtime, {
        ...mapping,
        bindings: { release: 'MINECRAFT_VERSION', loaderVersion: 'FORGE_VERSION' },
      }).FORGE_VERSION,
    ).toBe('54.1.16');
    expect(() =>
      validateMinecraftRuntimeMapping(runtime, {
        ...mapping,
        bindings: { loaderCoordinate: 'FORGE_VERSION' },
      }),
    ).toThrow();
    expect(() =>
      validateMinecraftRuntimeMapping(runtime, {
        ...mapping,
        bindings: { ...mapping.bindings, loaderVersion: 'FORGE_VERSION' },
      }),
    ).toThrow();
    await expect(
      resolveMinecraftRuntime(
        { release: '1.21.4', profile: 'forge', loaderVersion: '55.0.0' },
        client,
      ),
    ).rejects.toThrow();
  });
  it('does not permit credentials, query injection, untrusted hosts or oversized metadata', async () => {
    for (const url of [
      'http://piston-meta.mojang.com/file',
      'https://piston-meta.mojang.com.evil.test/file',
      'https://user:p@piston-meta.mojang.com/file',
      'https://piston-meta.mojang.com/file?secret=1',
      'https://127.0.0.1/file',
    ])
      expect(() => trustedMinecraftArtifactUrl(url)).toThrow();
    const client = createRuntimeMetadataClient({
      userAgent,
      maxBytes: 8,
      fetch: async () => new Response('123456789'),
    });
    await expect(client.read(manifestUrl)).rejects.toMatchObject({
      details: { reason: 'minecraft_metadata_oversized' },
    });
    const clientLength = createRuntimeMetadataClient({
      userAgent,
      maxBytes: 8,
      fetch: async () => new Response('x', { headers: { 'content-length': '9' } }),
    });
    await expect(clientLength.read(manifestUrl)).rejects.toThrow();
  });
  it('requires explicit egg variable bindings, matching image Java and immutable runtime', async () => {
    const runtime = await resolveMinecraftRuntime(
      { release: '26.1', profile: 'vanilla' },
      fixture().client,
    );
    const mapping: MinecraftRuntimeMapping = {
      profile: 'vanilla',
      release: '26.1',
      image: 'example.invalid/java@sha256:pinned',
      imageJavaMajor: 25,
      declaredEggVariables: ['MC_RELEASE', 'SERVER_URL'],
      bindings: { release: 'MC_RELEASE', serverArtifactUrl: 'SERVER_URL' },
      fixedVariables: {},
      installationKind: 'server-jar',
      artifactPaths: { server: 'server.jar' },
      supportedProperties: ['motd', 'pvp'],
    };
    expect(validateMinecraftRuntimeMapping(runtime, mapping)).toEqual({
      MC_RELEASE: '26.1',
      SERVER_URL: serverUrl,
    });
    for (const update of [
      { imageJavaMajor: 21 },
      { imageJavaMajor: 26 },
      { release: '1.21.4' },
      { profile: 'paper' as const },
      { bindings: {} },
      { bindings: { release: 'MC_RELEASE', loaderCoordinate: 'SERVER_URL' } },
      { declaredEggVariables: [] },
      { bindings: { release: 'MC_RELEASE', serverArtifactUrl: 'MC_RELEASE' } },
      { fixedVariables: { MC_RELEASE: 'other' } },
    ])
      expect(() => validateMinecraftRuntimeMapping(runtime, { ...mapping, ...update })).toThrow();
  });
});

it.each([
  ['1.20.1', '1.20.1-47.1.106', 'forge', 17],
  ['1.21.1', '21.1.72', 'neoforge', 21],
  ['26.1', '26.1.0.1-beta', 'neoforge', 25],
] as const)(
  'resolves an exact NeoForge %s pair through trusted metadata only',
  async (release, loaderVersion, artifact, java) => {
    const base = `https://maven.neoforged.net/releases/net/neoforged/${artifact}`;
    const installer = `${base}/${loaderVersion}/${artifact}-${loaderVersion}-installer.jar`;
    const metadata = `<metadata><groupId>net.neoforged</groupId><artifactId>${artifact}</artifactId><versioning><versions><version>${loaderVersion}</version></versions></versioning></metadata>`;
    const { client, requests } = fixture(
      { [`${base}/maven-metadata.xml`]: metadata, [`${installer}.sha1`]: 'b'.repeat(40) },
      { release, java },
    );
    const resolved = await resolveMinecraftRuntime(
      { profile: 'neoforge', release, loaderVersion },
      client,
    );
    expect(resolved).toMatchObject({
      profile: 'neoforge',
      loaderVersion,
      javaMajor: java,
      installation: { kind: 'neoforge-installer', args: ['--installServer'] },
    });
    expect(resolved.artifacts[1]).toEqual({
      role: 'installer',
      url: installer,
      sha1: 'b'.repeat(40),
    });
    expect(requests).not.toContain(installer);
    expect(resolveMinecraftImage(resolved).image).toContain(`java_${java}`);
    await expect(
      resolveMinecraftRuntime({ profile: 'neoforge', release, loaderVersion: '21.9.1' }, client),
    ).rejects.toThrow();
    await expect(
      resolveMinecraftRuntime(
        { profile: 'neoforge', release, loaderVersion, installerVersion: 'latest' },
        client,
      ),
    ).rejects.toThrow();
  },
);

describe('Quilt exact runtime provenance', () => {
  function quiltFixture(release = '26.3', changes: Record<string, unknown> = {}) {
    const loader = '0.31.0-beta.5';
    const base = `https://meta.quiltmc.org/v3/versions/loader/${release}/${loader}`;
    const libraryUrl = 'https://maven.fabricmc.net/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar.sha1';
    const installerUrl =
      'https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.15.1/quilt-installer-0.15.1.jar';
    const pair = {
      loader: {
        version: loader,
        maven: `org.quiltmc:quilt-loader:${loader}`,
        hashes: { sha256: 'b'.repeat(64) },
      },
    };
    const profile = {
      id: `quilt-loader-${loader}-${release}`,
      inheritsFrom: release,
      mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotServer',
      launcherMainClass: 'org.quiltmc.loader.impl.launch.server.QuiltServerLauncher',
      libraries: [
        {
          name: `org.quiltmc:quilt-loader:${loader}`,
          url: 'https://maven.quiltmc.org/repository/release/',
        },
        { name: 'org.ow2.asm:asm:9.10.1', url: 'https://maven.fabricmc.net/' },
      ],
    };
    const f = fixture(
      {
        [base]: pair,
        [`${base}/server/json`]: profile,
        [libraryUrl]: 'c'.repeat(40),
        'https://meta.quiltmc.org/v3/versions/installer': [
          {
            version: '0.15.1',
            maven: 'org.quiltmc:quilt-installer:0.15.1',
            url: installerUrl,
            hashes: { sha256: 'd'.repeat(64) },
            file_size: 500,
          },
        ],
        ...changes,
      },
      { release, releaseType: release.includes('snapshot') ? 'snapshot' : 'release' },
    );
    return {
      ...f,
      base,
      pair,
      profile,
      installerUrl,
      request: {
        profile: 'quilt' as const,
        release,
        loaderVersion: loader,
        installerVersion: '0.15.1',
      },
    };
  }
  it.each(['26.3', '26.4-snapshot-6'])(
    'resolves %s without requiring obsolete mappings and pins all launcher libraries',
    async (release) => {
      const f = quiltFixture(release);
      const runtime = await resolveMinecraftRuntime(f.request, f.client);
      expect(runtime.javaMajor).toBe(25);
      expect(runtime.installation).toEqual({
        kind: 'quilt-installer',
        args: ['install', 'server', release, '0.31.0-beta.5', '--download-server'],
        quiltLauncherMainClass: 'org.quiltmc.loader.impl.launch.server.QuiltServerLauncher',
        quiltLibraries: [
          {
            path: 'libraries/org/quiltmc/quilt-loader/0.31.0-beta.5/quilt-loader-0.31.0-beta.5.jar',
            sha256: 'b'.repeat(64),
          },
          { path: 'libraries/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar', sha1: 'c'.repeat(40) },
        ],
      });
      expect(runtime.artifacts[1]).toMatchObject({
        role: 'installer',
        url: f.installerUrl,
        sha256: 'd'.repeat(64),
        size: 500,
      });
      expect(runtime.evidence).toHaveLength(6);
    },
  );
  it.each([
    { inheritsFrom: '1.21.1' },
    { mainClass: 'evil.Main' },
    { id: 'other' },
    {
      libraries: [{ name: 'org.quiltmc:quilt-loader:0.31.0-beta.5', url: 'https://example.com/' }],
    },
    { libraries: [{ name: '..:evil:1', url: 'https://maven.fabricmc.net/' }] },
  ])('rejects mismatched profiles and unsafe classpaths %j', async (change) => {
    const f = quiltFixture();
    const changed = quiltFixture('26.3', {
      [`${f.base}/server/json`]: { ...f.profile, ...change },
    });
    await expect(resolveMinecraftRuntime(changed.request, changed.client)).rejects.toThrow();
  });
  it('rejects missing explicit versions, wrong loader identity and bad library hashes', async () => {
    const f = quiltFixture();
    await expect(
      resolveMinecraftRuntime({ ...f.request, installerVersion: undefined }, f.client),
    ).rejects.toThrow();
    const mismatch = quiltFixture('26.3', {
      [f.base]: { loader: { ...f.pair.loader, version: '0.30.2' } },
    });
    await expect(resolveMinecraftRuntime(mismatch.request, mismatch.client)).rejects.toThrow();
    const hash = quiltFixture('26.3', {
      'https://maven.fabricmc.net/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar.sha1': 'bad',
    });
    await expect(resolveMinecraftRuntime(hash.request, hash.client)).rejects.toThrow();
  });
});
