import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { satisfies } from 'semver';
import { z } from 'zod';
import type { SatisfactoryModLock, SatisfactoryModSelection } from './mods.js';
import {
  transferVerifiedSatisfactoryCacheFile,
  validateSatisfactoryCacheDirectory,
} from './mods-download-cache.js';

export const satisfactoryMetadataCacheTtlMs = 60_000;
const indexBytes = 1_048_576;
const identitySchema = z.strictObject({
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
  gameBuild: z.number().int().positive(),
  targets: z
    .array(z.enum(['LinuxServer', 'WindowsServer', 'Windows']))
    .min(1)
    .max(3),
});
export type SatisfactoryMetadataIdentity = z.infer<typeof identitySchema>;
const indexSchema = z.strictObject({
  version: z.literal(1),
  identity: identitySchema,
  capturedAt: z.number().int().nonnegative(),
  coverage: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/), z.string().max(256)),
  files: z
    .array(
      z.strictObject({
        name: z.enum(['registry.db', 'registry.db-wal']),
        size: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(2),
});
type Snapshot = z.infer<typeof indexSchema>;

async function readIndex(directory: string): Promise<(Snapshot & { indexSize: number }) | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(join(directory, 'index.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > indexBytes) return null;
    const parsed = indexSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    if (!parsed.success || Object.keys(parsed.data.coverage).length > 4096) return null;
    return { ...parsed.data, indexSize: stat.size };
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      ['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      return null;
    throw error;
  } finally {
    await file?.close();
  }
}

function identityKey(identity: SatisfactoryMetadataIdentity) {
  return JSON.stringify({
    executableSha256: identity.executableSha256,
    gameBuild: identity.gameBuild,
    targets: [...identity.targets].sort(),
  });
}

/** A short-lived snapshot is native metadata, never an imported profile. Offline
 * resolution is allowed only when every requested root was resolved by this
 * service and its constraint remains covered. New roots take the online path. */
export async function seedSatisfactoryMetadataCache(options: {
  stagingRoot: string;
  sourceDirectories: string[];
  destinationDirectory: string;
  identity: SatisfactoryMetadataIdentity;
  selection: SatisfactoryModSelection;
  maximumBytes: number;
  signal?: AbortSignal;
  now?: number;
}): Promise<{ capturedAt: number } | null> {
  if (options.sourceDirectories.length > 2)
    throw new Error('satisfactory_mod_cache_sources_invalid');
  const maximumBytes = z
    .number()
    .int()
    .min(indexBytes)
    .max(256 * 1024 ** 2)
    .parse(options.maximumBytes);
  const now = options.now ?? Date.now();
  await validateSatisfactoryCacheDirectory(options.stagingRoot, options.destinationDirectory);
  for (const source of options.sourceDirectories) {
    const directory = join(source, 'metadata-cache');
    await validateSatisfactoryCacheDirectory(options.stagingRoot, directory);
    const index = await readIndex(directory);
    if (
      !index ||
      index.capturedAt > now ||
      now - index.capturedAt >= satisfactoryMetadataCacheTtlMs ||
      identityKey(index.identity) !== identityKey(options.identity) ||
      index.files[0]?.name !== 'registry.db' ||
      new Set(index.files.map((file) => file.name)).size !== index.files.length ||
      index.files.reduce((sum, file) => sum + file.size, index.indexSize) > maximumBytes ||
      options.selection.some(
        (item) =>
          item.enabled !== false &&
          (!index.coverage[item.reference] ||
            !satisfies(index.coverage[item.reference] ?? '', item.version.replaceAll(',', ' '))),
      )
    )
      continue;
    await mkdir(options.destinationDirectory, { recursive: true, mode: 0o700 });
    let valid = true;
    for (const file of index.files) {
      if (
        !(await transferVerifiedSatisfactoryCacheFile(
          join(directory, file.name),
          join(options.destinationDirectory, file.name),
          file,
          options.signal,
        ))
      ) {
        valid = false;
        break;
      }
    }
    if (valid) return { capturedAt: index.capturedAt };
    await Promise.all(
      ['registry.db', 'registry.db-wal', 'registry.db-shm'].map((name) =>
        rm(join(options.destinationDirectory, name), { force: true }),
      ),
    );
  }
  return null;
}

/** Preserve main DB and WAL together after the native process has exited. SQLite
 * recreates its shared-memory index. Reusing a snapshot never extends its TTL. */
export async function persistSatisfactoryMetadataCache(options: {
  stagingRoot: string;
  sourceDirectory: string;
  destinationDirectory: string;
  identity: SatisfactoryMetadataIdentity;
  lock: SatisfactoryModLock;
  capturedAt: number;
  maximumBytes: number;
  signal?: AbortSignal;
}): Promise<number> {
  const maximumBytes = z
    .number()
    .int()
    .min(indexBytes)
    .max(256 * 1024 ** 2)
    .parse(options.maximumBytes);
  await validateSatisfactoryCacheDirectory(options.stagingRoot, options.sourceDirectory);
  await validateSatisfactoryCacheDirectory(options.stagingRoot, options.destinationDirectory);
  await rm(options.destinationDirectory, { recursive: true, force: true });
  const files: Snapshot['files'] = [];
  let bytes = 0;
  for (const name of ['registry.db', 'registry.db-wal'] as const) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(
        join(options.sourceDirectory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error('satisfactory_mod_cache_artifact_invalid');
      if (stat.size === 0) {
        if (name === 'registry.db') return 0;
        continue;
      }
      bytes += stat.size;
      if (bytes > maximumBytes) return 0;
      const digest = createHash('sha256');
      for await (const chunk of file.createReadStream({
        autoClose: false,
        highWaterMark: 1_048_576,
      })) {
        options.signal?.throwIfAborted();
        digest.update(chunk);
      }
      files.push({ name, size: stat.size, sha256: digest.digest('hex') });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (name === 'registry.db') return 0;
    } finally {
      await file?.close();
    }
  }
  const snapshot: Snapshot = {
    version: 1,
    identity: options.identity,
    capturedAt: options.capturedAt,
    coverage: Object.fromEntries(
      Object.entries(options.lock.mods).map(([reference, mod]) => [reference, mod.version]),
    ),
    files,
  };
  const index = JSON.stringify(snapshot);
  if (
    Buffer.byteLength(index) > indexBytes ||
    bytes + Buffer.byteLength(index) > maximumBytes ||
    Object.keys(snapshot.coverage).length > 4096
  )
    return 0;
  await mkdir(options.destinationDirectory, { recursive: true, mode: 0o700 });
  for (const file of files) {
    if (
      !(await transferVerifiedSatisfactoryCacheFile(
        join(options.sourceDirectory, file.name),
        join(options.destinationDirectory, file.name),
        file,
        options.signal,
        true,
      ))
    )
      throw new Error('satisfactory_mod_cache_artifact_invalid');
  }
  await writeFile(join(options.destinationDirectory, 'index.json'), index, {
    flag: 'wx',
    mode: 0o600,
  });
  return files.reduce((sum, file) => sum + file.size, Buffer.byteLength(index));
}
