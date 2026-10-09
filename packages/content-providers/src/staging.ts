import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import { inspectJarSide, visitArchive } from './archive.js';
import {
  type ContentHttp,
  type ContentLimits,
  type ContentPlan,
  contentLimits,
  fail,
  type StagedContent,
  type StagedContentFile,
  validateContentPlan,
} from './contracts.js';
import { assertContentDiskSpace, type ContentDiskPolicy } from './disk.js';

export function contentPlanDigest(input: ContentPlan): string {
  return createHash('sha256')
    .update(JSON.stringify(validateContentPlan(input)))
    .digest('hex');
}
export async function contentStageDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) fail('stage_root');
  const parts = resolve(path).split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('stage_symlink');
  }
}
async function digestFile(path: string): Promise<{ sha256: string; size: number }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail('stage_file');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
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
async function assertJar(
  path: string,
  declared: 'required' | 'optional' | 'unknown',
  limits: Partial<ContentLimits>,
): Promise<void> {
  const side = await inspectJarSide(path, limits);
  if (side === 'client' || (side === 'unknown' && declared === 'unknown'))
    fail('client_or_unknown_content');
}
export async function stageContent(
  input: ContentPlan,
  options: {
    mountdataRoot: string;
    jobId: string;
    archivePath?: string;
    http: ContentHttp;
    signal?: AbortSignal;
    limits?: Partial<ContentLimits>;
    diskPolicy?: ContentDiskPolicy;
  },
): Promise<StagedContent> {
  const plan = validateContentPlan(input);
  const limits = contentLimits(options.limits);
  const planDigest = contentPlanDigest(plan);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.jobId) || !isAbsolute(options.mountdataRoot))
    fail('stage_job');
  const root = resolve(options.mountdataRoot);
  if (root === sep || !root.split(sep).includes('mountdata')) fail('stage_root');
  await contentStageDirectory(root);
  if ((await realpath(root)) !== root) fail('stage_root');
  const parent = join(root, 'content-staging');
  await contentStageDirectory(parent);
  const job = join(parent, options.jobId);
  await contentStageDirectory(job);
  const lockPath = join(job, '.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  const manifest: StagedContentFile[] = [];
  try {
    const metadataPath = join(job, 'plan.json');
    if (await exists(metadataPath)) {
      const info = await lstat(metadataPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxMetadataBytes)
        fail('stage_plan');
      const previous = JSON.parse(await readFile(metadataPath, 'utf8')) as { planDigest?: string };
      if (previous.planDigest !== planDigest) fail('stage_plan_conflict');
    } else {
      await readWriteExclusive(metadataPath, JSON.stringify({ planDigest, plan }));
    }
    const files = join(job, 'files');
    await contentStageDirectory(files);
    const total = [...plan.artifacts, ...plan.overrides].reduce((sum, file) => sum + file.size, 0);
    if (
      total > limits.maxExpandedBytes ||
      plan.artifacts.length + plan.overrides.length > limits.maxEntries ||
      [...plan.artifacts, ...plan.overrides].some((f) => f.size > limits.maxFileBytes)
    )
      fail('stage_budget');
    await assertContentDiskSpace(job, total, options.diskPolicy);
    for (const artifact of plan.artifacts) {
      options.signal?.throwIfAborted();
      const target = join(files, artifact.path);
      await contentStageDirectory(dirname(target));
      // Recovered files are verified against source hashes, never trusted by presence.
      if (await exists(target)) {
        const actual = await digestFile(target);
        if (actual.size !== artifact.size) fail('stage_existing_mismatch');
        const hashes = Object.fromEntries(
          Object.keys(artifact.hashes).map((name) => [name, createHash(name)]),
        );
        for await (const chunk of createReadStream(target))
          for (const hash of Object.values(hashes)) hash.update(chunk);
        if (
          Object.entries(hashes).some(
            ([name, hash]) =>
              hash.digest('hex') !== artifact.hashes[name as keyof typeof artifact.hashes],
          )
        )
          fail('stage_existing_mismatch');
        if (target.endsWith('.jar')) await assertJar(target, artifact.serverSide, limits);
        manifest.push({ path: artifact.path, ...actual, source: 'download' });
        continue;
      }
      await assertContentDiskSpace(job, artifact.size, options.diskPolicy);
      const temporary = join(job, `.download-${randomUUID()}`);
      try {
        const reported = await options.http.download(artifact, temporary, {
          signal: options.signal,
        });
        const actual = await digestFile(temporary);
        if (
          actual.size !== artifact.size ||
          reported.sha256 !== actual.sha256 ||
          reported.size !== actual.size
        )
          fail('download_integrity');
        // ContentHttp is capability-injected: independently validate every required digest here too.
        const hashes = Object.fromEntries(
          Object.keys(artifact.hashes).map((name) => [name, createHash(name)]),
        );
        for await (const chunk of createReadStream(temporary))
          for (const hash of Object.values(hashes)) hash.update(chunk);
        if (
          Object.entries(hashes).some(
            ([name, hash]) =>
              hash.digest('hex') !== artifact.hashes[name as keyof typeof artifact.hashes],
          )
        )
          fail('download_hash');
        if (target.endsWith('.jar')) await assertJar(temporary, artifact.serverSide, limits);
        await rename(temporary, target);
        manifest.push({ path: artifact.path, ...actual, source: 'download' });
      } finally {
        await rm(temporary, { force: true });
      }
    }
    if (plan.overrides.length) {
      if (!options.archivePath) fail('archive_required');
      const wanted = new Map(plan.overrides.map((f) => [f.archivePath, f]));
      await visitArchive(
        options.archivePath,
        async (file) => {
          const expected = wanted.get(file.path);
          if (!expected) return;
          options.signal?.throwIfAborted();
          if (file.size !== expected.size) fail('archive_changed');
          const target = join(files, expected.path);
          await contentStageDirectory(dirname(target));
          if (await exists(target)) {
            const actual = await digestFile(target);
            if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
              fail('stage_existing_mismatch');
            if (target.endsWith('.jar')) await assertJar(target, 'unknown', limits);
            manifest.push({ path: expected.path, ...actual, source: 'override' });
            wanted.delete(file.path);
            return;
          }
          await assertContentDiskSpace(job, file.size, options.diskPolicy);
          const temporary = join(job, `.override-${randomUUID()}`);
          const hash = createHash('sha256');
          let size = 0;
          let checksum = 0;
          try {
            await pipeline(
              await file.open(),
              new Transform({
                transform(chunk: Buffer, _enc, callback) {
                  size += chunk.length;
                  if (size > file.size) {
                    callback(new Error('archive_size'));
                    return;
                  }
                  hash.update(chunk);
                  checksum = crc32(chunk, checksum);
                  callback(null, chunk);
                },
              }),
              createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
              { signal: options.signal },
            );
            const sha256 = hash.digest('hex');
            if (size !== file.size || sha256 !== expected.sha256 || checksum !== file.entry.crc32)
              fail('archive_changed');
            if (target.endsWith('.jar')) await assertJar(temporary, 'unknown', limits);
            await rename(temporary, target);
            manifest.push({ path: expected.path, sha256, size, source: 'override' });
            wanted.delete(file.path);
          } finally {
            await rm(temporary, { force: true });
          }
        },
        limits,
      );
      if (wanted.size) fail('archive_changed');
    }
    const manifestPath = join(job, `.manifest-${randomUUID()}`);
    await readWriteExclusive(manifestPath, JSON.stringify({ planDigest, manifest }));
    await rename(manifestPath, join(job, 'manifest.json'));
    return { directory: files, planDigest, manifest };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
async function readWriteExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Only the coordinator, after proving the DB job is not running, may clear a crash-left lock. */
export async function recoverContentStageLock(options: {
  mountdataRoot: string;
  jobId: string;
  expectedPlanDigest: string;
  assertExclusiveJob: () => Promise<void>;
}): Promise<void> {
  if (
    !isAbsolute(options.mountdataRoot) ||
    !resolve(options.mountdataRoot).split(sep).includes('mountdata') ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(options.jobId)
  )
    fail('stage_job');
  await options.assertExclusiveJob();
  const job = join(resolve(options.mountdataRoot), 'content-staging', options.jobId);
  await contentStageDirectory(job);
  const path = join(job, 'plan.json');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail('stage_plan');
  if (info.size > 8 * 1024 ** 2) fail('stage_plan');
  if (
    (JSON.parse(await readFile(path, 'utf8')) as { planDigest?: string }).planDigest !==
    options.expectedPlanDigest
  )
    fail('stage_plan_conflict');
  const lockPath = join(job, '.lock');
  if (await exists(lockPath)) {
    const lock = await lstat(lockPath);
    if (!lock.isFile() || lock.isSymbolicLink()) fail('stage_lock');
    await rm(lockPath);
  }
}
