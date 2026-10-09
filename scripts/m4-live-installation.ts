/** Read-only installed-runtime evidence capture for provenance-verified M4 test
 * servers. Upstream installer sources are references, not copied code:
 * FabricMC/fabric-installer (Apache-2.0), MinecraftForge/Installer (LGPL-2.1-only).
 * No Java/process/protocol compatibility is inferred from downloaded files. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm, statfs } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { canonicalMinecraftJarSha256 } from '../games/minecraft/src/generated-launcher.js';
import { minecraftWorldName, parseMinecraftProperties } from '../games/minecraft/src/management.js';
import {
  createRuntimeMetadataClient,
  type MinecraftRuntimeMapping,
  type ResolvedMinecraftRuntime,
  type RuntimeArtifact,
  type RuntimeMetadataClient,
  trustedMinecraftArtifactUrl,
  validateMinecraftRuntimeMapping,
} from '../games/minecraft/src/runtime.js';
import { inspectMinecraftLevelDat } from '../games/minecraft/src/world.js';
import {
  hashArchiveFile,
  readArchiveFile,
  visitArchive,
} from '../packages/content-providers/src/archive.js';
import { safeArchivePath } from '../packages/content-providers/src/contracts.js';
import type { PterodactylAdapter, ServerFile } from '../packages/pterodactyl-adapter/src/index.js';

// Deliberate test-capture budgets, not product file-transfer limits.
const MAX_FILE = 512 * 1024 ** 2;
const MAX_TOTAL = 2 * 1024 ** 3;
const MAX_METADATA = 1024 ** 2;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export interface MinecraftInstalledFile {
  path: string;
  sha256: string;
  size: number;
  role?: 'fabric-launcher';
  jarEntriesSha256?: string;
  minecraftServerPath?: string;
}
export interface MinecraftInstallationArtifacts {
  artifactSha256: string;
  installedFiles: MinecraftInstalledFile[];
  sources: { url: string; sha256: string }[];
}
export interface MinecraftInstallationCapture {
  artifactSha256: string;
  installedFiles: MinecraftInstalledFile[];
  supportedProperties: string[];
  worldDataVersion: number;
  observations: {
    propertiesSha256: string;
    levelDatSha256: string;
    sources: { url: string; sha256: string }[];
  };
}
export interface MinecraftInstallationOptions {
  adapter: Pick<PterodactylAdapter, 'listFiles' | 'downloadFile'>;
  identifier: string;
  runtime: ResolvedMinecraftRuntime;
  binding: MinecraftRuntimeMapping;
  /** Corroborates the durable ledger with current provider/API identity. */
  assertOwned: () => Promise<void>;
  /** Existing, private job/run directory under mountdata/test-assets. */
  workDirectory: string;
  userAgent: string;
  /** Isolated-test seams only. */
  metadata?: RuntimeMetadataClient;
  fetch?: typeof fetch;
}
function path(value: string): string {
  safeArchivePath(value);
  assert(!value.endsWith('/'), 'Expected a file path');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid installer object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  assert(
    typeof value === 'string' && value.length > 0 && value.length <= 4096,
    'Invalid installer string',
  );
  return value;
}
function array(value: unknown): unknown[] {
  assert(Array.isArray(value) && value.length <= 10000, 'Invalid installer list');
  return value;
}
function maven(coordinate: string): string {
  const match =
    /^([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([A-Za-z0-9_.+-]+)(?::([A-Za-z0-9_.+-]+))?(?:@([A-Za-z0-9]+))?$/.exec(
      coordinate,
    );
  assert(match, 'Unsupported Maven coordinate');
  const [, group, artifact, version, classifier, extension] = match;
  return path(
    `${group?.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension ?? 'jar'}`,
  );
}
function manifest(input: Uint8Array): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = Buffer.from(input)
    .toString('utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\n /g, '')
    .split('\n');
  for (const line of lines) {
    if (!line) break; // only the main attributes, not named entry sections
    const match = /^([A-Za-z0-9-]+): (.*)$/.exec(line);
    assert(match?.[1] && match[2] !== undefined && !(match[1] in result), 'Invalid JAR manifest');
    result[match[1]] = match[2];
  }
  return result;
}
function matches(
  actual: { sha256: string; sha1: string; size: number },
  expected: { sha256?: string; sha1?: string; size?: number },
) {
  assert(expected.sha1 || expected.sha256, 'Artifact lacks authoritative hash');
  if (expected.sha256) {
    assert.match(expected.sha256, /^[a-f0-9]{64}$/i);
    assert.equal(
      actual.sha256,
      expected.sha256.toLowerCase(),
      'Installed artifact SHA256 mismatch',
    );
  }
  if (expected.sha1) {
    assert.match(expected.sha1, /^[a-f0-9]{40}$/i);
    assert.equal(actual.sha1, expected.sha1.toLowerCase(), 'Installed artifact SHA1 mismatch');
  }
  if (expected.size !== undefined)
    assert.equal(actual.size, expected.size, 'Installed artifact size mismatch');
}
async function hashes(file: string) {
  const h256 = createHash('sha256'),
    h1 = createHash('sha1');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    assert(size <= MAX_FILE, 'Artifact budget exceeded');
    h256.update(chunk);
    h1.update(chunk);
  }
  return { sha256: h256.digest('hex'), sha1: h1.digest('hex'), size };
}
export async function captureMinecraftInstallation(
  options: MinecraftInstallationOptions,
): Promise<MinecraftInstallationCapture> {
  return capture(options, true) as Promise<MinecraftInstallationCapture>;
}
export async function verifyMinecraftInstallationArtifacts(
  options: MinecraftInstallationOptions,
): Promise<MinecraftInstallationArtifacts> {
  return capture(options, false) as Promise<MinecraftInstallationArtifacts>;
}
async function capture(
  options: MinecraftInstallationOptions,
  observeWorld: boolean,
): Promise<MinecraftInstallationCapture | MinecraftInstallationArtifacts> {
  validateMinecraftRuntimeMapping(options.runtime, options.binding);
  assert.match(options.identifier, /^[a-zA-Z0-9_-]{1,100}$/);
  const root = resolve(options.workDirectory);
  assert(
    root
      .split(sep)
      .some((part, i, parts) => part === 'mountdata' && parts[i + 1] === 'test-assets'),
    'Capture must use ignored test-assets storage',
  );
  assert.equal(await realpath(root), root, 'Symlinked work directory refused');
  const info = await lstat(root);
  assert(info.isDirectory() && !info.isSymbolicLink(), 'Invalid work directory');
  const disk = await statfs(root);
  assert(
    Number(disk.bavail) * Number(disk.bsize) >= MAX_TOTAL + 1024 ** 3,
    'Insufficient capture disk budget',
  );
  const work = await mkdtemp(join(root, 'capture-'));
  const files = new Map<string, MinecraftInstalledFile>();
  const sources: { url: string; sha256: string }[] = [];
  const metadata =
    options.metadata ?? createRuntimeMetadataClient({ userAgent: options.userAgent });
  let transferred = 0;
  async function document(url: string) {
    const result = await metadata.read(trustedMinecraftArtifactUrl(url));
    assert(result.bytes.byteLength <= 16 * MAX_METADATA, 'Metadata budget exceeded');
    assert.equal(sha256(result.bytes), result.evidence.sha256, 'Metadata evidence mismatch');
    sources.push({ url, sha256: result.evidence.sha256 });
    return result.bytes;
  }
  async function lookup(file: string): Promise<ServerFile> {
    path(file);
    const parts = file.split('/');
    let directory = '';
    for (let i = 0; i < parts.length; i++) {
      await options.assertOwned();
      const entries = await options.adapter.listFiles(options.identifier, directory);
      assert(entries.length <= 10000, 'Directory budget exceeded');
      const found = entries.filter((entry) => entry.name === parts[i]);
      assert.equal(found.length, 1, 'Required installed file/directory absent or ambiguous');
      const entry = found[0];
      assert(entry && !entry.is_symlink, 'Symlinked installed path refused');
      if (i === parts.length - 1) {
        assert(
          entry.is_file &&
            Number.isSafeInteger(entry.size) &&
            entry.size > 0 &&
            entry.size <= MAX_FILE,
          'Invalid installed file',
        );
        return entry;
      }
      assert(!entry.is_file && entry.mode.startsWith('d'), 'Invalid installed parent directory');
      directory = directory ? `${directory}/${parts[i]}` : (parts[i] as string);
    }
    throw new Error('Missing file');
  }
  async function read(
    file: string,
    input: {
      local?: string;
      collect?: number;
      expected?: RuntimeArtifact | { sha1?: string; sha256?: string; size?: number };
      immutable?: boolean;
    } = {},
  ) {
    const before = await lookup(file);
    const limit = input.collect ?? MAX_FILE;
    assert(before.size <= limit, 'Installed metadata too large');
    const download = await options.adapter.downloadFile(options.identifier, file, {
      maxBytes: Math.min(MAX_FILE, before.size),
      authorize: options.assertOwned,
    });
    const h256 = createHash('sha256'),
      h1 = createHash('sha1');
    let size = 0;
    const chunks: Buffer[] = [];
    const output = input.local ? await open(input.local, 'wx', 0o600) : undefined;
    try {
      for await (const chunk of download.body) {
        size += chunk.byteLength;
        transferred += chunk.byteLength;
        assert(
          size <= limit && size <= before.size && transferred <= MAX_TOTAL,
          'Capture transfer budget exceeded',
        );
        h256.update(chunk);
        h1.update(chunk);
        if (output) await output.writeFile(chunk);
        if (input.collect) chunks.push(Buffer.from(chunk));
      }
    } finally {
      await output?.close();
    }
    assert.equal(size, before.size, 'Truncated installed file');
    const after = await lookup(file);
    assert.equal(after.size, before.size);
    assert.equal(after.modified_at, before.modified_at, 'File changed during capture');
    const result = {
      path: file,
      sha256: h256.digest('hex'),
      sha1: h1.digest('hex'),
      size,
      bytes: Buffer.concat(chunks),
    };
    if (input.expected) matches(result, input.expected);
    if (input.immutable) {
      assert(files.size < 20000, 'Manifest file budget exceeded');
      files.set(file, { path: file, sha256: result.sha256, size });
    }
    return result;
  }
  async function archive(local: string, selected: (name: string) => boolean) {
    const entries = new Map<string, { sha256: string; size: number; bytes?: Buffer }>();
    let metadataBytes = 0;
    await visitArchive(
      local,
      async (entry) => {
        if (!selected(entry.path)) return;
        const metadata = /(?:\.json|\.properties|\.txt|\.sh|\.bat|MANIFEST\.MF)$/.test(entry.path);
        if (metadata) {
          metadataBytes += entry.size;
          assert(metadataBytes <= 16 * MAX_METADATA, 'Archive metadata memory budget exceeded');
        }
        const bytes = metadata ? await readArchiveFile(entry, MAX_METADATA) : undefined;
        entries.set(entry.path, {
          sha256: bytes ? sha256(bytes) : await hashArchiveFile(entry),
          size: entry.size,
          ...(bytes ? { bytes } : {}),
        });
      },
      {
        maxArchiveBytes: MAX_FILE,
        maxExpandedBytes: MAX_FILE,
        maxFileBytes: MAX_FILE,
        maxEntries: 20000,
        maxCompressionRatio: 200,
      },
    );
    return entries;
  }
  async function officialArtifact(artifact: RuntimeArtifact, local: string) {
    const url = trustedMinecraftArtifactUrl(artifact.url);
    const response = await (options.fetch ?? fetch)(url, {
      headers: { 'User-Agent': options.userAgent, 'Accept-Encoding': 'identity' },
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
    });
    assert(
      response.ok && response.status === 200 && response.body,
      'Official artifact unavailable',
    );
    const output = await open(local, 'wx', 0o600);
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        transferred += chunk.byteLength;
        assert(size <= MAX_FILE && transferred <= MAX_TOTAL, 'Official artifact budget exceeded');
        await output.writeFile(chunk);
      }
    } finally {
      await output.close();
    }
    const actual = await hashes(local);
    matches(actual, artifact);
    sources.push({ url, sha256: actual.sha256 });
  }
  try {
    const runtime = options.runtime;
    const serverArtifact = runtime.artifacts.find((artifact) => artifact.role === 'server');
    assert(serverArtifact, 'Missing trusted server artifact');
    let artifactSha256: string;
    if (runtime.installation.kind === 'server-jar') {
      const server = options.binding.artifactPaths.server;
      assert(server, 'Missing bound server artifact');
      artifactSha256 = (await read(server, { expected: serverArtifact, immutable: true })).sha256;
    } else if (runtime.installation.kind === 'fabric-installer') {
      assert(runtime.loaderVersion, 'Exact Fabric loader required');
      const url = `https://meta.fabricmc.net/v2/versions/loader/${runtime.release}/${runtime.loaderVersion}/server/json`;
      const profile = object(JSON.parse(Buffer.from(await document(url)).toString('utf8')));
      assert.equal(profile.inheritsFrom, runtime.release);
      assert.equal(profile.id, `fabric-loader-${runtime.loaderVersion}-${runtime.release}`);
      const launcher = options.binding.artifactPaths.server;
      assert(launcher, 'Fabric launch JAR binding required');
      const local = join(work, 'fabric-launch.jar');
      await read(launcher, { local, immutable: true });
      const semantic = await canonicalMinecraftJarSha256(local);
      const launchEntry = files.get(launcher);
      assert(launchEntry);
      files.set(launcher, { ...launchEntry, role: 'fabric-launcher', jarEntriesSha256: semantic });
      const entries = await archive(local, () => true);
      // Legacy shaded launchers require a separately implemented and tested proof.
      assert.equal(entries.size, 2, 'Only modern unshaded Fabric launcher output is verified');
      const mf = entries.get('META-INF/MANIFEST.MF')?.bytes,
        launch = entries.get('fabric-server-launch.properties')?.bytes;
      assert(mf && launch, 'Fabric launch output missing');
      const main = manifest(mf),
        launchProperties = parseMinecraftProperties(launch.toString('utf8'));
      assert.equal(launchProperties['launch.mainClass'], text(profile.mainClass));
      const classpath = text(main['Class-Path']).split(' ');
      assert.equal(new Set(classpath).size, classpath.length);
      const libraries = array(profile.libraries).map(object);
      const expectedPaths = libraries.map((library) => `libraries/${maven(text(library.name))}`);
      assert.deepEqual(
        [...classpath].sort(),
        [...expectedPaths].sort(),
        'Fabric launch classpath mismatch',
      );
      let loaderMain: string | undefined;
      for (const library of libraries) {
        const relative = maven(text(library.name));
        const installed = `libraries/${relative}`;
        const libraryUrl = trustedMinecraftArtifactUrl(new URL(relative, text(library.url)).href);
        const expected = {
          sha256:
            typeof library.sha256 === 'string'
              ? library.sha256
              : Buffer.from(await document(`${libraryUrl}.sha256`))
                  .toString('utf8')
                  .trim(),
          ...(typeof library.size === 'number' ? { size: library.size } : {}),
        };
        const isLoader = library.name === `net.fabricmc:fabric-loader:${runtime.loaderVersion}`;
        const localLibrary = isLoader ? join(work, 'fabric-loader.jar') : undefined;
        await read(installed, {
          expected,
          immutable: true,
          ...(localLibrary ? { local: localLibrary } : {}),
        });
        if (localLibrary) {
          const manifestBytes = (
            await archive(localLibrary, (name) => name === 'META-INF/MANIFEST.MF')
          ).get('META-INF/MANIFEST.MF')?.bytes;
          assert(manifestBytes);
          loaderMain = manifest(manifestBytes)['Main-Class'];
        }
      }
      assert(
        loaderMain && main['Main-Class'] === loaderMain,
        'Fabric loader launch entrypoint mismatch',
      );
      await options.assertOwned();
      const configEntries = (await options.adapter.listFiles(options.identifier, '')).filter(
        (entry) => entry.name === 'fabric-server-launcher.properties',
      );
      assert(configEntries.length <= 1, 'Ambiguous Fabric launch configuration');
      const launchConfig = configEntries.length
        ? parseMinecraftProperties(
            (
              await read('fabric-server-launcher.properties', { collect: MAX_METADATA })
            ).bytes.toString('utf8'),
          )
        : {};
      assert(
        Object.keys(launchConfig).every((key) => key === 'serverJar'),
        'Unsupported Fabric launcher properties',
      );
      // Official FabricServerLauncher.getServerJarPath() uses this default and
      // materializes the properties file on first boot. It is not a host path.
      const vanilla = path(text(launchConfig.serverJar ?? 'server.jar'));
      assert.notEqual(vanilla, launcher, 'Fabric launcher cannot substitute for vanilla server');
      artifactSha256 = (await read(vanilla, { expected: serverArtifact, immutable: true })).sha256;
      files.set(launcher, {
        ...(files.get(launcher) as MinecraftInstalledFile),
        minecraftServerPath: vanilla,
      });
    } else {
      assert(runtime.profile === 'forge' && runtime.loaderVersion, 'Exact Forge loader required');
      const installer = runtime.artifacts.find((artifact) => artifact.role === 'installer');
      assert(installer, 'Missing trusted Forge installer');
      const local = join(work, 'forge-installer.jar');
      await officialArtifact(installer, local);
      const embedded = await archive(
        local,
        (name) =>
          name === 'install_profile.json' ||
          name === 'version.json' ||
          name.startsWith('data/') ||
          name.startsWith('maven/'),
      );
      const profileBytes = embedded.get('install_profile.json')?.bytes;
      assert(profileBytes, 'Forge install profile missing');
      const profile = object(JSON.parse(profileBytes.toString('utf8')));
      assert.equal(profile.minecraft, runtime.release);
      assert.equal(
        profile.version,
        `${runtime.release}-forge-${runtime.loaderVersion}`,
        'Forge loader identity mismatch',
      );
      const versionPath = text(profile.json).replace(/^\//, '');
      const versionBytes = embedded.get(path(versionPath))?.bytes;
      assert(versionBytes, 'Forge version metadata missing');
      const version = object(JSON.parse(versionBytes.toString('utf8')));
      assert.equal(version.id, profile.version);
      const data = object(profile.data);
      const expand = (value: string, depth = 0): string => {
        assert(depth < 20, 'Cyclic Forge data reference');
        if (value.startsWith('[') && value.endsWith(']'))
          return `libraries/${maven(value.slice(1, -1))}`;
        if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
        return value
          .replace(/\{([A-Z0-9_]+)\}/g, (_, key: string) => {
            const known: Record<string, string> = {
              ROOT: '__root__',
              LIBRARY_DIR: '__root__/libraries',
              MINECRAFT_VERSION: runtime.release,
              SIDE: 'server',
            };
            if (key in known) return known[key] as string;
            return expand(text(object(data[key]).server), depth + 1);
          })
          .replace(/^__root__\//, '');
      };
      const expected = new Map<string, { sha1?: string; sha256?: string; size?: number }>();
      const add = (name: string, hash: { sha1?: string; sha256?: string; size?: number }) => {
        name = path(name);
        const prior = expected.get(name);
        if (prior)
          for (const key of ['sha1', 'sha256', 'size'] as const)
            if (prior[key] !== undefined && hash[key] !== undefined)
              assert.equal(prior[key], hash[key], 'Conflicting Forge output metadata');
        expected.set(name, { ...prior, ...hash });
      };
      for (const processorInput of array(profile.processors)) {
        const processor = object(processorInput);
        if (processor.sides && !array(processor.sides).includes('server')) continue;
        if (processor.outputs)
          for (const [name, hash] of Object.entries(object(processor.outputs)))
            add(expand(name), { sha1: expand(text(hash)) });
        const args = array(processor.args).map(text);
        for (let i = 0; i < args.length; i++) {
          if (args[i] !== '--from') continue;
          assert(
            args[i + 1] && args[i + 2] === '--to' && args[i + 3],
            'Unsupported Forge extraction metadata',
          );
          const source = embedded.get(path(args[i + 1] as string));
          assert(source, 'Forge embedded output missing');
          add(expand(args[i + 3] as string), { sha256: source.sha256, size: source.size });
        }
      }
      assert(expected.size > 0, 'Forge generated output proof absent');
      for (const libraryInput of [...array(profile.libraries), ...array(version.libraries)]) {
        const library = object(libraryInput),
          download = library.downloads ? object(object(library.downloads).artifact) : undefined;
        if (!download || typeof download.path !== 'string') continue;
        // Forge's common launcher metadata also names client-generated outputs
        // with an empty URL. The server installer skips these; selected server
        // processor outputs were already independently required above.
        if (download.url === '') continue;
        if (typeof download.sha1 === 'string' && download.sha1)
          add(`libraries/${path(download.path)}`, {
            sha1: download.sha1,
            ...(typeof download.size === 'number' ? { size: download.size } : {}),
          });
      }
      if (profile.path) {
        const coordinate = maven(text(profile.path));
        const source = embedded.get(`maven/${coordinate}`);
        assert(source, 'Forge shim missing from trusted installer');
        add(basename(coordinate), { sha256: source.sha256, size: source.size });
      }
      const vanilla = path(
        expand(
          typeof profile.serverJarPath === 'string'
            ? profile.serverJarPath
            : '{ROOT}/minecraft_server.{MINECRAFT_VERSION}.jar',
        ),
      );
      const localVanilla = join(work, 'forge-vanilla.jar');
      artifactSha256 = (
        await read(vanilla, { expected: serverArtifact, local: localVanilla, immutable: true })
      ).sha256;
      const bundled = await archive(localVanilla, (name) => name === 'META-INF/libraries.list');
      const bundledLibraries = bundled.get('META-INF/libraries.list')?.bytes;
      if (bundledLibraries)
        for (const line of bundledLibraries.toString('utf8').trim().split('\n')) {
          const parts = line.split('\t');
          assert(parts.length === 3 && parts[0] && parts[2], 'Malformed Mojang bundle inventory');
          add(`libraries/${path(parts[2])}`, { sha256: parts[0] });
        }
      for (const [name, hash] of expected) await read(name, { expected: hash, immutable: true });
    }
    if (!observeWorld) {
      await options.assertOwned();
      return {
        artifactSha256,
        installedFiles: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
        sources,
      };
    }
    const properties = await read('server.properties', { collect: MAX_METADATA });
    const parsed = parseMinecraftProperties(properties.bytes.toString('utf8'));
    const world = minecraftWorldName(text(parsed['level-name']));
    const level = await read(`${world}/level.dat`, { collect: 8 * MAX_METADATA });
    const observedWorld = inspectMinecraftLevelDat(level.bytes, { release: runtime.release });
    await options.assertOwned();
    return {
      artifactSha256,
      installedFiles: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
      supportedProperties: Object.keys(parsed).sort(),
      worldDataVersion: observedWorld.dataVersion,
      observations: { propertiesSha256: properties.sha256, levelDatSha256: level.sha256, sources },
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
