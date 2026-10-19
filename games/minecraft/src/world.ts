import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, gunzipSync } from 'node:zlib';
import {
  assertContentDiskSpace,
  type ContentDiskPolicy,
  type ContentFileVerification,
  type ContentLimits,
  contentFileUnchanged,
  contentLimits,
  contentStageDirectory,
  readArchiveFile,
  type StagedContentFile,
  visitArchive,
} from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';
import { parseUncompressed } from 'prismarine-nbt';
import { minecraftWorldName, planMinecraftWorldImport } from './management.js';
import {
  assessMinecraftWorldCompatibility,
  identifyMinecraftWorldRelease,
} from './world-version.js';

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
  dataVersion?: number;
  sha256: string;
  uncompressedBytes: number;
  /** Literal saved display name, not necessarily the release ID. */
  versionName?: string;
  detectedRelease?: string;
  storageVersion?: number;
  versionSeries?: string;
  snapshot?: boolean;
  versionHistory?: number[];
}
/** Java big-endian level.dat only. Exact DataVersion comes from integration release metadata, never semver. */
export function validateMinecraftLevelDat(
  input: Uint8Array,
  expectedDataVersion: number,
  options: { release?: string; expectedSeries?: string; limits?: Partial<MinecraftNbtLimits> } = {},
): MinecraftWorldValidation & { dataVersion: number } {
  if (!Number.isSafeInteger(expectedDataVersion) || expectedDataVersion < 1) fail('level_data');
  const inspected = inspectMinecraftLevelDat(input, options);
  if (
    assessMinecraftWorldCompatibility(inspected, { ...options, expectedDataVersion }) !==
      'verified' ||
    inspected.dataVersion === undefined
  )
    fail('data_version');
  return { ...inspected, dataVersion: inspected.dataVersion };
}
/** Bounded structural observation. A target release never changes source facts;
 * absent modern metadata is valid for recognized historical world formats. */
export function inspectMinecraftLevelDat(
  input: Uint8Array,
  options: { release?: string; limits?: Partial<MinecraftNbtLimits> } = {},
): MinecraftWorldValidation {
  const { data, bytes, compressed } = decodeMinecraftLevelData(input, options.limits);
  return inspectLevelData(data, bytes, compressed);
}

/** The same bounded NBT decoder serves world identity and saved datapack
 * selection; neither path maintains its own unbounded parser. */
function decodeMinecraftLevelData(input: Uint8Array, options?: Partial<MinecraftNbtLimits>) {
  const limits = nbtLimits(options);
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
  return { data, bytes, compressed };
}

/** Saved selection only. A running server may not yet have persisted its live
 * selection; callers must not present this as confirmation of a completed reload. */
export function inspectMinecraftDatapackSelection(
  input: Uint8Array,
): { enabled: string[]; disabled: string[] } | undefined {
  const { data } = decodeMinecraftLevelData(input);
  const packs = data.value.DataPacks;
  if (!packs) return undefined;
  if (packs.type !== 'compound') fail('datapack_selection');
  const read = (name: 'Enabled' | 'Disabled'): string[] => {
    const list = packs.value[name];
    if (list?.type !== 'list' || list.value.value.length > 4096) return fail('datapack_selection');
    if (list.value.value.length === 0) return [];
    if (list.value.type !== 'string') return fail('datapack_selection');
    const strings = list.value.value as string[];
    if (strings.some((id) => typeof id !== 'string' || id.length > 1024 || /\p{C}/u.test(id)))
      fail('datapack_selection');
    return strings;
  };
  return { enabled: read('Enabled'), disabled: read('Disabled') };
}

