import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { SatisfactoryModLock } from './mods.js';
import { type SatisfactoryModLimits, satisfactoryModDefaultLimits } from './mods-limits.js';

const MAX_BYTES = 16 * 1024 ** 3;
const MAX_INDEX_BYTES = 262_144;

const MAX_FILES = 4096;
const cacheKey =
  /^[A-Za-z][A-Za-z0-9_]{0,127}_[0-9A-Za-z.+-]{1,128}_(?:LinuxServer|WindowsServer|Windows)\.zip$/;
const entrySchema = z.strictObject({
  key: z.string().regex(cacheKey),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(MAX_BYTES),
});
type CacheEntry = z.infer<typeof entrySchema>;
const indexSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(entrySchema).max(MAX_FILES),
});

/** Cache paths belong to durable job stages. Never follow a link back out of the
 * private work tree; a cache is optional, not a new file authority boundary. */
export async function validateSatisfactoryCacheDirectory(root: string, directory: string) {
  const subpath = relative(root, directory);
  if (
    !isAbsolute(root) ||
    !isAbsolute(directory) ||
    !subpath ||
    subpath.startsWith('..') ||
    isAbsolute(subpath)
  )
    throw new Error('satisfactory_mod_cache_path_invalid');
  let current = root;
  for (const part of ['', ...subpath.split('/')]) {
    if (part) current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error('satisfactory_mod_cache_path_invalid');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
  }
}

async function readIndex(directory: string): Promise<CacheEntry[]> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(join(directory, 'index.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_INDEX_BYTES) return [];
    const parsed = indexSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    return parsed.success ? parsed.data.entries : [];
  } catch (error) {
    if (
      ['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '') ||
      error instanceof SyntaxError
    )
      return [];
    throw error;
  } finally {
    await file?.close();
  }
}

/** Seed through a no-follow descriptor into a distinct inode. Publishing after
 * the child exits moves its verified copy, avoiding extra peak disk usage. */
export async function transferVerifiedSatisfactoryCacheFile(
  source: string,
  destination: string,
  entry: Pick<CacheEntry, 'size' | 'sha256'>,
  signal?: AbortSignal,
  move = false,
) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    signal?.throwIfAborted();
    file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== entry.size) return false;
    const digest = createHash('sha256');
    let bytes = 0;
    const sourceFile = file;
    const chunks = async function* () {
      for await (const chunk of sourceFile.createReadStream({
        autoClose: false,
        highWaterMark: 1_048_576,
      })) {
        signal?.throwIfAborted();
        bytes += chunk.length;
        if (bytes > entry.size) throw new Error('satisfactory_mod_cache_size_invalid');
        digest.update(chunk);
        yield chunk;
      }
    };
    if (move) {
      for await (const _chunk of chunks()) {
        /* Hash before moving, without duplicating staged bytes. */
      }
    } else {
      const output = createWriteStream(destination, {
        flags: 'wx',
        mode: 0o600,
        highWaterMark: 1_048_576,
      });
      output.once('open', () => {
        created = true;
      });
      await pipeline(chunks(), output, { signal });
    }
    const after = await file.stat();
    const valid =
      bytes === entry.size &&
      digest.digest('hex') === entry.sha256 &&
      before.mtimeMs === after.mtimeMs &&
      before.size === after.size;
    if (!valid && created) await rm(destination, { force: true });
    if (valid && move) {
      const pathStat = await lstat(source);
      if (pathStat.dev !== before.dev || pathStat.ino !== before.ino || pathStat.isSymbolicLink())
        return false;
      await rename(source, destination);
    }
    return valid;
  } catch (error) {
    if (created) await rm(destination, { force: true });
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  } finally {
    await file?.close();
  }
}

/** Sources are newest first. Keep only bounded, individually verified immutable
 * archives; ficsit rechecks them against freshly resolved upstream hashes. */
