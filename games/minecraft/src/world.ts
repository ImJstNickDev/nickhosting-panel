import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, gunzipSync } from 'node:zlib';
import {
  assertContentDiskSpace,
  type ContentDiskPolicy,
  type ContentLimits,
  contentLimits,
  contentStageDirectory,
  type StagedContentFile,
  visitArchive,
} from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';
import { parseUncompressed } from 'prismarine-nbt';
import { minecraftWorldName, planMinecraftWorldImport } from './management.js';

function fail(reason: string): never {
  throw new DomainError('validation_failed', 400, { reason: `minecraft_world_${reason}` });
}
export interface MinecraftNbtLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxDepth: number;
  maxTags: number;
  maxArrayElements: number;
}
function nbtLimits(input: Partial<MinecraftNbtLimits> = {}): MinecraftNbtLimits {
  const limits = {
    maxCompressedBytes: 8 * 1024 ** 2,
    maxUncompressedBytes: 16 * 1024 ** 2,
    maxDepth: 32,
    maxTags: 100_000,
    maxArrayElements: 1_000_000,
    ...input,
  };
  if (
    Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1) ||
    limits.maxCompressedBytes > 64 * 1024 ** 2 ||
    limits.maxUncompressedBytes > 64 * 1024 ** 2 ||
    limits.maxDepth > 64 ||
    limits.maxTags > 100_000 ||
    limits.maxArrayElements > 1_000_000
  )
    fail('nbt_limits');
  return limits;
}
/** A bounded structural validation pass precedes the upstream object decoder. */
function preflightNbt(buffer: Buffer, limits: MinecraftNbtLimits): void {
  let offset = 0;
  let tags = 0;
  let elements = 0;
  const take = (length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > buffer.length)
      fail('nbt_truncated');
    const start = offset;
    offset += length;
    return start;
  };
  const byte = () => buffer.readUInt8(take(1));
  const length = () => {
    const value = buffer.readInt32BE(take(4));
    if (value < 0) fail('nbt_negative_length');
    return value;
  };
  const string = (name: boolean) => {
    const size = buffer.readUInt16BE(take(2));
    const start = take(size);
    if (!name) return '';
    if (size > 1024) fail('nbt_name');
    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(start, start + size),
      );
    } catch {
      return fail('nbt_name');
    }
    if (['__proto__', 'constructor', 'prototype'].includes(value) || value.includes('\0'))
      fail('nbt_name');
    return value;
  };
  const payload = (type: number, depth: number): void => {
    if (++tags > limits.maxTags || depth > limits.maxDepth) fail('nbt_complexity');
    switch (type) {
      case 1:
        take(1);
        return;
      case 2:
        take(2);
        return;
      case 3:
      case 5:
        take(4);
        return;
      case 4:
      case 6:
        take(8);
        return;
      case 7:
      case 11:
      case 12: {
        const count = length();
        elements += count;
        if (elements > limits.maxArrayElements) fail('nbt_complexity');
        take(count * (type === 7 ? 1 : type === 11 ? 4 : 8));
        return;
      }
      case 8:
        string(false);
        return;
      case 9: {
        const subtype = byte();
        const count = length();
        if (subtype > 12 || (subtype === 0 && count !== 0) || count > limits.maxTags - tags)
          fail('nbt_list');
        for (let i = 0; i < count; i++) payload(subtype, depth + 1);
        return;
      }
      case 10: {
        const names = new Set<string>();
        for (;;) {
          const subtype = byte();
          if (subtype === 0) return;
          const name = string(true);
          if (names.has(name)) fail('nbt_duplicate');
          names.add(name);
          payload(subtype, depth + 1);
        }
      }
      default:
        fail('nbt_tag');
    }
  };
  if (byte() !== 10) fail('nbt_root');
  string(true);
  payload(10, 0);
  if (offset !== buffer.length) fail('nbt_trailing');
}
export interface MinecraftWorldValidation {
  dataVersion: number;
  sha256: string;
  uncompressedBytes: number;
  versionName?: string;
}
/** Java big-endian level.dat only. Exact DataVersion comes from trusted release evidence, never semver. */
export function validateMinecraftLevelDat(
  input: Uint8Array,
  expectedDataVersion: number,
  options: { release?: string; limits?: Partial<MinecraftNbtLimits> } = {},
): MinecraftWorldValidation {
  if (!Number.isSafeInteger(expectedDataVersion) || expectedDataVersion < 1) fail('level_data');
  const inspected = inspectMinecraftLevelDat(input, options);
  if (inspected.dataVersion !== expectedDataVersion) fail('data_version');
  return inspected;
}
/** Bounded observation for trusted test evidence; this does not establish that a
 * caller-selected release is compatible with a different world's DataVersion. */
