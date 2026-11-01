import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { foliaJavaMajor } from './folia-policy.js';
import { forgeJavaMajor } from './forge-policy.js';
import { neoforgeCatalogUrls, parseNeoForgeVersions } from './neoforge-catalog.js';
import {
  neoforgeArtifact,
  neoforgeJavaMajor,
  neoforgeMinecraftVersion,
} from './neoforge-policy.js';
import { paperJavaMajor } from './paper-policy.js';
import { purpurBuildSchema, purpurVersionSchema } from './purpur-catalog.js';
import { purpurJavaMajor } from './purpur-policy.js';
import { quiltCatalogUrls, quiltInstallerListSchema } from './quilt-catalog.js';
import { vanillaJavaMajor } from './vanilla-policy.js';

export const minecraftRuntimeProfiles = [
  'vanilla',
  'paper',
  'purpur',
  'folia',
  'fabric',
  'quilt',
  'forge',
  'neoforge',
] as const;
export type MinecraftRuntimeProfile = (typeof minecraftRuntimeProfiles)[number];
const exactVersion = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/);
const releaseVersion = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+ -]*[a-zA-Z0-9._+-]$|^[a-zA-Z0-9]$/);
const javaVersion = z.number().int().min(8).max(100);
const sha1 = z.string().regex(/^[a-f0-9]{40}$/i);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const origins = new Set([
  'https://piston-meta.mojang.com',
  'https://launchermeta.mojang.com',
  'https://piston-data.mojang.com',
  'https://launcher.mojang.com',
  'https://api.purpurmc.org',
  'https://fill.papermc.io',
  'https://fill-data.papermc.io',
  'https://meta.quiltmc.org',
  'https://maven.quiltmc.org',
  'https://meta.fabricmc.net',
  'https://maven.fabricmc.net',
  'https://files.minecraftforge.net',
  'https://maven.minecraftforge.net',
  'https://maven.neoforged.net',
]);

function fail(reason: string): never {
  throw new DomainError('integration_unavailable', 503, { reason });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fail('minecraft_metadata_invalid');
}
export function trustedMinecraftArtifactUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('minecraft_artifact_origin');
  }
  if (!origins.has(url.origin) || url.username || url.password || url.hash || url.search)
    return fail('minecraft_artifact_origin');
  return url.href;
}
export interface RuntimeSourceEvidence {
  readonly url: string;
  readonly sha256: string;
  readonly retrievedAt: string;
}
export interface RuntimeArtifact {
  readonly role: 'server' | 'installer';
  readonly url: string;
  readonly md5?: string;
  readonly sha1?: string;
  readonly sha256?: string;
  readonly size?: number;
}
export interface ResolvedMinecraftRuntime {
  readonly release: string;
  readonly releaseType: 'release' | 'snapshot' | 'old_alpha' | 'old_beta';
  readonly profile: MinecraftRuntimeProfile;
  readonly buildId?: number;
  readonly loaderVersion?: string;
  readonly installerVersion?: string;
  readonly javaMajor: number;
  readonly upstreamSupport?: string;
  readonly upstreamChannel?: string;
  readonly artifacts: readonly RuntimeArtifact[];
  readonly installation: {
    readonly kind:
      | 'server-jar'
      | 'fabric-installer'
      | 'quilt-installer'
      | 'forge-installer'
      | 'neoforge-installer';
    readonly args: readonly string[];
    /** Exact renamed universal JAR receipt for pre-1.13 Forge only. */
    readonly serverJarSha1?: string;
    readonly quiltLibraries?: readonly {
      readonly path: string;
      readonly sha1?: string;
      readonly sha256?: string;
    }[];
    readonly quiltLauncherMainClass?: 'org.quiltmc.loader.impl.launch.server.QuiltServerLauncher';
  };
  readonly evidence: readonly RuntimeSourceEvidence[];
}
export interface RuntimeMetadataDocument {
  readonly bytes: Uint8Array;
  readonly evidence: RuntimeSourceEvidence;
}
export interface RuntimeMetadataClient {
  read(url: string): Promise<RuntimeMetadataDocument>;
}

