import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import { z } from 'zod';
import {
  type ArchiveFile,
  inspectJarEnvironment,
  readArchiveFile,
  visitArchive,
} from './archive.js';
import { type ContentLimits, type ContentTarget, contentLimits, fail } from './contracts.js';
import { targetFromMrpack } from './modpack.js';
import { modpackTargetSchema } from './modpack-catalog.js';
import { assertModpackPaths, modpackDataPath } from './modpack-paths.js';
import type { ModpackDownload, ModpackRecipe, ModpackRecipeFile } from './modpack-recipes.js';
import { contentStageDirectory } from './staging.js';

export interface ModpackStagedFile {
  path: string;
  size: number;
  sha256: string;
}
export interface ModpackStaged {
  directory: string;
  target: ContentTarget;
  files: ModpackStagedFile[];
  excludedFiles: number;
}
export interface ModpackStagingOptions {
  /** Fresh private attempt directory. The coordinator owns retention and cleanup. */
  directory: string;
  /** Validates the provider hashes while streaming and seals the result with SHA256. */
  download(
    input: ModpackDownload,
    destination: string,
    signal?: AbortSignal,
    options?: { maxBytes: number; onSize: (bytes: number) => Promise<void> },
  ): Promise<{ size: number; sha256: string }>;
  resolveCurseForgeFiles?(
    files: { projectId: number; fileId: number }[],
    signal?: AbortSignal,
  ): Promise<ModpackRecipeFile[]>;
  limits?: Partial<ContentLimits>;
  concurrency?: number;
  /** Optional bounded diagnostics; labels are fixed and never contain file paths. */
  timing?: { measure<T>(name: string, work: () => Promise<T>): Promise<T> };
  signal?: AbortSignal;
  /** Total on-disk budget, including archives. Called before each allocation phase. */
  reserve(bytes: number): Promise<void>;
  /** Reject unsupported runtimes before downloading pack content, once requirements are known. */
  checkTarget?(target: ContentTarget): Promise<void>;
  progress?(progress: {
    files: number;
    totalFiles: number;
    bytes: number;
    totalBytes: number | null;
  }): Promise<void>;
}
const mrpack = z.object({
  formatVersion: z.literal(1),
  game: z.literal('minecraft'),
  dependencies: z.record(z.string(), z.string()),
  files: z
    .array(
      z.object({
        path: z.string(),
        fileSize: z.number().int().nonnegative().safe(),
        downloads: z.array(z.string().url()).min(1).max(8),
        hashes: z.object({
          sha1: z.string().regex(/^[a-f0-9]{40}$/i),
          sha512: z.string().regex(/^[a-f0-9]{128}$/i),
        }),
        env: z
          .object({ server: z.enum(['required', 'optional', 'unsupported']) })
          .passthrough()
          .optional(),
      }),
    )
    .max(20000),
});
const cursepack = z.object({
  manifestType: z.literal('minecraftModpack'),
  manifestVersion: z.literal(1),
  minecraft: z.object({
    version: z.string(),
    modLoaders: z
      .array(z.object({ id: z.string(), primary: z.boolean() }))
      .min(1)
      .max(8),
  }),
  files: z
    .array(
      z.object({
        projectID: z.number().int().positive(),
        fileID: z.number().int().positive(),
        required: z.boolean(),
      }),
    )
    .max(10000),
  overrides: z.string().regex(/^[A-Za-z0-9_-]+$/),
});
function curseTarget(manifest: z.infer<typeof cursepack>): ContentTarget {
  const primary = manifest.minecraft.modLoaders.filter((loader) => loader.primary);
  if (primary.length !== 1) fail('modpack_loader_conflict');
  const selected = /^(forge|neoforge|fabric|quilt)-(.+)$/.exec(primary[0]?.id ?? '');
  if (!selected) fail('modpack_loader');
  return modpackTargetSchema.parse({
    minecraftVersion: manifest.minecraft.version,
    loader: selected[1],
    loaderVersion: selected[2],
  });
}
const sameTarget = (a: ContentTarget, b: ContentTarget) =>
  a.minecraftVersion === b.minecraftVersion &&
  a.loader === b.loader &&
  a.loaderVersion === b.loaderVersion;
