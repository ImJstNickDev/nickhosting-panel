import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { assertModpackPaths, modpackDataPath } from './modpack-paths.js';
import type { ModpackDownload, ModpackRecipe } from './modpack-recipes.js';
import { type ModpackStagingOptions, stageModpackRecipe } from './modpack-staging.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const digest = (data: Buffer, algo = 'sha256') => createHash(algo).update(data).digest('hex');
async function zip(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const value = new ZipFile();
  const chunks: Buffer[] = [];
  value.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    value.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    value.outputStream.on('error', reject);
    value.on('error', reject);
  });
  for (const [path, data] of Object.entries(entries))
    value.addBuffer(Buffer.from(data), path, { compress: false });
  value.end();
  return done;
}
function source(name: string, data?: Buffer): ModpackDownload {
  return {
    filename: name,
    urls: [`https://fixture.example/${name}`],
    hashes: data ? { sha256: digest(data) } : {},
    ...(data ? { size: data.length } : {}),
  };
}
const target = { minecraftVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.10' } as const;
const identity = {
  provider: 'modrinth' as const,
  project: {
    provider: 'modrinth' as const,
    id: 'pack',
    name: 'Pack',
    summary: '',
    websiteUrl: 'https://fixture.example/pack',
    authors: [],
    description: '',
    descriptionFormat: 'text' as const,
  },
  version: {
    id: 'v1',
    projectId: 'pack',
    name: 'Pack 1',
    version: '1',
    minecraftVersions: ['1.21.1'],
    loaders: ['fabric'],
    channel: 'release' as const,
    available: true,
    source: 'modrinth-index' as const,
  },
};
const mr = (files: unknown[] = []) => ({
  formatVersion: 1,
  game: 'minecraft',
  dependencies: { minecraft: target.minecraftVersion, 'fabric-loader': target.loaderVersion },
  files,
});
const cf = (files: unknown[] = []) => ({
  manifestType: 'minecraftModpack',
  manifestVersion: 1,
  minecraft: {
    version: target.minecraftVersion,
    modLoaders: [{ id: `fabric-${target.loaderVersion}`, primary: true }],
  },
  overrides: 'overrides',
  files,
});
function mrFile(path: string, name: string, data: Buffer, server = 'required') {
  return {
    path,
    fileSize: data.length,
    downloads: [`https://fixture.example/${name}`],
    hashes: { sha1: digest(data, 'sha1'), sha512: digest(data, 'sha512') },
    env: { server },
  };
}
async function fixture(data: Record<string, Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'nh-modpack-stage-'));
  roots.push(root);
  const download = vi.fn(
    async (
      input: ModpackDownload,
      destination: string,
      signal?: AbortSignal,
      options?: Parameters<ModpackStagingOptions['download']>[3],
    ) => {
      signal?.throwIfAborted();
      const bytes = data[new URL(input.urls[0] as string).pathname.slice(1)];
      if (!bytes) throw new Error('unexpected download');
      for (const [algo, expected] of Object.entries(input.hashes))
        if (digest(bytes, algo) !== expected) throw new Error('hash mismatch');
      await options?.onSize(bytes.length);
      signal?.throwIfAborted();
      await writeFile(destination, bytes, { flag: 'wx' });
      return { size: bytes.length, sha256: digest(bytes) };
    },
  );
  const reserve = vi.fn(async (_bytes: number) => {});
  const progress = vi.fn(
    async (_event: Parameters<NonNullable<ModpackStagingOptions['progress']>>[0]) => {},
  );
  const checkTarget = vi.fn(async (_value: unknown) => {});
  const options: ModpackStagingOptions = {
    directory: join(root, 'attempt'),
    download,
    reserve,
    progress,
    checkTarget,
  };
  return { root, options, download, reserve, progress, checkTarget };
}
function archive(
  format: 'modrinth-index' | 'curseforge-manifest' | 'server-archive',
  data: Buffer,
  extra = {},
): ModpackRecipe {
  return { ...identity, kind: 'archive', format, download: source('source.zip', data), ...extra };
}