export function inspectMinecraftLevelDat(
  input: Uint8Array,
  options: { release?: string; limits?: Partial<MinecraftNbtLimits> } = {},
): MinecraftWorldValidation {
  const limits = nbtLimits(options.limits);
  if (input.byteLength < 4 || input.byteLength > limits.maxCompressedBytes) fail('level_data');
  const compressed = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let bytes: Buffer;
  try {
    bytes =
      compressed[0] === 0x1f && compressed[1] === 0x8b
        ? gunzipSync(compressed, { maxOutputLength: limits.maxUncompressedBytes })
        : compressed;
  } catch {
    return fail('nbt_compression');
  }
  if (bytes.byteLength > limits.maxUncompressedBytes) fail('nbt_size');
  preflightNbt(bytes, limits);
  let parsed: ReturnType<typeof parseUncompressed>;
  try {
    parsed = parseUncompressed(bytes, 'big');
  } catch {
    return fail('nbt_invalid');
  }
  const data = parsed.value.Data;
  if (data?.type !== 'compound') fail('level_data');
  const version = data.value.DataVersion;
  if (version?.type !== 'int' || version.value < 1) fail('data_version');
  const detailedVersion = data.value.Version;
  let versionName: string | undefined;
  if (detailedVersion) {
    if (detailedVersion.type !== 'compound') fail('data_version');
    const id = detailedVersion.value.Id;
    if (id && (id.type !== 'int' || id.value !== version.value)) fail('data_version');
    const name = detailedVersion.value.Name;
    if (name) {
      if (
        name.type !== 'string' ||
        name.value.length > 128 ||
        (options.release && name.value !== options.release)
      )
        fail('release_version');
      versionName = name.value;
    }
  }
  return {
    dataVersion: version.value,
    sha256: createHash('sha256').update(compressed).digest('hex'),
    uncompressedBytes: bytes.length,
    ...(versionName ? { versionName } : {}),
  };
}
async function fileDigest(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ sha256: string; size: number }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) fail('source_file');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024, signal })) {
    size += chunk.length;
    if (size > maxBytes) fail('source_file');
    hash.update(chunk);
  }
  if (size !== info.size) fail('source_changed');
  return { sha256: hash.digest('hex'), size };
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function writeExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function stageRoot(mountdataRoot: string, jobId: string): string {
  if (
    !isAbsolute(mountdataRoot) ||
    !resolve(mountdataRoot).split(sep).includes('mountdata') ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)
  )
    fail('stage_root');
  return join(resolve(mountdataRoot), 'world-staging', jobId);
}
export interface StagedMinecraftWorld {
  directory: string;
  planDigest: string;
  manifest: StagedContentFile[];
  validation: MinecraftWorldValidation & { release: string; levelDatSha256: string };
  targetWorld: string;
  archiveSha256: string;
}
export async function stageMinecraftWorld(
  archivePath: string,
  options: {
    mountdataRoot: string;
    /** Trusted source-store root may be a separate project-local mountdata subtree. */
    sourceRoot?: string;
    jobId: string;
    targetWorld: string;
    release: string;
    expectedDataVersion: number;
    archiveSha256: string;
    limits?: Partial<ContentLimits>;
    nbtLimits?: Partial<MinecraftNbtLimits>;
    diskPolicy?: ContentDiskPolicy;
    signal?: AbortSignal;
  },
): Promise<StagedMinecraftWorld> {
  const targetWorld = minecraftWorldName(options.targetWorld);
  const limits = contentLimits(options.limits);
  const metadataLimits = nbtLimits(options.nbtLimits);
  const job = stageRoot(options.mountdataRoot, options.jobId);
  const root = resolve(options.sourceRoot ?? options.mountdataRoot);
  if (
    !isAbsolute(options.sourceRoot ?? options.mountdataRoot) ||
    root === sep ||
    !root.split(sep).includes('mountdata') ||
    !options.release ||
    options.release.length > 128 ||
    !Number.isSafeInteger(options.expectedDataVersion) ||
    options.expectedDataVersion < 1 ||
    !/^[a-f0-9]{64}$/.test(options.archiveSha256) ||
    !isAbsolute(archivePath) ||
    !resolve(archivePath).startsWith(`${root}${sep}`)
  )
    fail('source');
  await contentStageDirectory(job);
  if ((await realpath(root)) !== root || (await realpath(archivePath)) !== resolve(archivePath))
    fail('source_symlink');
  const lockPath = join(job, '.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  const plan = {
    archiveSha256: options.archiveSha256,
    targetWorld,
    release: options.release,
    expectedDataVersion: options.expectedDataVersion,
  };
  const planDigest = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  try {
    options.signal?.throwIfAborted();
    if (
      (await fileDigest(archivePath, limits.maxArchiveBytes, options.signal)).sha256 !==
      options.archiveSha256
    )
      fail('archive_changed');
    const metadataPath = join(job, 'plan.json');
    if (await exists(metadataPath)) {
      const info = await lstat(metadataPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) fail('stage_plan');
      if (
        (JSON.parse(await readFile(metadataPath, 'utf8')) as { planDigest?: string }).planDigest !==
        planDigest
      )
        fail('stage_plan_conflict');
    } else await writeExclusive(metadataPath, { planDigest, plan });
    const inventory: { path: string; size: number; compressedSize: number; type: 'file' }[] = [];
    await visitArchive(
      archivePath,
      async (file) => {
        options.signal?.throwIfAborted();
        inventory.push({
          path: file.path,
          size: file.size,
          compressedSize: file.entry.compressedSize,
          type: 'file',
        });
      },
      limits,
    );
    // Ephemeral locks are deliberately omitted from promotion, but remain covered by ZIP validation/hash.
    const withoutLocks = inventory.filter((entry) => !/(^|\/)session\.lock$/.test(entry.path));
    const world = planMinecraftWorldImport(withoutLocks, {
      targetWorld,
      maxBytes: limits.maxExpandedBytes,
      maxEntries: limits.maxEntries,
      maxExpansionRatio: limits.maxCompressionRatio,
    });
    const level = world.files.find((file) => file.target === `${targetWorld}/level.dat`);
    if (!level || level.size > metadataLimits.maxCompressedBytes) fail('level_data');
    await assertContentDiskSpace(job, world.totalBytes, options.diskPolicy);
    const directory = join(job, 'files');
    await contentStageDirectory(directory);
    const expected = new Map(world.files.map((file) => [file.source, file]));
    const manifest: StagedContentFile[] = [];
    await visitArchive(
      archivePath,
      async (file) => {
        const planned = expected.get(file.path);
        if (!planned) return;
        options.signal?.throwIfAborted();
        if (planned.size !== file.size) fail('archive_changed');
        const target = join(directory, planned.target);
        await contentStageDirectory(dirname(target));
        await assertContentDiskSpace(job, file.size, options.diskPolicy);
        const temporary = join(job, `.extract-${randomUUID()}`);
        let size = 0;
        let checksum = 0;
        const hash = createHash('sha256');
        try {
          await pipeline(
            await file.open(),
            new Transform({
              highWaterMark: 64 * 1024,
              transform(chunk: Buffer, _encoding, callback) {
                size += chunk.length;
                if (size > file.size) {
                  callback(new Error('world_archive_size'));
                  return;
                }
                hash.update(chunk);
                checksum = crc32(chunk, checksum);
                callback(null, chunk);
              },
            }),
            createWriteStream(temporary, { flags: 'wx', mode: 0o600, highWaterMark: 64 * 1024 }),
            { signal: options.signal },
          );
          const sha256 = hash.digest('hex');
          if (size !== file.size || checksum !== file.entry.crc32) fail('archive_integrity');
          if (await exists(target)) {
            const previous = await fileDigest(target, limits.maxFileBytes, options.signal);
            if (previous.size !== size || previous.sha256 !== sha256)
              fail('stage_existing_mismatch');
          } else await rename(temporary, target);
          manifest.push({ path: planned.target, size, sha256, source: 'override' });
          expected.delete(file.path);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      limits,
    );
    if (
      expected.size ||
      (await fileDigest(archivePath, limits.maxArchiveBytes, options.signal)).sha256 !==
        options.archiveSha256
    )
      fail('archive_changed');
    const levelPath = join(directory, targetWorld, 'level.dat');
    const levelInfo = await lstat(levelPath);
    if (
      !levelInfo.isFile() ||
      levelInfo.isSymbolicLink() ||
      levelInfo.size > metadataLimits.maxCompressedBytes
    )
      fail('level_data');
    const validation = validateMinecraftLevelDat(
      await readFile(levelPath),
      options.expectedDataVersion,
      { release: options.release, limits: metadataLimits },
    );
    const result: StagedMinecraftWorld = {
      directory,
      planDigest,
      manifest,
      validation: { ...validation, release: options.release, levelDatSha256: validation.sha256 },
      targetWorld,
      archiveSha256: options.archiveSha256,
    };
    const temporaryManifest = join(job, `.manifest-${randomUUID()}`);
    await writeExclusive(temporaryManifest, {
      planDigest,
      manifest,
      validation: result.validation,
    });
    await rename(temporaryManifest, join(job, 'manifest.json'));
    return result;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
/** A crash-left lock is never removed using PID or time guesses. Core must establish exclusive DB job ownership. */
export async function recoverMinecraftWorldStageLock(options: {
  mountdataRoot: string;
  jobId: string;
  expectedPlanDigest: string;
  assertExclusiveJob: () => Promise<void>;
}): Promise<void> {
  const job = stageRoot(options.mountdataRoot, options.jobId);
  await options.assertExclusiveJob();
  await contentStageDirectory(job);
  const path = join(job, 'plan.json');
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 8192 ||
    (JSON.parse(await readFile(path, 'utf8')) as { planDigest?: string }).planDigest !==
      options.expectedPlanDigest
  )
    fail('stage_plan');
  const lock = join(job, '.lock');
  if (await exists(lock)) {
    const info = await lstat(lock);
    if (!info.isFile() || info.isSymbolicLink()) fail('stage_lock');
    await rm(lock);
  }
}
export function planMinecraftWorldReplacement(
  target: string,
  exists: boolean,
  consent?: { wipeConsent: true; expectedDeletePaths: readonly string[]; backupBefore: boolean },
): {
  targetWorld: string;
  deletePaths: readonly string[];
  backupBefore: boolean;
  requiresStoppedServer: true;
} {
  const targetWorld = minecraftWorldName(target);
  if (
    exists &&
    (consent?.wipeConsent !== true ||
      consent.expectedDeletePaths.length !== 1 ||
      consent.expectedDeletePaths[0] !== targetWorld)
  )
    fail('replacement_consent');
  if (!exists && consent) fail('replacement_changed');
  return {
    targetWorld,
    deletePaths: exists ? [targetWorld] : [],
    backupBefore: consent?.backupBefore ?? false,
    requiresStoppedServer: true,
  };
}
export interface MinecraftWorldDiscovery {
  name: string;
  status: 'verified' | 'incompatible' | 'unavailable';
  validation?: MinecraftWorldValidation;
}
/** Capability-limited remote services are provided by Core after managed-server authorization. */
export async function discoverMinecraftWorlds(
  services: {
    listRoot(): Promise<readonly { name: string; isDirectory: boolean; isSymlink?: boolean }[]>;
    readLevelDat(world: string, maxBytes: number): Promise<Uint8Array | undefined>;
  },
  options: {
    expectedDataVersion: number;
    release: string;
    maxWorlds?: number;
    nbtLimits?: Partial<MinecraftNbtLimits>;
  },
): Promise<MinecraftWorldDiscovery[]> {
  const limits = nbtLimits(options.nbtLimits);
  const maxWorlds = options.maxWorlds ?? 100;
  if (!Number.isSafeInteger(maxWorlds) || maxWorlds < 1 || maxWorlds > 1000)
    fail('discovery_limits');
  const entries = await services.listRoot();
  if (entries.length > 10_000) fail('discovery_limits');
  const worlds: MinecraftWorldDiscovery[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory || entry.isSymlink) continue;
    let name: string;
    try {
      name = minecraftWorldName(entry.name);
    } catch {
      continue;
    }
    if (++scanned > maxWorlds) fail('discovery_limits');
    if (seen.has(name.toLowerCase())) fail('discovery_duplicate');
    seen.add(name.toLowerCase());
    let bytes: Uint8Array | undefined;
    try {
      bytes = await services.readLevelDat(name, limits.maxCompressedBytes);
    } catch {
      worlds.push({ name, status: 'unavailable' });
      continue;
    }
    if (!bytes) continue;
    try {
      worlds.push({
        name,
        status: 'verified',
        validation: validateMinecraftLevelDat(bytes, options.expectedDataVersion, {
          release: options.release,
          limits,
        }),
      });
    } catch {
      worlds.push({ name, status: 'incompatible' });
    }
  }
  return worlds;
}