const dataRoots = [
  'mods',
  'config',
  'plugins',
  'scripts',
  'kubejs',
  'defaultconfigs',
  'resources',
  'datapacks',
  'world',
  'resourcepacks',
  'shaderpacks',
  'coremods',
  'openloader',
  'patchouli_books',
];
function serverRoot(members: readonly { path: string }[]): string {
  const root = members[0]?.path.split('/')[0];
  // Only a wrapper exposing recognizable pack structure may be stripped. A lone
  // custom world or script directory is data and must retain its own name.
  const structured = members.some((file) => {
    const child = file.path.split('/')[1] ?? '';
    return (
      dataRoots.includes(child.toLowerCase()) ||
      ['manifest.json', 'modrinth.index.json'].includes(child)
    );
  });
  return root &&
    structured &&
    !dataRoots.includes(root.toLowerCase()) &&
    members.every((file) => file.path.startsWith(`${root}/`))
    ? `${root}/`
    : '';
}
function checkedDownload(
  saved: { size: number; sha256: string },
  expected: ModpackDownload,
  maximum: number,
) {
  if (
    !Number.isSafeInteger(saved.size) ||
    saved.size < 0 ||
    saved.size > maximum ||
    (expected.size !== undefined && expected.size !== saved.size) ||
    !/^[a-f0-9]{64}$/.test(saved.sha256)
  )
    fail('download_size');
  return saved;
}

/** One decompression/hash pass for selected entries; the inventory pass never inflates data. */
async function extract(file: ArchiveFile, target: string, signal?: AbortSignal) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const hash = createHash('sha256');
  let bytes = 0,
    checksum = 0;
  const stream = await file.open({ inflateChunkSize: 256 * 1024 });
  await pipeline(
    stream,
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > file.size) return callback(new Error('archive_size'));
        hash.update(chunk);
        checksum = crc32(chunk, checksum);
        callback(null, chunk);
      },
      flush(callback) {
        callback(
          bytes !== file.size || checksum !== file.entry.crc32
            ? new Error('archive_integrity')
            : null,
        );
      },
    }),
    createWriteStream(target, { flags: 'wx', mode: 0o600 }),
    { signal },
  );
  return { size: bytes, sha256: hash.digest('hex') };
}