function inspectLevelData(
  data: ReturnType<typeof decodeMinecraftLevelData>['data'],
  bytes: Buffer,
  compressed: Buffer,
): MinecraftWorldValidation {
  const version = data.value.DataVersion;
  if (version && (version.type !== 'int' || version.value < 1)) fail('data_version');
  const storage = data.value.version;
  if (storage && (storage.type !== 'int' || storage.value < 1)) fail('storage_version');
  if (storage?.value === 19132 && version) fail('storage_version');
  // Alpha/early Beta lack a storage marker. Recognize their actual typed core
  // fields rather than treating any arbitrary Data compound as a world.
  const legacyShape =
    !storage &&
    data.value.RandomSeed?.type === 'long' &&
    data.value.Time?.type === 'long' &&
    ['SpawnX', 'SpawnY', 'SpawnZ'].every((key) => data.value[key]?.type === 'int');
  if (!version && storage?.value !== 19132 && storage?.value !== 19133 && !legacyShape)
    fail('level_data');
  const detailedVersion = data.value.Version;
  let versionName: string | undefined;
  let versionSeries: string | undefined;
  let snapshot: boolean | undefined;
  if (detailedVersion) {
    if (detailedVersion.type !== 'compound') fail('data_version');
    const id = detailedVersion.value.Id;
    if (id && (id.type !== 'int' || id.value < 1 || (version && id.value !== version.value)))
      fail('data_version');
    const name = detailedVersion.value.Name;
    if (name) {
      if (name.type !== 'string' || name.value.length > 128) fail('release_version');
      versionName = name.value;
    }
    const series = detailedVersion.value.Series;
    if (series) {
      if (series.type !== 'string' || !series.value || series.value.length > 128)
        fail('version_series');
      versionSeries = series.value;
    }
    const experimental = detailedVersion.value.Snapshot;
    if (experimental) {
      if (experimental.type !== 'byte' || ![0, 1].includes(experimental.value))
        fail('version_snapshot');
      snapshot = experimental.value === 1;
    }
  }
  let versionHistory: number[] | undefined;
  const history = data.value.version_history;
  if (history) {
    if (
      history.type !== 'list' ||
      (history.value.type !== 'int' &&
        !((history.value.type as string) === 'end' && history.value.value.length === 0)) ||
      history.value.value.length > 4096 ||
      history.value.value.some((value) => typeof value !== 'number' || value < 1)
    )
      fail('version_history');
    versionHistory = history.value.value as number[];
  }
  const detectedRelease = identifyMinecraftWorldRelease(version?.value, versionName, versionSeries);
  return {
    ...(version ? { dataVersion: version.value } : {}),
    sha256: createHash('sha256').update(compressed).digest('hex'),
    uncompressedBytes: bytes.length,
    ...(versionName ? { versionName } : {}),
    ...(detectedRelease ? { detectedRelease } : {}),
    ...(storage ? { storageVersion: storage.value } : {}),
    ...(versionSeries ? { versionSeries } : {}),
    ...(snapshot !== undefined ? { snapshot } : {}),
    ...(versionHistory ? { versionHistory } : {}),
  };
}
async function assertFileUnchanged(path: string, before: BigIntStats): Promise<void> {
  if (!(await contentFileUnchanged(path, before))) fail('archive_changed');
}
async function fileDigest(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ sha256: string; size: number; identity: BigIntStats }> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) fail('source_file');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024, signal })) {
    size += chunk.length;
    if (size > maxBytes) fail('source_file');
    hash.update(chunk);
  }
  if (BigInt(size) !== info.size) fail('source_changed');
  await assertFileUnchanged(path, info);
  return { sha256: hash.digest('hex'), size, identity: info };
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
  validation: MinecraftWorldValidation & { targetRelease: string; levelDatSha256: string };
  targetWorld: string;
  archiveSha256: string;
}

/** Select a world and decode only its metadata. Fileman's streaming archive
 * writer validates every selected member while copying its compressed bytes. */
