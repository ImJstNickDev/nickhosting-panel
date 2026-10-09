import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MinecraftRuntimeMapping,
  ResolvedMinecraftRuntime,
} from '../games/minecraft/src/runtime.js';
import type { ServerFile } from '../packages/pterodactyl-adapter/src/index.js';
import {
  captureMinecraftInstallation,
  type MinecraftInstallationOptions,
  verifyMinecraftInstallationArtifacts,
} from './m4-live-installation.js';

const require = createRequire(new URL('../games/minecraft/package.json', import.meta.url));
const { ZipFile } = require('yazl') as {
  ZipFile: new () => {
    addBuffer(buffer: Buffer, path: string, options?: { compress?: boolean }): void;
    end(): void;
    outputStream: Readable;
  };
};
const hash = (bytes: Uint8Array, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest('hex');
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function zip(entries: Record<string, Buffer | string>) {
  const result = new ZipFile();
  for (const [name, bytes] of Object.entries(entries))
    result.addBuffer(Buffer.from(bytes), name, { compress: false });
  result.end();
  const chunks: Buffer[] = [];
  for await (const chunk of result.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function level() {
  const tag = (type: number, name: string, data: Buffer) => {
    const n = Buffer.from(name),
      length = Buffer.alloc(2);
    length.writeUInt16BE(n.length);
    return Buffer.concat([Buffer.from([type]), length, n, data]);
  };
  const version = Buffer.alloc(4);
  version.writeInt32BE(3955);
  const release = Buffer.from('1.21.1'),
    length = Buffer.alloc(2);
  length.writeUInt16BE(release.length);
  return gzipSync(
    tag(
      10,
      '',
      Buffer.concat([
        tag(
          10,
          'Data',
          Buffer.concat([
            tag(3, 'DataVersion', version),
            tag(
              10,
              'Version',
              Buffer.concat([
                tag(3, 'Id', version),
                tag(8, 'Name', Buffer.concat([length, release])),
                Buffer.from([0]),
              ]),
            ),
            Buffer.from([0]),
          ]),
        ),
        Buffer.from([0]),
      ]),
    ),
  );
}
async function fixture(profile: ResolvedMinecraftRuntime['profile']) {
  const parent = await mkdtemp(join(tmpdir(), 'nh-installation-'));
  temporary.push(parent);
  const workDirectory = join(parent, 'mountdata', 'test-assets', 'run');
  await mkdir(workDirectory, { recursive: true });
  const files: Record<string, Buffer> = {
    'server.properties': Buffer.from('level-name=world\nmax-players=20\nwhite-list=false\n'),
    'world/level.dat': level(),
  };
  const runtime: ResolvedMinecraftRuntime = {
    profile,
    release: '1.21.1',
    releaseType: 'release',
    javaMajor: 21,
    artifacts: [],
    installation: { kind: 'server-jar', args: [] },
    evidence: [],
    ...(['paper', 'folia'].includes(profile) ? { buildId: 123 } : {}),
  };
  const binding: MinecraftRuntimeMapping = {
    profile,
    release: runtime.release,
    image: 'fixture/image:21',
    imageJavaMajor: 21,
    declaredEggVariables: ['VERSION', 'BUILD', 'LOADER', 'INSTALLER'],
    bindings: {
      release: 'VERSION',
      ...(['paper', 'folia'].includes(profile) ? { buildId: 'BUILD' } : {}),
    },
    fixedVariables: {},
    installationKind: 'server-jar',
    artifactPaths: { server: 'server.jar' },
    supportedProperties: [],
  };
  const vanilla = await zip({ 'version.json': JSON.stringify({ id: '1.21.1' }) });
  files['server.jar'] = vanilla;
  const urls = new Map<string, Buffer>();
  const set = (key: string, value: unknown) =>
    urls.set(key, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  const serverArtifact = {
    role: 'server' as const,
    url: 'https://piston-data.mojang.com/server.jar',
    sha1: hash(vanilla, 'sha1'),
    size: vanilla.length,
  };
  let selectedRuntime: ResolvedMinecraftRuntime = { ...runtime, artifacts: [serverArtifact] };
  let selectedBinding = binding;
  if (profile === 'fabric') {
    const loader = '0.18.4';
    const loaderPath = `net/fabricmc/fabric-loader/${loader}/fabric-loader-${loader}.jar`;
    const main = 'net.fabricmc.loader.impl.launch.server.FabricServerLauncher';
    const loaderJar = await zip({
      'META-INF/MANIFEST.MF': `Manifest-Version: 1.0\r\nMain-Class: ${main}\r\n\r\n`,
    });
    files[`libraries/${loaderPath}`] = loaderJar;
    files['minecraft-server.jar'] = vanilla;
    files['server.jar'] = await zip({
      'META-INF/MANIFEST.MF': `Manifest-Version: 1.0\r\nMain-Class: ${main}\r\nClass-Path: libraries/${loaderPath}\r\n\r\n`,
      'fabric-server-launch.properties':
        'launch.mainClass=net.fabricmc.loader.impl.launch.knot.KnotServer\n',
    });
    files['fabric-server-launcher.properties'] = Buffer.from('serverJar=minecraft-server.jar\n');
    set(`https://meta.fabricmc.net/v2/versions/loader/1.21.1/${loader}/server/json`, {
      id: `fabric-loader-${loader}-1.21.1`,
      inheritsFrom: '1.21.1',
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotServer',
      libraries: [
        {
          name: `net.fabricmc:fabric-loader:${loader}`,
          url: 'https://maven.fabricmc.net/',
          sha256: hash(loaderJar),
          size: loaderJar.length,
        },
      ],
    });
    selectedRuntime = {
      ...selectedRuntime,
      loaderVersion: loader,
      installerVersion: '1.1.2',
      installation: { kind: 'fabric-installer', args: [] },
    };
    selectedBinding = {
      ...binding,
      installationKind: 'fabric-installer',
      bindings: { release: 'VERSION', loaderVersion: 'LOADER', installerVersion: 'INSTALLER' },
    };
  }
  if (profile === 'forge') {
    const version = '1.21.1-52.1.13',
      coordinate = `net.minecraftforge:forge:${version}:server`,
      generated = Buffer.from('genuine generated Forge server'),
      args = Buffer.from('--launchTarget forge_server\n'),
      lib = Buffer.from('verified library'),
      shim = Buffer.from('official embedded Forge shim');
    files[`libraries/net/minecraftforge/forge/${version}/forge-${version}-server.jar`] = generated;
    files[`libraries/net/minecraftforge/forge/${version}/unix_args.txt`] = args;
    files['libraries/test/library/1/library-1.jar'] = lib;
    files['libraries/net/minecraft/server/1.21.1/server-1.21.1-bundled.jar'] = vanilla;
    files[`forge-${version}-shim.jar`] = shim;
    delete files['server.jar'];
    const install = {
      spec: 1,
      minecraft: '1.21.1',
      version: '1.21.1-forge-52.1.13',
      json: '/version.json',
      path: `net.minecraftforge:forge:${version}:shim`,
      serverJarPath:
        '{LIBRARY_DIR}/net/minecraft/server/{MINECRAFT_VERSION}/server-{MINECRAFT_VERSION}-bundled.jar',
      data: {
        PATCHED: { server: `[${coordinate}]` },
        PATCHED_SHA: { server: `'${hash(generated, 'sha1')}'` },
      },
      libraries: [],
      processors: [
        { sides: ['server'], args: ['--task', 'PATCH'], outputs: { '{PATCHED}': '{PATCHED_SHA}' } },
        {
          sides: ['server'],
          args: [
            '--task',
            'EXTRACT_FILES',
            '--from',
            'data/unix_args.txt',
            '--to',
            `{ROOT}/libraries/net/minecraftforge/forge/${version}/unix_args.txt`,
          ],
        },
      ],
    };
    const installer = await zip({
      'install_profile.json': JSON.stringify(install),
      'version.json': JSON.stringify({
        id: install.version,
        libraries: [
          {
            downloads: {
              artifact: {
                path: 'test/library/1/library-1.jar',
                url: 'https://maven.minecraftforge.net/test/library/1/library-1.jar',
                sha1: hash(lib, 'sha1'),
                size: lib.length,
              },
            },
          },
          {
            name: `net.minecraftforge:forge:${version}:client`,
            downloads: {
              artifact: {
                path: `net/minecraftforge/forge/${version}/forge-${version}-client.jar`,
                url: '',
                sha1: 'e'.repeat(40),
                size: 123,
              },
            },
          },
        ],
      }),
      'data/unix_args.txt': args,
      [`maven/net/minecraftforge/forge/${version}/forge-${version}-shim.jar`]: shim,
    });
    urls.set('https://maven.minecraftforge.net/installer.jar', installer);
    selectedRuntime = {
      ...selectedRuntime,
      loaderVersion: '52.1.13',
      artifacts: [
        serverArtifact,
        {
          role: 'installer',
          url: 'https://maven.minecraftforge.net/installer.jar',
          sha1: hash(installer, 'sha1'),
          size: installer.length,
        },
      ],
      installation: { kind: 'forge-installer', args: [] },
    };
    selectedBinding = {
      ...binding,
      installationKind: 'forge-installer',
      bindings: { release: 'VERSION', loaderVersion: 'LOADER' },
    };
  }
  const assertOwned = vi.fn(async () => {});
  const adapter = {
    listFiles: vi.fn(async (_id: string, directory = '') => {
      const prefix = directory ? `${directory}/` : '';
      const found = new Map<string, ServerFile>();
      for (const [name, bytes] of Object.entries(files)) {
        if (!name.startsWith(prefix)) continue;
        const suffix = name.slice(prefix.length),
          child = suffix.split('/')[0];
        if (!child) continue;
        const isFile = !suffix.includes('/');
        found.set(child, {
          name: child,
          is_file: isFile,
          is_symlink: false,
          mode: isFile ? '-rw-r--r--' : 'drwxr-xr-x',
          size: isFile ? bytes.length : 0,
          mimetype: isFile ? 'application/octet-stream' : 'inode/directory',
          created_at: '2026-01-01',
          modified_at: '2026-01-01',
        });
      }
      return [...found.values()];
    }),
    downloadFile: vi.fn(async (_id: string, name: string) => {
      const bytes = files[name];
      if (!bytes) throw Error('file absent');
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 17)
              controller.enqueue(bytes.subarray(i, i + 17));
            controller.close();
          },
        }),
        contentType: 'application/octet-stream' as const,
      };
    }),
  };
  const options: MinecraftInstallationOptions = {
    adapter,
    identifier: 'fixture1',
    runtime: selectedRuntime,
    binding: selectedBinding,
    assertOwned,
    workDirectory,
    userAgent: 'NickHosting test https://example.test',
    metadata: {
      read: async (url) => {
        const bytes = urls.get(url);
        if (!bytes) throw Error(`Unexpected metadata: ${url}`);
        return {
          bytes,
          evidence: { url, sha256: hash(bytes), retrievedAt: new Date().toISOString() },
        };
      },
    },
    fetch: (async (input) => {
      const bytes = urls.get(String(input));
      if (!bytes) throw Error('Unexpected artifact URL');
      return new Response(new Uint8Array(bytes));
    }) as typeof fetch,
  };
  return { options, files, urls, adapter, assertOwned };
}
describe('read-only M4 installed runtime capture', () => {
  it.each(['vanilla', 'paper', 'folia', 'fabric', 'forge'] as const)(
    'proves exact %s artifacts before start and captures real generated metadata afterward',
    async (profile) => {
      const f = await fixture(profile);
      const early = await verifyMinecraftInstallationArtifacts(f.options);
      expect(early.installedFiles.length).toBeGreaterThan(0);
      expect('worldDataVersion' in early).toBe(false);
      const report = await captureMinecraftInstallation(f.options);
      expect(report.worldDataVersion).toBe(3955);
      expect(report.supportedProperties).toEqual(['level-name', 'max-players', 'white-list']);
      expect(
        report.installedFiles.some(
          (file) => file.path.startsWith('world/') || file.path === 'server.properties',
        ),
      ).toBe(false);
      expect(f.assertOwned).toHaveBeenCalled();
      expect(await readdir(f.options.workDirectory)).toEqual([]);
      if (profile === 'fabric')
        expect(report.installedFiles.find((file) => file.path === 'server.jar')).toMatchObject({
          role: 'fabric-launcher',
          minecraftServerPath: 'minecraft-server.jar',
          jarEntriesSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
    },
  );
  it('uses the verified official default before Fabric first writes its launch properties', async () => {
    const f = await fixture('fabric');
    f.files['fabric-server-launch.jar'] = f.files['server.jar'] as Buffer;
    f.files['server.jar'] = f.files['minecraft-server.jar'] as Buffer;
    delete f.files['minecraft-server.jar'];
    delete f.files['fabric-server-launcher.properties'];
    f.options.binding = {
      ...f.options.binding,
      artifactPaths: { server: 'fabric-server-launch.jar' },
    };
    const report = await verifyMinecraftInstallationArtifacts(f.options);
    expect(report.installedFiles.find((file) => file.role === 'fabric-launcher')).toMatchObject({
      minecraftServerPath: 'server.jar',
    });
    expect(report.installedFiles.some((file) => file.path === 'server.jar')).toBe(true);
  });
  it('rejects mismatched downloaded server bytes and leaves the remote files intact', async () => {
    const f = await fixture('paper');
    f.files['server.jar'] = Buffer.from('different build');
    await expect(captureMinecraftInstallation(f.options)).rejects.toThrow('mismatch');
    expect(f.files['server.jar']?.toString()).toBe('different build');
    expect(await readdir(f.options.workDirectory)).toEqual([]);
  });
  it('rejects symlink parents before downloading a library', async () => {
    const f = await fixture('fabric');
    const original = f.adapter.listFiles.getMockImplementation();
    f.adapter.listFiles.mockImplementation(async (id, directory) => {
      const list = (await original?.(id, directory)) ?? [];
      return list.map((row) => (row.name === 'libraries' ? { ...row, is_symlink: true } : row));
    });
    await expect(captureMinecraftInstallation(f.options)).rejects.toThrow('Symlink');
    expect(
      f.adapter.downloadFile.mock.calls.some(([, path]) => path.startsWith('libraries/')),
    ).toBe(false);
  });
  it('requires Forge generated output integrity, not merely a genuine installer', async () => {
    const f = await fixture('forge');
    const target = Object.keys(f.files).find((path) => path.endsWith('-server.jar'));
    expect(target).toBeTruthy();
    delete f.files[target as string];
    await expect(captureMinecraftInstallation(f.options)).rejects.toThrow('absent');
  });
  it('proves modern Forge outputs with the installer deleted and no root server.jar or trusted alias', async () => {
    const f = await fixture('forge');
    const original = f.adapter.listFiles.getMockImplementation();
    f.adapter.listFiles.mockImplementation(async (id, directory) => {
      const list = (await original?.(id, directory)) ?? [];
      if (!directory)
        list.push({
          name: 'unix_args.txt',
          is_file: true,
          is_symlink: true,
          mode: 'lrwxrwxrwx',
          size: 80,
          mimetype: 'inode/symlink',
          created_at: '2026-01-01',
          modified_at: '2026-01-01',
        });
      return list;
    });
    expect(f.files['installer.jar']).toBeUndefined();
    expect(f.files['server.jar']).toBeUndefined();
    const report = await verifyMinecraftInstallationArtifacts(f.options);
    const paths = report.installedFiles.map((file) => file.path);
    expect(paths).toContain('libraries/net/minecraft/server/1.21.1/server-1.21.1-bundled.jar');
    expect(paths).toContain('libraries/net/minecraftforge/forge/1.21.1-52.1.13/unix_args.txt');
    expect(paths).toContain('forge-1.21.1-52.1.13-shim.jar');
    expect(paths).not.toContain('unix_args.txt');
    expect(paths.some((path) => path.endsWith('-client.jar'))).toBe(false);
    expect(
      f.adapter.downloadFile.mock.calls.some(([, path]) =>
        ['installer.jar', 'server.jar', 'unix_args.txt'].includes(path),
      ),
    ).toBe(false);
    f.files['libraries/net/minecraftforge/forge/1.21.1-52.1.13/unix_args.txt'] = Buffer.from(
      'modified launch arguments',
    );
    await expect(verifyMinecraftInstallationArtifacts(f.options)).rejects.toThrow('mismatch');
  });
  it('refuses lost provenance and never returns partial evidence', async () => {
    const f = await fixture('vanilla');
    f.assertOwned.mockRejectedValueOnce(new Error('ownership mismatch'));
    await expect(captureMinecraftInstallation(f.options)).rejects.toThrow('ownership');
    expect(f.adapter.downloadFile).not.toHaveBeenCalled();
  });
});