/** Prepare immutable server data locally. This never executes scripts or touches a game server. */
export async function stageModpackRecipe(
  recipe: ModpackRecipe,
  options: ModpackStagingOptions,
): Promise<ModpackStaged> {
  const trace = <T>(name: string, work: () => Promise<T>) =>
    options.timing ? options.timing.measure(name, work) : work();
  options.signal?.throwIfAborted();
  if (recipe.kind === 'unavailable') fail(`modpack_${recipe.reason}`);
  const limits = contentLimits(options.limits);
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    fail('stage_concurrency');
  const filesRoot = join(options.directory, 'files');
  await contentStageDirectory(options.directory);
  await mkdir(filesRoot, { mode: 0o700 }); // An unsealed partial attempt is never reused.
  let archiveBytes = 0,
    excludedFiles = 0;
  let target: ContentTarget | undefined;
  const acceptTarget = async (candidate: ContentTarget) => {
    const value = modpackTargetSchema.parse(candidate);
    if (target) {
      if (!sameTarget(target, value)) fail('modpack_target_mismatch');
      return;
    }
    target = value;
    await trace('runtime', async () => options.checkTarget?.(value));
  };
  if (recipe.target) await acceptTarget(recipe.target);
  let downloads: ModpackRecipeFile[] = recipe.files ?? [];
  const overrides = new Map<
    string,
    { source: string; path: string; size: number; layer: number }
  >();
  const archivePath = join(options.directory, 'source.zip');
  const acquireArchive = async (download: ModpackDownload, path: string) => {
    options.signal?.throwIfAborted();
    const maximum = download.size ?? limits.maxArchiveBytes;
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > limits.maxArchiveBytes)
      fail('archive_size');
    await trace('reservation', async () => options.reserve(archiveBytes + maximum));
    const acquired = checkedDownload(
      await trace('download', async () => options.download(download, path, options.signal)),
      download,
      limits.maxArchiveBytes,
    );
    archiveBytes += acquired.size;
  };
  if (recipe.kind === 'archive') {
    if (recipe.targetManifest) {
      const path = join(options.directory, 'target.zip');
      await acquireArchive(recipe.targetManifest.download, path);
      let raw: unknown;
      await trace('archiveInventory', async () =>
        visitArchive(
          path,
          async (file) => {
            options.signal?.throwIfAborted();
            if (file.path === 'manifest.json')
              raw = JSON.parse(
                (await readArchiveFile(file, limits.maxMetadataBytes)).toString('utf8'),
              );
          },
          limits,
        ),
      );
      await acceptTarget(curseTarget(cursepack.parse(raw)));
    }
    await acquireArchive(recipe.download, archivePath);
    const members: { path: string; size: number }[] = [];
    const manifests = new Map<string, Buffer>();
    let metadataBytes = 0;
    const manifestAt = (path: string): unknown => {
      const bytes = manifests.get(path);
      return bytes === undefined ? undefined : JSON.parse(bytes.toString('utf8'));
    };
    await trace('archiveInventory', async () =>
      visitArchive(
        archivePath,
        async (file) => {
          options.signal?.throwIfAborted();
          members.push({ path: file.path, size: file.size });
          const parts = file.path.split('/');
          // Only root or a single wrapper is meaningful; never scan arbitrary nested manifests.
          if (
            (parts.length === 1 ||
              (recipe.format === 'server-archive' &&
                parts.length === 2 &&
                serverRoot([file]) !== '')) &&
            ['modrinth.index.json', 'manifest.json'].includes(parts.at(-1) ?? '')
          ) {
            metadataBytes += file.size;
            if (metadataBytes > limits.maxMetadataBytes) fail('metadata_size');
            manifests.set(file.path, await readArchiveFile(file, limits.maxMetadataBytes));
          }
        },
        limits,
      ),
    );
    let roots: string[];
    if (recipe.format === 'modrinth-index') {
      const manifest = mrpack.parse(manifestAt('modrinth.index.json'));
      await acceptTarget(targetFromMrpack(manifest.dependencies));
      downloads = manifest.files.flatMap((file) => {
        const path = modpackDataPath(file.path);
        if (!path || file.env?.server === 'unsupported') {
          excludedFiles++;
          return [];
        }
        return [
          {
            path,
            download: {
              filename: path.split('/').at(-1) as string,
              urls: file.downloads,
              size: file.fileSize,
              hashes: {
                sha1: file.hashes.sha1.toLowerCase(),
                sha512: file.hashes.sha512.toLowerCase(),
              },
            },
            serverSide:
              file.env?.server === 'optional' ? ('optional' as const) : ('required' as const),
          },
        ];
      });
      roots = ['overrides/', 'server-overrides/'];
    } else if (recipe.format === 'curseforge-manifest') {
      const manifest = cursepack.parse(manifestAt('manifest.json'));
      await acceptTarget(curseTarget(manifest));
      const resolveFiles = options.resolveCurseForgeFiles;
      if (!resolveFiles) fail('curseforge_credentials');
      const pins = manifest.files
        .filter((file) => file.required)
        .map((file) => ({ projectId: file.projectID, fileId: file.fileID }));
      excludedFiles += manifest.files.length - pins.length;
      downloads = await trace('resolveDependencies', async () =>
        resolveFiles(pins, options.signal),
      );
      roots = [`${manifest.overrides}/`];
    } else {
      const root = recipe.preserveRoot ? '' : serverRoot(members);
      const mr = manifestAt(`${root}modrinth.index.json`);
      const cf = manifestAt(`${root}manifest.json`);
      if (mr !== undefined) await acceptTarget(targetFromMrpack(mrpack.parse(mr).dependencies));
      // Server archives can use manifest.json for their own file inventory. Only
      // the explicit CurseForge type declares runtime requirements; once declared,
      // validate the whole manifest and its agreement with any companion target.
      if (
        cf !== null &&
        typeof cf === 'object' &&
        'manifestType' in cf &&
        cf.manifestType === 'minecraftModpack'
      )
        await acceptTarget(curseTarget(cursepack.parse(cf)));
      roots = [root];
    }
    for (const file of members) {
      const layer = roots.findIndex((root) => file.path.startsWith(root));
      if (layer < 0) continue;
      const relative = file.path.slice((roots[layer] as string).length);
      if (
        recipe.format === 'server-archive' &&
        ['manifest.json', 'modrinth.index.json'].includes(relative)
      ) {
        excludedFiles++;
        continue;
      }
      const path = modpackDataPath(relative);
      if (!path) {
        excludedFiles++;
        continue;
      }
      const prior = overrides.get(path.toLowerCase());
      if (prior && prior.path !== path) fail('override_case_conflict');
      if (!prior || layer > prior.layer)
        overrides.set(path.toLowerCase(), { source: file.path, path, size: file.size, layer });
    }
  }
  if (!target) fail('modpack_target_unresolved');
  downloads = downloads.filter((file) => {
    const allowed =
      modpackDataPath(file.path) === file.path && !overrides.has(file.path.toLowerCase());
    if (!allowed) excludedFiles++;
    return allowed;
  });
  const paths = [
    ...downloads.map((file) => file.path),
    ...[...overrides.values()].map((file) => file.path),
  ];
  assertModpackPaths(paths);
  if (paths.length > limits.maxEntries) fail('stage_budget');
  let totalBytes =
    downloads.reduce((sum, file) => sum + (file.download.size ?? 0), 0) +
    [...overrides.values()].reduce((sum, file) => sum + file.size, 0);
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > limits.maxExpandedBytes ||
    downloads.some(
      (file) =>
        file.download.size !== undefined &&
        (!Number.isSafeInteger(file.download.size) ||
          file.download.size < 0 ||
          file.download.size > limits.maxFileBytes),
    )
  )
    fail('stage_budget');
  await trace('reservation', async () => options.reserve(archiveBytes + totalBytes));
  const staged: ModpackStagedFile[] = [];
  let completedBytes = 0,
    completedFiles = 0;
  let unresolvedSizes = downloads.filter((file) => file.download.size === undefined).length;
  // Progress persistence is serialized, downloads remain concurrent. Coordinator may coalesce events.
  let progressTail: Promise<void> = Promise.resolve();
  const progress = () => {
    const snapshot = {
      files: completedFiles,
      totalFiles: paths.length,
      bytes: completedBytes,
      totalBytes: unresolvedSizes ? null : totalBytes,
    };
    progressTail = progressTail.then(() =>
      trace('progressPersist', async () => options.progress?.(snapshot)),
    );
    return progressTail;
  };
  await progress();
  let cursor = 0;
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const known = downloads.filter((file) => file.download.size !== undefined);
  const unknown = downloads.filter((file) => file.download.size === undefined);
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, known.length) }, async () => {
      try {
        for (;;) {
          signal.throwIfAborted();
          const file = known[cursor++];
          if (!file) return;
          const destination = join(filesRoot, file.path);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          const saved = checkedDownload(
            await trace('download', async () =>
              options.download(file.download, destination, signal),
            ),
            file.download,
            limits.maxFileBytes,
          );
          if (
            /\.jar$/i.test(file.path) &&
            (await trace('jarEnvironment', async () =>
              inspectJarEnvironment(destination, limits),
            )) === 'client'
          ) {
            await rm(destination);
            totalBytes -= saved.size;
            excludedFiles++;
            completedFiles++;
            await progress();
            continue;
          }
          staged.push({ path: file.path, ...saved });
          completedBytes += saved.size;
          completedFiles++;
          await progress();
        }
      } catch (error) {
        abort.abort(error);
        throw error;
      }
    }),
  );
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  // Unknown files cannot each consume the whole staging budget up front. The GET
  // headers admit one bounded transfer at a time, before any of its bytes reach disk.
  for (const file of unknown) {
    signal.throwIfAborted();
    const previousBytes = totalBytes;
    const maximum = Math.min(limits.maxFileBytes, limits.maxExpandedBytes - totalBytes);
    const destination = join(filesRoot, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    let admitted: number | undefined;
    const saved = checkedDownload(
      await trace('download', async () =>
        options.download(file.download, destination, signal, {
          maxBytes: maximum,
          onSize: async (bytes) => {
            signal.throwIfAborted();
            if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum) fail('stage_budget');
            await trace('reservation', async () =>
              options.reserve(archiveBytes + totalBytes + bytes),
            );
            admitted = bytes;
          },
        }),
      ),
      file.download,
      admitted ?? -1,
    );
    signal.throwIfAborted();
    if (
      /\.jar$/i.test(file.path) &&
      (await trace('jarEnvironment', async () => inspectJarEnvironment(destination, limits))) ===
        'client'
    ) {
      await rm(destination);
      excludedFiles++;
    } else {
      staged.push({ path: file.path, ...saved });
      completedBytes += saved.size;
      totalBytes += saved.size;
    }
    // Release an absent-header allowance (or excluded client file) before the next GET.
    if (totalBytes - previousBytes !== admitted)
      await trace('reservation', async () => options.reserve(archiveBytes + totalBytes));
    unresolvedSizes--;
    completedFiles++;
    await progress();
  }
  if (overrides.size) {
    const selected = new Map([...overrides.values()].map((file) => [file.source, file]));
    await trace('archiveExtract', async () =>
      visitArchive(
        archivePath,
        async (file) => {
          signal.throwIfAborted();
          const item = selected.get(file.path);
          if (!item) return;
          const destination = join(filesRoot, item.path);
          const saved = await trace('extractHash', async () => extract(file, destination, signal));
          if (
            /\.jar$/i.test(item.path) &&
            (await trace('jarEnvironment', async () =>
              inspectJarEnvironment(destination, limits),
            )) === 'client'
          ) {
            await rm(destination);
            excludedFiles++;
          } else {
            staged.push({ path: item.path, ...saved });
            completedBytes += saved.size;
          }
          completedFiles++;
          await progress();
        },
        limits,
      ),
    );
  }
  signal.throwIfAborted();
  totalBytes = completedBytes;
  await progress();
  return {
    directory: filesRoot,
    target,
    files: staged.sort((a, b) => a.path.localeCompare(b.path)),
    excludedFiles,
  };
}