export async function inspectMinecraftWorldTransfer(
  archivePath: string,
  options: {
    targetWorld: string;
    verifiedArchive: ContentFileVerification;
    limits?: Partial<ContentLimits>;
    nbtLimits?: Partial<MinecraftNbtLimits>;
  },
) {
  const limits = contentLimits(options.limits);
  const metadataLimits = nbtLimits(options.nbtLimits);
  if (options.verifiedArchive.path !== resolve(archivePath)) fail('source');
  await assertFileUnchanged(archivePath, options.verifiedArchive.identity);
  const entries: { path: string; size: number; compressedSize: number; type: 'file' }[] = [];
  await visitArchive(
    archivePath,
    async (file) => {
      entries.push({
        path: file.path,
        size: file.size,
        compressedSize: file.entry.compressedSize,
        type: 'file',
      });
    },
    limits,
  );
  const world = planMinecraftWorldImport(
    entries.filter((entry) => !/(^|\/)session\.lock$/.test(entry.path)),
    {
      targetWorld: minecraftWorldName(options.targetWorld),
      maxBytes: limits.maxExpandedBytes,
      maxEntries: limits.maxEntries,
      maxExpansionRatio: limits.maxCompressionRatio,
    },
  );
  const level = world.files.find((file) => file.target === `${options.targetWorld}/level.dat`);
  if (!level || level.size > metadataLimits.maxCompressedBytes) fail('level_data');
  let data: Buffer | undefined;
  await visitArchive(
    archivePath,
    async (file) => {
      if (file.path === level.source)
        data = await readArchiveFile(file, metadataLimits.maxCompressedBytes);
    },
    limits,
  );
  if (!data) fail('level_data');
  const validation = inspectMinecraftLevelDat(data, { limits: metadataLimits });
  await assertFileUnchanged(archivePath, options.verifiedArchive.identity);
  return { mappings: world.files.map(({ source, target }) => ({ source, target })), validation };
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
    expectedDataVersion?: number;
    archiveSha256: string;
    /** Trusted in-process source proof; never supplied by a request or persisted across jobs. */
    verifiedArchive?: ContentFileVerification;
    limits?: Partial<ContentLimits>;
    nbtLimits?: Partial<MinecraftNbtLimits>;
    diskPolicy?: ContentDiskPolicy;
    /** Reserve the validated expanded size once, before creating any extracted files. */
    reserve?: (expandedBytes: number) => Promise<void>;
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
    (options.expectedDataVersion !== undefined &&
      (!Number.isSafeInteger(options.expectedDataVersion) || options.expectedDataVersion < 1)) ||
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
    const verified = options.verifiedArchive;
    if (verified) {
      if (
        verified.path !== resolve(archivePath) ||
        verified.sha256 !== options.archiveSha256 ||
        !verified.identity.isFile() ||
        verified.identity.isSymbolicLink() ||
        verified.identity.size < 0n ||
        verified.identity.size > limits.maxArchiveBytes
      )
        fail('archive_changed');
      await assertFileUnchanged(archivePath, verified.identity);
    }
    const source =
      verified ?? (await fileDigest(archivePath, limits.maxArchiveBytes, options.signal));
    if (source.sha256 !== options.archiveSha256) fail('archive_changed');
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
    await options.reserve?.(world.totalBytes);
    options.signal?.throwIfAborted();
    await assertFileUnchanged(archivePath, source.identity);
    await assertContentDiskSpace(job, world.totalBytes, options.diskPolicy);
    const directory = join(job, 'files');
    await contentStageDirectory(directory);
    // This private, job-locked tree is verified once per directory, not from / for every file.
    const checkedDirectories = new Set([directory]);
    const ensureDirectory = async (path: string): Promise<void> => {
      if (checkedDirectories.has(path)) return;
      if (!path.startsWith(`${directory}${sep}`)) fail('stage_root');
      await ensureDirectory(dirname(path));
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('stage_symlink');
      checkedDirectories.add(path);
    };
    const expected = new Map(world.files.map((file) => [file.source, file]));
    const manifest: StagedContentFile[] = [];
    let extractedBytes = 0;
    let batchBytes = 0;
    let batchFiles = 0;
    let lastDiskCheck = performance.now();
    await visitArchive(
      archivePath,
      async (file) => {
        const planned = expected.get(file.path);
        if (!planned) return;
        options.signal?.throwIfAborted();
        if (planned.size !== file.size) fail('archive_changed');
        const target = join(directory, planned.target);
        await ensureDirectory(dirname(target));
        // Shared staging reservation covers the whole plan. Recheck host headroom at bounded
        // file/byte/time boundaries, rather than issuing statfs for each small chunk file.
        if (
          batchFiles >= 32 ||
          batchBytes >= 64 * 1024 ** 2 ||
          performance.now() - lastDiskCheck >= 1000
        ) {
          await assertContentDiskSpace(job, world.totalBytes - extractedBytes, options.diskPolicy);
          batchFiles = 0;
          batchBytes = 0;
          lastDiskCheck = performance.now();
        }
        const temporary = join(job, `.extract-${randomUUID()}`);
        let size = 0;
        let checksum = 0;
        const hash = createHash('sha256');
        try {
          await pipeline(
            await file.open({ inflateChunkSize: 256 * 1024 }),
            new Transform({
              highWaterMark: 256 * 1024,
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
            createWriteStream(temporary, { flags: 'wx', mode: 0o600, highWaterMark: 256 * 1024 }),
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
          extractedBytes += size;
          batchBytes += size;
          batchFiles++;
          expected.delete(file.path);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      limits,
    );
    if (expected.size) fail('archive_changed');
    // SHA256 was checked before inspection; per-file CRC/SHA256 protects extraction. A source
    // replacement or in-place edit invalidates the stage without a second whole-ZIP read.
    await assertFileUnchanged(archivePath, source.identity);
    const levelPath = join(directory, targetWorld, 'level.dat');
    const levelInfo = await lstat(levelPath);
    if (
      !levelInfo.isFile() ||
      levelInfo.isSymbolicLink() ||
      levelInfo.size > metadataLimits.maxCompressedBytes
    )
      fail('level_data');
    const validation = inspectMinecraftLevelDat(await readFile(levelPath), {
      limits: metadataLimits,
    });
    const result: StagedMinecraftWorld = {
      directory,
      planDigest,
      manifest,
      validation: {
        ...validation,
        targetRelease: options.release,
        levelDatSha256: validation.sha256,
      },
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
  requiresStoppedServer: boolean;
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
    requiresStoppedServer: exists,
  };
}
export interface MinecraftWorldDiscovery {
  name: string;
  status: 'verified' | 'incompatible' | 'unknown' | 'invalid' | 'unavailable';
  validation?: MinecraftWorldValidation;
}
/** Capability-limited remote services are provided by Core after managed-server authorization. */
export async function discoverMinecraftWorlds(
  services: {
    listRoot(): Promise<readonly { name: string; isDirectory: boolean; isSymlink?: boolean }[]>;
    readLevelDat(world: string, maxBytes: number): Promise<Uint8Array | undefined>;
  },
  options: {
    expectedDataVersion?: number;
    expectedSeries?: string;
    release: string;
    maxWorlds?: number;
    signal?: AbortSignal;
    nbtLimits?: Partial<MinecraftNbtLimits>;
  },
): Promise<MinecraftWorldDiscovery[]> {
  const limits = nbtLimits(options.nbtLimits);
  const maxWorlds = options.maxWorlds ?? 100;
  if (!Number.isSafeInteger(maxWorlds) || maxWorlds < 1 || maxWorlds > 1000)
    fail('discovery_limits');
  const entries = await services.listRoot();
  if (entries.length > 10_000) fail('discovery_limits');
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory || entry.isSymlink) continue;
    let name: string;
    try {
      name = minecraftWorldName(entry.name);
    } catch {
      continue;
    }
    if (candidates.length >= maxWorlds) fail('discovery_limits');
    if (seen.has(name.toLowerCase())) fail('discovery_duplicate');
    seen.add(name.toLowerCase());
    candidates.push(name);
  }
  // Two bounded readers preserve provider order without retaining every level.dat.
  const worlds: (MinecraftWorldDiscovery | undefined)[] = new Array(candidates.length);
  let next = 0;
  let rejected = false;
  const read = async () => {
    for (;;) {
      if (rejected) return;
      options.signal?.throwIfAborted();
      const index = next++;
      const name = candidates[index];
      if (name === undefined) return;
      let bytes: Uint8Array | undefined;
      try {
        bytes = await services.readLevelDat(name, limits.maxCompressedBytes);
      } catch (error) {
        options.signal?.throwIfAborted();
        // Revoked authorization is a request failure, never a partial inventory.
        if (
          error instanceof DomainError &&
          (error.status === 401 || error.status === 403 || error.code === 'provenance_mismatch')
        ) {
          rejected = true;
          throw error;
        }
        worlds[index] = { name, status: 'unavailable' };
        continue;
      }
      options.signal?.throwIfAborted();
      if (!bytes) continue;
      try {
        const validation = inspectMinecraftLevelDat(bytes, { limits });
        worlds[index] = {
          name,
          status: assessMinecraftWorldCompatibility(validation, options),
          validation,
        };
      } catch {
        worlds[index] = { name, status: 'invalid' };
      }
    }
  };
  // Settle both readers before propagating errors, so no remote reads outlive this call.
  const results = await Promise.allSettled([read(), read()]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return worlds.filter((world): world is MinecraftWorldDiscovery => world !== undefined);
}