describe('modpack server data paths', () => {
  it('accepts game scripts but excludes launchers/runtime and panel secrets', () => {
    expect(modpackDataPath('kubejs/server_scripts/example.js')).toBe(
      'kubejs/server_scripts/example.js',
    );
    expect(modpackDataPath('scripts/recipes.zs')).toBe('scripts/recipes.zs');
    for (const path of [
      'start.sh',
      'server.jar',
      'fabric-server-launcher.properties',
      'libraries/a.jar',
      'ops.json',
      '.nickhosting/secret',
    ])
      expect(modpackDataPath(path)).toBeNull();
  });
  it.each(['../escape.txt', '/escape.txt', 'config/../escape', 'config\\bad', 'config/a\0b'])(
    'rejects unsafe path %s',
    (path) => {
      expect(() => modpackDataPath(path)).toThrow();
    },
  );
  it('rejects duplicate, case-folded and file/parent collisions', () => {
    for (const paths of [
      ['config/a', 'config/a'],
      ['config/a', 'Config/b'],
      ['config/a', 'config/a/b'],
    ])
      expect(() => assertModpackPaths(paths)).toThrow();
  });
});

describe('modpack staging', () => {
  it('admits two unknown-size server downloads alongside archive configs without reserving each maximum', async () => {
    const first = await zip({ 'fabric.mod.json': JSON.stringify({ environment: 'server' }) });
    const second = await zip({ 'fabric.mod.json': JSON.stringify({ environment: '*' }) });
    const config = 'configuration';
    const data = await zip({ 'config/a.txt': config });
    const budget = first.length + second.length + config.length;
    const f = await fixture({ 'source.zip': data, 'first.jar': first, 'second.jar': second });
    const original = f.options.download;
    const result = await stageModpackRecipe(
      archive('server-archive', data, {
        target,
        preserveRoot: true,
        files: ['first', 'second'].map((name) => ({
          path: `mods/${name}.jar`,
          download: source(`${name}.jar`),
          serverSide: 'required',
        })),
      }),
      {
        ...f.options,
        limits: { maxFileBytes: budget, maxExpandedBytes: budget },
        download: async (input, destination, signal, options) => {
          if (options) {
            expect(options.maxBytes).toBe(
              input.filename === 'first.jar' ? budget - config.length : second.length,
            );
            const admit = options.onSize;
            options = {
              ...options,
              onSize: async (size) => {
                await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
                await admit(size);
              },
            };
          }
          return original(input, destination, signal, options);
        },
      },
    );
    expect(result.files.map((file) => file.path)).toEqual([
      'config/a.txt',
      'mods/first.jar',
      'mods/second.jar',
    ]);
    expect(f.download.mock.calls.map(([input]) => input.filename)).toEqual([
      'source.zip',
      'first.jar',
      'second.jar',
    ]);
    expect(f.reserve.mock.calls.map(([bytes]) => bytes)).toEqual([
      data.length,
      data.length + config.length,
      data.length + config.length + first.length,
      data.length + budget,
    ]);
    expect(f.progress.mock.calls[0]?.[0].totalBytes).toBeNull();
    expect(f.progress.mock.calls[1]?.[0].totalBytes).toBeNull();
    expect(f.progress.mock.calls.at(-1)?.[0].totalBytes).toBe(budget);
  });
  it('releases an absent-header allowance before the next unknown transfer', async () => {
    const f = await fixture({});
    const recipe: ModpackRecipe = {
      ...identity,
      kind: 'files',
      target,
      files: ['a', 'b'].map((name) => ({
        path: `config/${name}.txt`,
        download: source(`${name}.txt`),
        serverSide: 'required',
      })),
      warnings: [],
    };
    const result = await stageModpackRecipe(recipe, {
      ...f.options,
      limits: { maxFileBytes: 10, maxExpandedBytes: 10 },
      download: async (_input, destination, signal, options) => {
        if (!options) throw new Error('Missing admission');
        await options.onSize(options.maxBytes);
        signal?.throwIfAborted();
        await writeFile(destination, 'data', { flag: 'wx' });
        return { size: 4, sha256: digest(Buffer.from('data')) };
      },
    });
    expect(result.files).toHaveLength(2);
    expect(f.reserve.mock.calls.map(([bytes]) => bytes)).toEqual([0, 10, 4, 10, 8]);
  });
  it('refuses unknown-size admission beyond the remaining budget before writing', async () => {
    const f = await fixture({ 'a.txt': Buffer.from('four'), 'b.txt': Buffer.from('four') });
    const recipe: ModpackRecipe = {
      ...identity,
      kind: 'files',
      target,
      files: ['a', 'b'].map((name) => ({
        path: `config/${name}.txt`,
        download: source(`${name}.txt`),
        serverSide: 'required',
      })),
      warnings: [],
    };
    await expect(
      stageModpackRecipe(recipe, {
        ...f.options,
        limits: { maxFileBytes: 6, maxExpandedBytes: 6 },
      }),
    ).rejects.toMatchObject({ details: { contentReason: 'stage_budget' } });
    expect(f.reserve.mock.calls.map(([bytes]) => bytes)).toEqual([0, 4]);
    await expect(readFile(join(f.options.directory, 'files/config/b.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('stops unknown downloads before disk writes when quota reservation cancels', async () => {
    const f = await fixture({ 'a.txt': Buffer.from('data'), 'b.txt': Buffer.from('data') });
    const controller = new AbortController();
    const recipe: ModpackRecipe = {
      ...identity,
      kind: 'files',
      target,
      files: ['a', 'b'].map((name) => ({
        path: `config/${name}.txt`,
        download: source(`${name}.txt`),
        serverSide: 'required',
      })),
      warnings: [],
    };
    await expect(
      stageModpackRecipe(recipe, {
        ...f.options,
        signal: controller.signal,
        reserve: async (bytes) => {
          if (bytes > 0) controller.abort(new Error('cancelled'));
        },
      }),
    ).rejects.toThrow('cancelled');
    expect(f.download).toHaveBeenCalledTimes(1);
    await expect(readFile(join(f.options.directory, 'files/config/a.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('combines a server-relative configuration archive with explicit server downloads', async () => {
    const mod = await zip({
      'fabric.mod.json': JSON.stringify({ id: 'servermod', environment: 'server' }),
    });
    const data = await zip({ 'custom/config/a.txt': 'server configuration' });
    const f = await fixture({ 'source.zip': data, 'mod.jar': mod });
    const result = await stageModpackRecipe(
      archive('server-archive', data, {
        target,
        preserveRoot: true,
        files: [
          { path: 'mods/servermod.jar', download: source('mod.jar', mod), serverSide: 'required' },
        ],
      }),
      f.options,
    );
    expect(result.target).toEqual(target);
    expect(result.files.map((file) => file.path)).toEqual([
      'custom/config/a.txt',
      'mods/servermod.jar',
    ]);
    expect(await readFile(join(result.directory, 'custom/config/a.txt'), 'utf8')).toBe(
      'server configuration',
    );
    expect(f.download).toHaveBeenCalledTimes(2);
    expect(f.checkTarget).toHaveBeenCalledTimes(1);
  });
  it('layers server overrides after common overrides, skips client content and hashes once during extraction', async () => {
    const downloaded = Buffer.from('downloaded');
    const client = Buffer.from('client');
    const data = await zip({
      'modrinth.index.json': JSON.stringify(
        mr([
          mrFile('config/common.txt', 'replaced.txt', downloaded),
          mrFile('config/remote.txt', 'remote.txt', downloaded),
          mrFile('mods/client.jar', 'client.jar', client, 'unsupported'),
        ]),
      ),
      'overrides/config/common.txt': 'common',
      'server-overrides/config/common.txt': 'server',
      'server-overrides/kubejs/server_scripts/test.js': 'ServerEvents.recipes(() => {});',
      'client-overrides/config/client.txt': 'client',
      'overrides/start.sh': 'do not execute',
    });
    const f = await fixture({ 'source.zip': data, 'remote.txt': downloaded });
    const result = await stageModpackRecipe(archive('modrinth-index', data), f.options);
    expect(result.target).toEqual(target);
    expect(result.files.map((x) => x.path)).toEqual([
      'config/common.txt',
      'config/remote.txt',
      'kubejs/server_scripts/test.js',
    ]);
    expect(await readFile(join(result.directory, 'config/common.txt'), 'utf8')).toBe('server');
    expect(result.files.find((x) => x.path === 'config/common.txt')?.sha256).toBe(
      digest(Buffer.from('server')),
    );
    expect(f.download).toHaveBeenCalledTimes(2);
    expect(f.checkTarget).toHaveBeenCalledTimes(1);
    const final = f.progress.mock.calls.at(-1)?.[0];
    expect(final).toMatchObject({
      files: 3,
      totalFiles: 3,
      bytes: result.files.reduce((n, x) => n + x.size, 0),
    });
    expect(final?.totalBytes).toBe(final?.bytes);
    expect(f.reserve.mock.calls.at(-1)?.[0]).toBe(data.length + (final?.bytes ?? 0));
  });
  it('passes exact required CurseForge pins to one bulk resolver and excludes client-only JARs', async () => {
    const server = await zip({
      'fabric.mod.json': JSON.stringify({ id: 'servermod', environment: 'server' }),
    });
    const client = await zip({
      'fabric.mod.json': JSON.stringify({ id: 'clientmod', environment: 'client' }),
    });
    const data = await zip({
      'manifest.json': JSON.stringify(
        cf([
          { projectID: 11, fileID: 101, required: true },
          { projectID: 12, fileID: 102, required: false },
        ]),
      ),
      'overrides/config/a.txt': 'x',
    });
    const f = await fixture({ 'source.zip': data, 'server.jar': server, 'client.jar': client });
    const resolve = vi.fn(async () => [
      {
        path: 'mods/server.jar',
        download: source('server.jar', server),
        serverSide: 'unknown' as const,
      },
      {
        path: 'mods/client.jar',
        download: source('client.jar', client),
        serverSide: 'unknown' as const,
      },
    ]);
    const result = await stageModpackRecipe(archive('curseforge-manifest', data), {
      ...f.options,
      resolveCurseForgeFiles: resolve,
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith([{ projectId: 11, fileId: 101 }], undefined);
    expect(result.files.map((x) => x.path)).toEqual(['config/a.txt', 'mods/server.jar']);
    expect(result.excludedFiles).toBe(2);
    expect(f.checkTarget).toHaveBeenCalledTimes(1);
  });
  it('reads exact CF companion requirements before the server archive and never installs client overrides', async () => {
    const companion = await zip({
      'manifest.json': JSON.stringify(cf()),
      'overrides/config/client.txt': 'client',
    });
    const data = await zip({ 'Server/config/a.txt': 'server', 'Server/start.sh': 'launcher' });
    const f = await fixture({ 'source.zip': data, 'client.zip': companion });
    const result = await stageModpackRecipe(
      archive('server-archive', data, {
        targetManifest: {
          format: 'curseforge-manifest',
          download: source('client.zip', companion),
        },
      }),
      f.options,
    );
    expect(result.target).toEqual(target);
    expect(result.files.map((x) => x.path)).toEqual(['config/a.txt']);
    expect(f.download.mock.calls.map(([x]) => x.filename)).toEqual(['client.zip', 'source.zip']);
    expect(f.checkTarget.mock.invocationCallOrder[0]).toBeLessThan(
      f.download.mock.invocationCallOrder[1] as number,
    );
  });
  it('recognizes a wrapped server archive manifest without stripping a real data-only root', async () => {
    const wrapped = await zip({
      'Server/manifest.json': JSON.stringify(cf()),
      'Server/config/a.txt': 'data',
    });
    const f = await fixture({ 'source.zip': wrapped });
    const result = await stageModpackRecipe(archive('server-archive', wrapped), f.options);
    expect(result.target).toEqual(target);
    expect(result.files.map((x) => x.path)).toEqual(['config/a.txt']);
    const only = await zip({ 'config/a.txt': 'data' });
    const g = await fixture({ 'source.zip': only });
    expect(
      (await stageModpackRecipe(archive('server-archive', only, { target }), g.options)).files.map(
        (x) => x.path,
      ),
    ).toEqual(['config/a.txt']);
  });
  it('blocks unresolved or conflicting target instead of selecting a different runtime', async () => {
    const data = await zip({ 'config/a.txt': 'data' });
    const f = await fixture({ 'source.zip': data });
    await expect(
      stageModpackRecipe(archive('server-archive', data), f.options),
    ).rejects.toMatchObject({ details: { contentReason: 'modpack_target_unresolved' } });
    const withTarget = await zip({ 'modrinth.index.json': JSON.stringify(mr()) });
    const g = await fixture({ 'source.zip': withTarget });
    await expect(
      stageModpackRecipe(
        archive('modrinth-index', withTarget, { target: { ...target, loaderVersion: 'wrong' } }),
        g.options,
      ),
    ).rejects.toMatchObject({ details: { contentReason: 'modpack_target_mismatch' } });
  });
  it('does not strip a custom world directory or parse unrelated config manifests', async () => {
    const data = await zip({ 'CustomMap/level.dat': 'world', 'CustomMap/region/a.mca': 'region' });
    const f = await fixture({ 'source.zip': data });
    expect(
      (await stageModpackRecipe(archive('server-archive', data, { target }), f.options)).files.map(
        (x) => x.path,
      ),
    ).toEqual(['CustomMap/level.dat', 'CustomMap/region/a.mca']);
    const other = await zip({ 'config/manifest.json': 'not JSON, just a pack data file' });
    const g = await fixture({ 'source.zip': other });
    expect(
      (await stageModpackRecipe(archive('server-archive', other, { target }), g.options)).files.map(
        (x) => x.path,
      ),
    ).toEqual(['config/manifest.json']);
  });
  it('rejects unsupported runtime immediately after the manifest, before content downloads', async () => {
    const companion = await zip({ 'manifest.json': JSON.stringify(cf()) });
    const data = await zip({ 'config/a.txt': 'data' });
    const f = await fixture({ 'source.zip': data, 'client.zip': companion });
    await expect(
      stageModpackRecipe(
        archive('server-archive', data, {
          targetManifest: {
            format: 'curseforge-manifest',
            download: source('client.zip', companion),
          },
        }),
        {
          ...f.options,
          checkTarget: async () => {
            throw new Error('runtime disabled');
          },
        },
      ),
    ).rejects.toThrow('runtime disabled');
    expect(f.download).toHaveBeenCalledTimes(1);
  });
  it('bounds concurrent downloads and serializes progress callbacks', async () => {
    const bytes = Buffer.from('x');
    const f = await fixture(
      Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`${i}.txt`, bytes])),
    );
    let active = 0,
      maximum = 0,
      reporting = false;
    const original = f.options.download;
    const recipe: ModpackRecipe = {
      ...identity,
      kind: 'files',
      target,
      files: Array.from({ length: 8 }, (_, i) => ({
        path: `config/${i}.txt`,
        download: source(`${i}.txt`, bytes),
        serverSide: 'required',
      })),
      warnings: [],
    };
    const result = await stageModpackRecipe(recipe, {
      ...f.options,
      concurrency: 3,
      download: async (...args) => {
        active++;
        maximum = Math.max(active, maximum);
        await new Promise((r) => setTimeout(r, 3));
        try {
          return await original(...args);
        } finally {
          active--;
        }
      },
      progress: async () => {
        expect(reporting).toBe(false);
        reporting = true;
        await new Promise((r) => setTimeout(r, 1));
        reporting = false;
      },
    });
    expect(result.files).toHaveLength(8);
    expect(maximum).toBe(3);
  });
  it('aborts in-flight downloads and never starts remaining queued files after failure', async () => {
    const f = await fixture({});
    const controller = new AbortController();
    let calls = 0;
    const recipe: ModpackRecipe = {
      ...identity,
      kind: 'files',
      target,
      files: Array.from({ length: 4 }, (_, i) => ({
        path: `config/${i}.txt`,
        download: source(`${i}.txt`),
        serverSide: 'required',
      })),
      warnings: [],
    };
    await expect(
      stageModpackRecipe(recipe, {
        ...f.options,
        signal: controller.signal,
        concurrency: 1,
        download: async () => {
          calls++;
          controller.abort(new Error('cancelled'));
          throw controller.signal.reason;
        },
        limits: { maxFileBytes: 1024 },
      }),
    ).rejects.toThrow('cancelled');
    expect(calls).toBe(1);
  });
  it('rejects bad download hashes, declared sizes and cumulative staging budget', async () => {
    const bytes = Buffer.from('x');
    const f = await fixture({ 'a.txt': bytes });
    const recipe: ModpackRecipe = {
      ...identity,
      kind: 'files',
      target,
      files: [
        {
          path: 'config/a.txt',
          download: { ...source('a.txt', bytes), hashes: { sha256: '0'.repeat(64) } },
          serverSide: 'required',
        },
      ],
      warnings: [],
    };
    await expect(stageModpackRecipe(recipe, f.options)).rejects.toThrow('hash mismatch');
    const g = await fixture({ 'a.txt': bytes });
    await expect(
      stageModpackRecipe(
        {
          ...recipe,
          files: [
            {
              path: 'config/a.txt',
              serverSide: 'required',
              download: { ...source('a.txt', bytes), size: 2 },
            },
          ],
        },
        g.options,
      ),
    ).rejects.toMatchObject({ details: { contentReason: 'download_size' } });
    const h = await fixture({ 'a.txt': bytes });
    await expect(
      stageModpackRecipe(recipe, {
        ...h.options,
        limits: { maxExpandedBytes: 1 },
        download: async () => ({ size: 2, sha256: digest(bytes) }),
      }),
    ).rejects.toMatchObject({ details: { contentReason: 'download_size' } });
  });
  it('rejects provider traversal, duplicate case paths and malicious archive entry names', async () => {
    const bytes = Buffer.from('x');
    for (const paths of [['../escape'], ['config/a', 'Config/a']]) {
      const f = await fixture({ 'a.txt': bytes });
      const recipe: ModpackRecipe = {
        ...identity,
        kind: 'files',
        target,
        files: paths.map((path) => ({
          path,
          download: source('a.txt', bytes),
          serverSide: 'required',
        })),
        warnings: [],
      };
      await expect(stageModpackRecipe(recipe, f.options)).rejects.toThrow();
      expect(f.download).not.toHaveBeenCalled();
    }
    const raw = await zip({ 'okay/file.txt': 'x' });
    const bad = Buffer.from(
      raw.toString('latin1').replaceAll('okay/file.txt', '../x/file.txt'),
      'latin1',
    );
    const f = await fixture({ 'source.zip': bad });
    await expect(
      stageModpackRecipe(archive('server-archive', bad, { target }), f.options),
    ).rejects.toThrow();
  });
});