/** No redirects, arbitrary mirrors, ambient credentials, or unbounded metadata buffers. */
export function createRuntimeMetadataClient(options: {
  userAgent: string;
  fetch?: typeof fetch;
  now?: () => Date;
  maxBytes?: number;
  timeoutMs?: number;
}): RuntimeMetadataClient {
  if (!/^[\x20-\x7e]{10,200}$/.test(options.userAgent) || !/https:\/\//.test(options.userAgent))
    throw new DomainError('configuration_invalid');
  const limit = options.maxBytes ?? 4 * 1024 * 1024;
  const timeout = options.timeoutMs ?? 15_000;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 60_000
  )
    throw new DomainError('configuration_invalid');
  return {
    async read(value) {
      const url = trustedMinecraftArtifactUrl(value);
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(url, {
          redirect: 'error',
          credentials: 'omit',
          headers: { 'User-Agent': options.userAgent, Accept: 'application/json, text/plain' },
          signal: AbortSignal.timeout(timeout),
        });
      } catch {
        return fail('minecraft_metadata_unavailable');
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return fail('minecraft_metadata_unavailable');
      }
      if (Number(response.headers.get('content-length') ?? 0) > limit) {
        await response.body.cancel();
        return fail('minecraft_metadata_oversized');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          size += chunk.byteLength;
          if (size > limit) return fail('minecraft_metadata_oversized');
          chunks.push(chunk);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks, size);
      return {
        bytes,
        evidence: {
          url,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          retrievedAt: (options.now?.() ?? new Date()).toISOString(),
        },
      };
    },
  };
}
function json(document: RuntimeMetadataDocument): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(document.bytes));
  } catch {
    return fail('minecraft_metadata_invalid');
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const minecraftRuntimeRequestSchema = z
  .object({
    release: releaseVersion,
    profile: z.enum(minecraftRuntimeProfiles),
    buildId: z.number().int().nonnegative().optional(),
    loaderVersion: exactVersion.optional(),
    installerVersion: exactVersion.optional(),
  })
  .strict();
export type MinecraftRuntimeRequest = z.infer<typeof minecraftRuntimeRequestSchema>;

/** Resolution is provenance, not installation or game-protocol compatibility evidence. */
export async function resolveMinecraftRuntime(
  input: MinecraftRuntimeRequest,
  client: RuntimeMetadataClient,
): Promise<ResolvedMinecraftRuntime> {
  const request = parse(minecraftRuntimeRequestSchema, input);
  if (
    ['paper', 'purpur', 'folia'].includes(request.profile) !== (request.buildId !== undefined) ||
    ['fabric', 'quilt', 'forge', 'neoforge'].includes(request.profile) !==
      (request.loaderVersion !== undefined) ||
    ['fabric', 'quilt'].includes(request.profile) !== (request.installerVersion !== undefined)
  )
    throw new DomainError('validation_failed');
  const evidence: RuntimeSourceEvidence[] = [];
  let quiltBytes = 0;
  const read = async (url: string) => {
    const document = await client.read(trustedMinecraftArtifactUrl(url));
    if (request.profile === 'quilt') {
      quiltBytes += document.bytes.byteLength;
      if (quiltBytes > 8 * 1024 * 1024 || evidence.length >= 140)
        return fail('quilt_metadata_budget_exceeded');
    }
    evidence.push(document.evidence);
    return document;
  };
  const manifest = parse(
    z.object({
      versions: z
        .array(
          z.object({
            id: z.string().min(1).max(128),
            type: z.enum(['release', 'snapshot', 'old_alpha', 'old_beta']),
            url: z.string(),
            sha1,
          }),
        )
        .max(20_000),
    }),
    json(await read('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')),
  );
  const matches = manifest.versions.filter((entry) => entry.id === request.release);
  if (matches.length !== 1) return fail('minecraft_release_unavailable');
  const entry = matches[0];
  if (!entry) return fail('minecraft_release_unavailable');
  const releaseDocument = await read(entry.url);
  if (createHash('sha1').update(releaseDocument.bytes).digest('hex') !== entry.sha1.toLowerCase())
    return fail('minecraft_metadata_integrity');
  const release = parse(
    z.object({
      id: releaseVersion,
      javaVersion: z.object({ majorVersion: javaVersion }).optional(),
      downloads: z.object({
        server: z.object({ url: z.string(), sha1, size: z.number().int().positive() }).optional(),
      }),
    }),
    json(releaseDocument),
  );
  if (release.id !== request.release) return fail('minecraft_release_mismatch');
  if (!release.downloads.server) return fail('minecraft_server_download_unavailable');
  let javaMajor =
    request.profile === 'vanilla' || request.profile === 'fabric' || request.profile === 'quilt'
      ? vanillaJavaMajor(request.release, entry.type, release.javaVersion?.majorVersion)
      : request.profile === 'neoforge'
        ? neoforgeJavaMajor(request.release, release.javaVersion?.majorVersion)
        : request.profile === 'forge'
          ? forgeJavaMajor(request.release, release.javaVersion?.majorVersion)
          : request.profile === 'paper' ||
              request.profile === 'folia' ||
              request.profile === 'purpur'
            ? (release.javaVersion?.majorVersion ?? 8)
            : (release.javaVersion?.majorVersion ?? fail('minecraft_java_unknown'));
  let upstreamSupport: string | undefined;
  let upstreamChannel: string | undefined;
  let artifacts: RuntimeArtifact[] = [
    {
      role: 'server',
      url: trustedMinecraftArtifactUrl(release.downloads.server.url),
      sha1: release.downloads.server.sha1.toLowerCase(),
      size: release.downloads.server.size,
    },
  ];
  let installation: ResolvedMinecraftRuntime['installation'] = { kind: 'server-jar', args: [] };
  if (request.profile === 'paper' || request.profile === 'folia') {
    const base = `https://fill.papermc.io/v3/projects/${request.profile}/versions/${request.release}`;
    const version = parse(
      z.object({
        version: z.object({
          id: exactVersion,
          support: z.object({ status: z.string().max(100) }).optional(),
          java: z.object({
            version: z.object({
              minimum: z.number().int().min(6).max(100),
            }),
          }),
        }),
        builds: z.array(z.number().int()).max(100_000),
      }),
      json(await read(base)),
    );
    if (version.version.id !== request.release || !version.builds.includes(request.buildId ?? -1))
      return fail('minecraft_build_unavailable');
    const build = parse(
      z.object({
        id: z.number().int(),
        channel: z.enum(['STABLE', 'RECOMMENDED', 'EXPERIMENTAL', 'ALPHA', 'BETA']),
        downloads: z.object({
          'server:default': z.object({
            url: z.string(),
            checksums: z.object({ sha256 }),
            size: z.number().int().positive(),
          }),
        }),
      }),
      json(await read(`${base}/builds/${request.buildId}`)),
    );
    if (build.id !== request.buildId) return fail('minecraft_build_mismatch');
    upstreamSupport = version.version.support?.status;
    upstreamChannel = build.channel;
    const artifact = build.downloads['server:default'];
    javaMajor = (request.profile === 'folia' ? foliaJavaMajor : paperJavaMajor)(
      request.release,
      version.version.java.version.minimum,
      release.javaVersion?.majorVersion,
    );
    artifacts = [
      {
        role: 'server',
        url: trustedMinecraftArtifactUrl(artifact.url),
        sha256: artifact.checksums.sha256.toLowerCase(),
        size: artifact.size,
      },
    ];
  } else if (request.profile === 'purpur') {
    const base = `https://api.purpurmc.org/v2/purpur/${request.release}`;
    const version = parse(purpurVersionSchema, json(await read(base)));
    if (
      version.version !== request.release ||
      !version.builds.all.includes(String(request.buildId))
    )
      return fail('minecraft_build_unavailable');
    const build = parse(purpurBuildSchema, json(await read(`${base}/${request.buildId}`)));
    if (build.version !== request.release || Number(build.build) !== request.buildId)
      return fail('minecraft_build_mismatch');
    javaMajor = purpurJavaMajor(request.release, release.javaVersion?.majorVersion);
    artifacts = [
      {
        role: 'server',
        url: trustedMinecraftArtifactUrl(`${base}/${request.buildId}/download`),
        md5: build.md5.toLowerCase(),
      },
    ];
  } else if (request.profile === 'fabric') {
    const pair = parse(
      z.object({
        loader: z.object({ version: exactVersion }),
        intermediary: z.object({ version: releaseVersion }),
        launcherMeta: z.object({ min_java_version: javaVersion.optional() }),
      }),
      json(
        await read(
          `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(request.release)}/${request.loaderVersion}`,
        ),
      ),
    );
    if (pair.loader.version !== request.loaderVersion) return fail('minecraft_loader_mismatch');
    // Since 26.1 the official intermediary identity can be 0.0.0 (unobfuscated).
    // Exact server-profile inheritance establishes the requested game identity instead.
    const serverProfile = parse(
      z.object({ inheritsFrom: releaseVersion, mainClass: z.string().min(1).max(500) }),
      json(
        await read(
          `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(request.release)}/${request.loaderVersion}/server/json`,
        ),
      ),
    );
    if (
      serverProfile.inheritsFrom !== request.release ||
      (!serverProfile.mainClass.startsWith('net.fabricmc.') &&
        serverProfile.mainClass !== 'net.minecraft.launchwrapper.Launch')
    )
      return fail('minecraft_loader_mismatch');
    const installers = parse(
      z.array(z.object({ version: exactVersion, url: z.string() })).max(10_000),
      json(await read('https://meta.fabricmc.net/v2/versions/installer')),
    );
    const installersMatched = installers.filter(
      (item) => item.version === request.installerVersion,
    );
    if (installersMatched.length !== 1 || !installersMatched[0])
      return fail('minecraft_installer_unavailable');
    const url = trustedMinecraftArtifactUrl(installersMatched[0].url);
    const hash = parse(
      sha256,
      new TextDecoder().decode((await read(`${url}.sha256`)).bytes).trim(),
    );
    artifacts.push({ role: 'installer', url, sha256: hash.toLowerCase() });
    // Fabric recommends Java 17 for 1.17–1.20.4. The shared Minecraft baseline
    // already selects 17 for 1.18–1.20.4; only stable 1.17/1.17.1 need an override.
    // Snapshot requirements remain metadata-led. https://wiki.fabricmc.net/install
    const recommendedJava =
      entry.type === 'release' && /^1\.17(?:\.1)?$/.test(request.release) ? 17 : javaMajor;
    javaMajor = Math.max(javaMajor, recommendedJava, pair.launcherMeta.min_java_version ?? 8);
    installation = {
      kind: 'fabric-installer',
      args: [
        'server',
        '-mcversion',
        request.release,
        '-loader',
        request.loaderVersion ?? '',
        '-downloadMinecraft',
      ],
    };
  } else if (request.profile === 'quilt') {
    const base = `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(request.release)}/${request.loaderVersion}`;
    const pair = parse(
      z.object({
        loader: z.object({
          version: exactVersion,
          maven: z.string(),
          hashes: z.object({ sha256 }),
        }),
      }),
      json(await read(base)),
    );
    if (
      pair.loader.version !== request.loaderVersion ||
      pair.loader.maven !== `org.quiltmc:quilt-loader:${request.loaderVersion}`
    )
      return fail('minecraft_loader_mismatch');
    const profile = parse(
      z.object({
        id: z.string(),
        inheritsFrom: releaseVersion,
        mainClass: z.literal('org.quiltmc.loader.impl.launch.knot.KnotServer'),
        launcherMainClass: z.literal('org.quiltmc.loader.impl.launch.server.QuiltServerLauncher'),
        libraries: z
          .array(z.object({ name: z.string().min(1).max(500), url: z.string() }))
          .min(1)
          .max(128),
      }),
      json(await read(`${base}/server/json`)),
    );
    if (
      profile.id !== `quilt-loader-${request.loaderVersion}-${request.release}` ||
      profile.inheritsFrom !== request.release
    )
      return fail('minecraft_loader_mismatch');
    for (const library of profile.libraries) {
      const origin = new URL(trustedMinecraftArtifactUrl(library.url)).origin;
      if (
        !['https://maven.quiltmc.org', 'https://maven.fabricmc.net'].includes(origin) ||
        !['https://maven.quiltmc.org/repository/release/', 'https://maven.fabricmc.net/'].includes(
          library.url,
        ) ||
        !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]*:[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(
          library.name,
        )
      )
        return fail('minecraft_metadata_invalid');
    }
    if (
      profile.libraries.filter(
        (library) =>
          library.name === pair.loader.maven &&
          library.url === 'https://maven.quiltmc.org/repository/release/',
      ).length !== 1
    )
      return fail('minecraft_loader_mismatch');
    const quiltLibraries: NonNullable<
      ResolvedMinecraftRuntime['installation']['quiltLibraries']
    >[number][] = [];
    for (const library of profile.libraries) {
      const [group, artifact, version] = library.name.split(':');
      const path = `${group?.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
      if (quiltLibraries.some((item) => item.path === `libraries/${path}`))
        return fail('minecraft_metadata_invalid');
      if (library.name === pair.loader.maven) {
        quiltLibraries.push({
          path: `libraries/${path}`,
          sha256: pair.loader.hashes.sha256.toLowerCase(),
        });
      } else {
        const url = trustedMinecraftArtifactUrl(`${library.url}${path}.sha1`);
        const hash = parse(sha1, new TextDecoder().decode((await read(url)).bytes).trim());
        quiltLibraries.push({ path: `libraries/${path}`, sha1: hash.toLowerCase() });
      }
    }
    const installers = parse(
      quiltInstallerListSchema,
      json(await read(quiltCatalogUrls.installers)),
    );
    const matched = installers.filter((item) => item.version === request.installerVersion);
    if (matched.length !== 1 || !matched[0]) return fail('minecraft_installer_unavailable');
    artifacts.push({
      role: 'installer',
      url: trustedMinecraftArtifactUrl(matched[0].url),
      sha256: matched[0].hashes.sha256.toLowerCase(),
      size: matched[0].file_size,
    });
    installation = {
      kind: 'quilt-installer',
      quiltLibraries,
      quiltLauncherMainClass: profile.launcherMainClass,
      args: [
        'install',
        'server',
        request.release,
        request.loaderVersion ?? '',
        '--download-server',
      ],
    };
  } else if (request.profile === 'neoforge') {
    const artifact = neoforgeArtifact(request.release);
    if (
      !request.loaderVersion ||
      neoforgeMinecraftVersion(request.loaderVersion) !== request.release
    )
      return fail('minecraft_loader_mismatch');
    const metadataUrl =
      artifact === 'forge' ? neoforgeCatalogUrls.legacy : neoforgeCatalogUrls.versions;
    const versions = parseNeoForgeVersions(
      new TextDecoder('utf-8', { fatal: true }).decode((await read(metadataUrl)).bytes),
      artifact,
    );
    if (!versions.includes(request.loaderVersion)) return fail('minecraft_loader_unavailable');
    const url = `https://maven.neoforged.net/releases/net/neoforged/${artifact}/${request.loaderVersion}/${artifact}-${request.loaderVersion}-installer.jar`;
    const hash = parse(sha1, new TextDecoder().decode((await read(`${url}.sha1`)).bytes).trim());
    artifacts.push({ role: 'installer', url, sha1: hash.toLowerCase() });
    installation = { kind: 'neoforge-installer', args: ['--installServer'] };
  } else if (request.profile === 'forge') {
    const versions = parse(
      z.record(z.string(), z.array(exactVersion).max(100_000)),
      json(
        await read('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json'),
      ),
    );
    const coordinate = `${request.release}-${request.loaderVersion}`;
    if (!versions[request.release]?.includes(coordinate))
      return fail('minecraft_loader_unavailable');
    const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${coordinate}/forge-${coordinate}-installer.jar`;
    const hash = parse(sha1, new TextDecoder().decode((await read(`${url}.sha1`)).bytes).trim());
    artifacts.push({ role: 'installer', url, sha1: hash.toLowerCase() });
    const serverJarSha1 =
      Number(request.release.split('.')[1]) <= 12
        ? parse(
            sha1,
            new TextDecoder()
              .decode((await read(url.replace('-installer.jar', '-universal.jar.sha1'))).bytes)
              .trim(),
          ).toLowerCase()
        : undefined;
    installation = {
      kind: 'forge-installer',
      args: ['--installServer'],
      ...(serverJarSha1 ? { serverJarSha1 } : {}),
    };
  }
  return freeze({
    ...request,
    releaseType: entry.type,
    javaMajor,
    ...(upstreamSupport ? { upstreamSupport } : {}),
    ...(upstreamChannel ? { upstreamChannel } : {}),
    artifacts,
    installation,
    evidence,
  });
}

export type MinecraftRuntimeVariable =
  | 'release'
  | 'buildId'
  | 'loaderVersion'
  | 'loaderCoordinate'
  | 'installerVersion'
  | 'serverArtifactUrl'
  | 'installerArtifactUrl';
const artifactPath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes(':') &&
      [...path].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) &&
      path.split('/').every((segment) => segment && segment !== '.' && segment !== '..'),
  );
export const minecraftRuntimeMappingSchema = z
  .object({
    profile: z.enum(minecraftRuntimeProfiles),
    release: releaseVersion,
    image: z.string().min(1).max(500),
    imageJavaMajor: javaVersion,
    declaredEggVariables: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(100),
    bindings: z
      .object({
        release: z.string().optional(),
        buildId: z.string().optional(),
        loaderVersion: z.string().optional(),
        loaderCoordinate: z.string().optional(),
        installerVersion: z.string().optional(),
        serverArtifactUrl: z.string().optional(),
        installerArtifactUrl: z.string().optional(),
      })
      .strict(),
    fixedVariables: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
      z.string().max(4096),
    ),
    installationKind: z.enum([
      'server-jar',
      'fabric-installer',
      'quilt-installer',
      'forge-installer',
      'neoforge-installer',
    ]),
    artifactPaths: z
      .object({ server: artifactPath.optional(), installer: artifactPath.optional() })
      .strict(),
    supportedProperties: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,100}$/)).max(1000),
  })
  .strict();
export interface MinecraftRuntimeMapping {
  readonly profile: MinecraftRuntimeProfile;
  readonly release: string;
  readonly image: string;
  /** Verified outside this pure planner against the discovered egg/image. */
  readonly imageJavaMajor: number;
  readonly declaredEggVariables: readonly string[];
  readonly bindings: Readonly<Partial<Record<MinecraftRuntimeVariable, string>>>;
  readonly fixedVariables: Readonly<Record<string, string>>;
  readonly installationKind: ResolvedMinecraftRuntime['installation']['kind'];
  readonly artifactPaths: Readonly<{ server?: string; installer?: string }>;
  /** Must be attested by the exact tested runtime, not merely declared by an Owner. */
  readonly supportedProperties: readonly string[];
}
/** The adapter's discovered egg/image checks remain mandatory at execution time. */
export function validateMinecraftRuntimeMapping(
  runtime: ResolvedMinecraftRuntime,
  mapping: MinecraftRuntimeMapping,
): Readonly<Record<string, string>> {
  if (!minecraftRuntimeMappingSchema.safeParse(mapping).success)
    throw new DomainError('configuration_invalid');
  if (
    mapping.profile !== runtime.profile ||
    mapping.release !== runtime.release ||
    mapping.imageJavaMajor !== runtime.javaMajor ||
    mapping.installationKind !== runtime.installation.kind ||
    !mapping.image.trim()
  )
    throw new DomainError('configuration_invalid', 400, { reason: 'minecraft_runtime_mapping' });
  if (runtime.installation.kind === 'server-jar' && !mapping.artifactPaths.server)
    throw new DomainError('configuration_invalid');
  if (
    mapping.artifactPaths.server &&
    mapping.artifactPaths.server === mapping.artifactPaths.installer
  )
    throw new DomainError('configuration_invalid');
  if (new Set(mapping.supportedProperties).size !== mapping.supportedProperties.length)
    throw new DomainError('configuration_invalid');
  const values: Record<MinecraftRuntimeVariable, string | undefined> = {
    release: runtime.release,
    buildId: runtime.buildId?.toString(),
    loaderVersion: runtime.loaderVersion,
    loaderCoordinate:
      runtime.profile === 'forge' && runtime.loaderVersion
        ? `${runtime.release}-${runtime.loaderVersion}`
        : undefined,
    installerVersion: runtime.installerVersion,
    serverArtifactUrl: runtime.artifacts.find((item) => item.role === 'server')?.url,
    installerArtifactUrl: runtime.artifacts.find((item) => item.role === 'installer')?.url,
  };
  const required: MinecraftRuntimeVariable[] = ['release'];
  if (runtime.buildId !== undefined) required.push('buildId');
  if (
    runtime.loaderVersion !== undefined &&
    !(runtime.profile === 'forge' && mapping.bindings.loaderCoordinate)
  )
    required.push('loaderVersion');
  if (runtime.installerVersion !== undefined) required.push('installerVersion');
  if (required.some((key) => !mapping.bindings[key]))
    throw new DomainError('configuration_invalid');
  const variables: Record<string, string> = { ...mapping.fixedVariables };
  const used = new Set(Object.keys(variables));
  for (const [semantic, variable] of Object.entries(mapping.bindings)) {
    const value = values[semantic as MinecraftRuntimeVariable];
    if (!value || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(variable) || used.has(variable))
      throw new DomainError('configuration_invalid');
    variables[variable] = value;
    used.add(variable);
  }
  if (Object.keys(variables).some((key) => !mapping.declaredEggVariables.includes(key)))
    throw new DomainError('configuration_invalid');
  return Object.freeze(variables);
}