export async function seedSatisfactoryDownloadCache(options: {
  stagingRoot: string;
  sourceDirectories: string[];
  destinationDirectory: string;
  signal?: AbortSignal;
  limits?: Pick<SatisfactoryModLimits, 'archiveBytes'>;
}) {
  const maximum =
    z
      .number()
      .int()
      .min(1_048_576)
      .max(MAX_BYTES)
      .parse(options.limits?.archiveBytes ?? satisfactoryModDefaultLimits.archiveBytes) -
    MAX_INDEX_BYTES;
  if (options.sourceDirectories.length > 2)
    throw new Error('satisfactory_mod_cache_sources_invalid');
  await validateSatisfactoryCacheDirectory(options.stagingRoot, options.destinationDirectory);
  await mkdir(options.destinationDirectory, { recursive: true, mode: 0o700 });
  const copied = new Set<string>();
  let bytes = 0;
  for (const source of options.sourceDirectories) {
    await validateSatisfactoryCacheDirectory(options.stagingRoot, source);
    const cache = join(source, 'download-cache');
    await validateSatisfactoryCacheDirectory(options.stagingRoot, cache);
    for (const entry of await readIndex(cache)) {
      options.signal?.throwIfAborted();
      if (copied.has(entry.key) || copied.size >= MAX_FILES || bytes + entry.size > maximum)
        continue;
      if (
        await transferVerifiedSatisfactoryCacheFile(
          join(cache, entry.key),
          join(options.destinationDirectory, entry.key),
          entry,
          options.signal,
        )
      ) {
        copied.add(entry.key);
        bytes += entry.size;
      }
    }
  }
  return bytes;
}

/** Only artifacts named by the fresh native lock can survive a preparation. This
 * avoids persisting partial downloads, stale cache indexes or arbitrary files. */
export async function persistSatisfactoryDownloadCache(options: {
  stagingRoot: string;
  sourceDirectory: string;
  destinationDirectory: string;
  lock: SatisfactoryModLock;
  signal?: AbortSignal;
  limits?: Pick<SatisfactoryModLimits, 'archiveBytes'>;
}) {
  const maximum =
    z
      .number()
      .int()
      .min(1_048_576)
      .max(MAX_BYTES)
      .parse(options.limits?.archiveBytes ?? satisfactoryModDefaultLimits.archiveBytes) -
    MAX_INDEX_BYTES;
  await validateSatisfactoryCacheDirectory(options.stagingRoot, options.sourceDirectory);
  await validateSatisfactoryCacheDirectory(options.stagingRoot, options.destinationDirectory);
  await rm(options.destinationDirectory, { recursive: true, force: true });
  await mkdir(options.destinationDirectory, { recursive: true, mode: 0o700 });
  const entries: CacheEntry[] = [];
  let bytes = 0;
  for (const [reference, mod] of Object.entries(options.lock.mods)) {
    for (const [target, artifact] of Object.entries(mod.targets)) {
      const key = `${reference}_${mod.version}_${target}.zip`;
      if (!cacheKey.test(key)) continue;
      let metadata: Awaited<ReturnType<typeof lstat>>;
      try {
        metadata = await lstat(join(options.sourceDirectory, key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!/^[a-f0-9]{64}$/.test(artifact.hash))
        throw new Error('satisfactory_mod_download_integrity_failed');
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
        throw new Error('satisfactory_mod_cache_artifact_invalid');
      if (metadata.size === 0 || entries.length >= MAX_FILES || bytes + metadata.size > maximum)
        continue;
      const entry = { key, sha256: artifact.hash, size: metadata.size };
      if (
        !(await transferVerifiedSatisfactoryCacheFile(
          join(options.sourceDirectory, key),
          join(options.destinationDirectory, key),
          entry,
          options.signal,
          true,
        ))
      )
        throw new Error('satisfactory_mod_download_integrity_failed');
      entries.push(entry);
      bytes += entry.size;
    }
  }
  const index = JSON.stringify({ version: 1, entries });
  if (Buffer.byteLength(index) > MAX_INDEX_BYTES)
    throw new Error('satisfactory_mod_cache_index_invalid');
  await writeFile(join(options.destinationDirectory, 'index.json'), index, {
    mode: 0o600,
    flag: 'wx',
  });
  return bytes + Buffer.byteLength(index);
}
