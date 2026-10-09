import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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
  options: { java?: number; corrupt?: boolean; release?: string } = {},
) {
  const release = options.release ?? '26.1';
  const version = JSON.stringify({
    id: release,
    javaVersion: { majorVersion: options.java ?? 25 },
    downloads: { server: { url: serverUrl, size: 1000, sha1: 'a'.repeat(40) } },
  });
  const responses: Record<string, unknown> = {
    [manifestUrl]: {
      versions: [
        { id: '1.14 Pre-Release 1', type: 'snapshot', url: releaseUrl, sha1: 'a'.repeat(40) },
        {
          id: release,
          type: 'release',
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
  it('requires Forge exact release-coordinate membership and installer checksum', async () => {
    const installer =
      'https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.4-54.1.16/forge-1.21.4-54.1.16-installer.jar';
    const { client } = fixture(
      {
        'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json': {
          '1.21.4': ['1.21.4-54.1.16'],
        },
        [`${installer}.sha1`]: 'd'.repeat(40),
      },
      { release: '1.21.4', java: 21 },
    );
    const runtime = await resolveMinecraftRuntime(
      { release: '1.21.4', profile: 'forge', loaderVersion: '54.1.16' },
      client,
    );
    expect(runtime.installation).toEqual({ kind: 'forge-installer', args: ['--installServer'] });
    expect(runtime.artifacts[1]).toMatchObject({ sha1: 'd'.repeat(40) });
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
      { declaredEggVariables: [] },
      { bindings: { release: 'MC_RELEASE', serverArtifactUrl: 'MC_RELEASE' } },
      { fixedVariables: { MC_RELEASE: 'other' } },
    ])
      expect(() => validateMinecraftRuntimeMapping(runtime, { ...mapping, ...update })).toThrow();
  });
});
