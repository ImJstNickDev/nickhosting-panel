import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { FilemanEntry, FilemanJobServices, FilemanReadService } from '@nickhosting/game-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { minecraftModpackPrepareSchema } from '../../../games/minecraft/src/modpack-contracts.js';
import { readArchiveFile, visitArchive } from '../../content-providers/src/archive.js';
import type { ContentHttp } from '../../content-providers/src/contracts.js';
import { createModpackCatalog } from '../../content-providers/src/modpack-catalog-providers.js';
import { stageModpackRecipe } from '../../content-providers/src/modpack-staging.js';
import { buildModpackTransferArchive } from '../../content-providers/src/modpack-transfer.js';
import {
  assertMinecraftModpackPlanCurrent,
  type PreparedMinecraftModpack,
  planMinecraftModpack,
} from './minecraft-modpacks-plan.js';
import { inspectModpackFiles } from './modpack-inventory.js';
import { prepareModpackProperties } from './modpack-properties.js';
import { createModpackPublication, type ModpackPublicationJournal } from './modpack-publication.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function zip(entries: Record<string, string | Buffer>) {
  const value = new ZipFile();
  const parts: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    value.outputStream.on('data', (data: Buffer) => parts.push(data));
    value.outputStream.on('end', () => resolve(Buffer.concat(parts)));
    value.outputStream.on('error', reject);
  });
  for (const [path, data] of Object.entries(entries))
    value.addBuffer(Buffer.from(data), path, { compress: false });
  value.end();
  return result;
}
/** Real local files + ZIPs and all production composition algorithms; no database or infrastructure. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nh-pack-composition-'));
  roots.push(root);
  const remote = join(root, 'remote');
  await mkdir(remote);
  const put = async (path: string, data: string | Buffer) => {
    await mkdir(dirname(join(remote, path)), { recursive: true });
    await writeFile(join(remote, path), data);
  };
  await put('server.jar', 'managed runtime');
  await put('server.properties', 'level-name=world');
  await put('world/level.dat', 'existing world');
  await put('world/region/existing.mca', 'existing region');
  await put('config/local.toml', 'owner local config');
  const jar = await zip({
    'fabric.mod.json': JSON.stringify({ id: 'fixturemod', version: '1.0', environment: '*' }),
  });
  const mrpack = await zip({
    'modrinth.index.json': JSON.stringify({
      formatVersion: 1,
      game: 'minecraft',
      dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' },
      files: [],
    }),
    'overrides/mods/fixture.jar': jar,
    'overrides/config/local.toml': 'pack config',
    'server-overrides/kubejs/server_scripts/recipe.js': 'ServerEvents.recipes(() => {});',
    'server-overrides/world/level.dat': 'pack world',
    'server-overrides/server.properties': 'online-mode=false\nenable-command-block=true',
    'server-overrides/start.sh': 'launcher ignored',
  });
  const http: ContentHttp = {
    json: vi.fn(async (url) =>
      url.includes('/version/')
        ? {
            id: 'v1',
            project_id: 'pack',
            name: 'Pack 1',
            version_number: '1',
            game_versions: ['1.21.1'],
            loaders: ['fabric'],
            date_published: '2026-10-21T00:00:00Z',
            version_type: 'release',
            files: [
              {
                filename: 'pack.mrpack',
                url: 'https://cdn.modrinth.com/pack.mrpack',
                size: mrpack.length,
                primary: true,
                hashes: { sha1: createHash('sha1').update(mrpack).digest('hex') },
              },
            ],
          }
        : {
            id: 'pack',
            slug: 'pack',
            title: 'Pack',
            description: 'Pack fixture',
            body: '',
            project_type: 'modpack',
            downloads: 1,
          },
    ),
    download: vi.fn(),
    downloadModpack: vi.fn(async (_artifact, destination) => {
      await writeFile(destination, mrpack, { flag: 'wx' });
      return { size: mrpack.length, sha256: hash(mrpack) };
    }),
  };
  const recipe = await createModpackCatalog('modrinth', { http }).resolve('pack', 'v1');
  const downloadModpack = http.downloadModpack;
  if (!downloadModpack) throw new Error('fixture download unavailable');
  const staged = await stageModpackRecipe(recipe, {
    directory: join(root, 'attempt'),
    reserve: async () => {},
    download: (artifact, destination, signal) => downloadModpack(artifact, destination, { signal }),
  });
  const { description: _description, descriptionFormat: _format, ...project } = recipe.project;
  const prepared: PreparedMinecraftModpack = {
    pack: { project, version: recipe.version },
    target: staged.target,
    stagingKey: staged.directory,
    files: staged.files,
    blockers: [],
  };
  const list = async (directory: string): Promise<FilemanEntry[]> => {
    const values = await readdir(join(remote, directory));
    return Promise.all(
      values.map(async (name) => {
        const info = await lstat(join(remote, directory, name));
        return {
          name,
          kind: info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : 'directory',
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        };
      }),
    );
  };
  const readScope = (): FilemanReadService => ({
    list,
    prepare: vi.fn(),
    read: async ({ path }) => new Uint8Array(await readFile(join(remote, path))),
    readMany: vi.fn(),
    listMany: async (paths) =>
      Promise.all(
        paths.map(async (directory) => {
          try {
            return { directory, files: await list(directory) };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
              return { directory, error: 'not_found' as const };
            throw error;
          }
        }),
      ),
  });
  const merged = await prepareModpackProperties(staged, readScope());
  prepared.files = merged.files;
  prepared.propertiesMerged = merged.propertiesMerged;
  prepared.propertiesSource = merged.propertiesSource;
  let journal: ModpackPublicationJournal | null = null;
  const operationId = randomUUID();
  const binding = {
    combinationId: randomUUID(),
    mappingId: randomUUID(),
    target: staged.target,
    protectedPaths: ['server.jar'],
  };
  const selection = minecraftModpackPrepareSchema.parse({
    provider: 'modrinth',
    projectId: 'pack',
    versionId: 'v1',
    mode: 'install',
    idempotencyKey: 'key',
  });
  const observation = await inspectModpackFiles(readScope(), prepared, null, binding);
  const plan = planMinecraftModpack({
    selection,
    prepared,
    observation,
    previous: null,
    runtime: {
      combinationId: binding.combinationId,
      mappingId: binding.mappingId,
      target: staged.target,
    },
  });
  const adapter = {
    renameFiles: vi.fn(
      async (_identifier: string, _root: string, moves: { from: string; to: string }[]) => {
        for (const move of moves) await rename(join(remote, move.from), join(remote, move.to));
      },
    ),
    createDirectory: vi.fn(async (_identifier: string, directory: string, name: string) => {
      await mkdir(join(remote, directory, name));
    }),
    deleteFiles: vi.fn(async (_identifier: string, directory: string, paths: string[]) => {
      for (const path of paths)
        await rm(join(remote, directory, path), { recursive: true, force: true });
    }),
  };
  const uploadArchive = vi.fn(
    async (input: Parameters<NonNullable<FilemanJobServices['uploadArchive']>>[0]) => {
      await input.beforeWrite?.();
      const parts: Buffer[] = [];
      const stream = await input.open();
      for await (const part of Readable.fromWeb(
        stream as import('node:stream/web').ReadableStream<Uint8Array>,
      ))
        parts.push(Buffer.from(part));
      const bytes = Buffer.concat(parts);
      expect(bytes.length).toBe(input.contentLength);
      expect(hash(bytes)).toBe(input.sourceSha256);
      const completion = await input.completion;
      const manifest = {
        id: input.id,
        destinationRoot: input.destinationRoot,
        files: [...completion.files],
      };
      await input.beforePublish?.(manifest);
      await visitArchive(bytes, async (file) => {
        const data = await readArchiveFile(file, 1024 * 1024);
        expect(hash(data)).toBe(completion.files.find((x) => x.path === file.path)?.sha256);
        await put(file.path, data);
      });
      return {
        id: input.id,
        digest: 'a'.repeat(64),
        files: completion.files.length,
        bytes: completion.bytes,
        manifest,
      };
    },
  );
  const publication = createModpackPublication({
    operationId,
    identifier: 'fixture',
    adapter,
    fileman: { readScope, uploadArchive, uploadStaged: vi.fn() },
    authorize: async () => {},
    readJournal: async () => journal,
    saveJournal: async (value) => {
      journal = structuredClone(value);
    },
    archive: async (_prepared, files, stagingRoot) => {
      const archive = await buildModpackTransferArchive({
        directory: staged.directory,
        files,
        stagingRoot,
        destination: join(root, 'transfer.zip'),
      });
      if (!archive) throw new Error('empty');
      return {
        sourceSha256: archive.archiveSha256,
        contentLength: archive.archiveBytes,
        files: archive.files,
        open: () =>
          Readable.toWeb(createReadStream(archive.archivePath)) as ReadableStream<Uint8Array>,
        completion: Promise.resolve({ files: archive.files, bytes: archive.expandedBytes }),
        cancel: () => {},
      };
    },
  });
  return {
    remote,
    put,
    prepared,
    plan,
    binding,
    readScope,
    publication,
    http,
    adapter,
    uploadArchive,
    journal: () => journal,
  };
}
describe('modpack composed provider-to-publication pipeline', () => {
  it('prepares one provider archive, stages once and publishes only intended writes preserving world/settings/local config', async () => {
    const f = await fixture();
    expect(f.plan.blockers).toEqual([]);
    expect(f.plan.write.map((file) => file.path).sort()).toEqual([
      'kubejs/server_scripts/recipe.js',
      'mods/fixture.jar',
      'server.properties',
    ]);
    assertMinecraftModpackPlanCurrent(
      f.plan,
      await inspectModpackFiles(f.readScope(), f.prepared, null, f.binding),
    );
    await f.publication.publish(f.prepared, f.plan);
    const receipt = await f.publication.verify(f.prepared, f.plan);
    expect(receipt).toHaveLength(3);
    expect(f.uploadArchive).toHaveBeenCalledTimes(1);
    expect(f.http.downloadModpack).toHaveBeenCalledTimes(1);
    expect(await readFile(join(f.remote, 'config/local.toml'), 'utf8')).toBe('owner local config');
    expect(await readFile(join(f.remote, 'server.properties'), 'utf8')).toBe(
      'level-name=world\nenable-command-block=true\n',
    );
    expect(await readFile(join(f.remote, 'world/level.dat'), 'utf8')).toBe('existing world');
    expect(await readFile(join(f.remote, 'world/region/existing.mca'), 'utf8')).toBe(
      'existing region',
    );
    expect(await readFile(join(f.remote, 'server.jar'), 'utf8')).toBe('managed runtime');
    expect((await readFile(join(f.remote, 'mods/fixture.jar'))).subarray(0, 2).toString()).toBe(
      'PK',
    );
    expect(await f.publication.recover(f.prepared, f.plan)).toMatchObject({ state: 'applied' });
    await f.publication.cleanup(f.prepared, f.plan, { applied: true });
    expect(
      (await readdir(f.remote)).filter((path) => path.startsWith('.nickhosting-pack-')),
    ).toEqual([]);
    expect(f.journal()?.state).toBe('cleaned');
  });
  it('does not publish if a source changes after preparation, and recovery observes unchanged live files', async () => {
    const f = await fixture();
    await writeFile(join(f.prepared.stagingKey, 'kubejs/server_scripts/recipe.js'), 'changed');
    await expect(f.publication.publish(f.prepared, f.plan)).rejects.toThrow();
    expect(f.adapter.renameFiles).not.toHaveBeenCalled();
    expect(f.uploadArchive).not.toHaveBeenCalled();
    expect(await f.publication.recover(f.prepared, f.plan)).toEqual({ state: 'unchanged' });
    expect(await readFile(join(f.remote, 'config/local.toml'), 'utf8')).toBe('owner local config');
  });
});
