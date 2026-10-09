import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { type ContentHttp, type ContentLimits, type ContentPlan, fail } from './contracts.js';
import { assertContentDiskSpace, type ContentDiskPolicy } from './disk.js';
import { inspectModpack } from './modpack.js';
import type { ModrinthProvider } from './modrinth.js';
import { contentStageDirectory } from './staging.js';

/** Acquisition is staging, not server installation; callers still verify runtime and durable job authorization. */
export async function acquireModrinthModpack(
  provider: ModrinthProvider,
  projectId: string,
  versionId: string,
  options: {
    mountdataRoot: string;
    jobId: string;
    http: ContentHttp;
    signal?: AbortSignal;
    limits?: Partial<ContentLimits>;
    diskPolicy?: ContentDiskPolicy;
    assertExclusiveJob?: () => Promise<void>;
  },
): Promise<{ archivePath: string; plan: ContentPlan }> {
  if (
    !isAbsolute(options.mountdataRoot) ||
    !resolve(options.mountdataRoot).split(sep).includes('mountdata') ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(options.jobId)
  )
    fail('stage_job');
  const artifact = await provider.modpackArchive(projectId, versionId);
  const identity = createHash('sha256')
    .update(
      JSON.stringify({
        projectId: artifact.projectId,
        versionId: artifact.versionId,
        hashes: artifact.hashes,
        size: artifact.size,
      }),
    )
    .digest('hex');
  const directory = join(resolve(options.mountdataRoot), 'content-inputs', options.jobId);
  await contentStageDirectory(directory);
  const lockPath = join(directory, '.lock');
  // Durable workers may recover a lock left by a killed process only while holding
  // the authoritative database job lease. Never infer this from PID/mtime alone.
  if (options.assertExclusiveJob) {
    await options.assertExclusiveJob();
    try {
      const info = await lstat(lockPath);
      if (!info.isFile() || info.isSymbolicLink()) fail('stage_lock');
      await rm(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const lock = await open(lockPath, 'wx', 0o600);
  const archivePath = join(directory, `${identity}.mrpack`);
  const temporary = join(directory, `.download-${randomUUID()}`);
  try {
    let existing = false;
    try {
      const info = await lstat(archivePath);
      if (!info.isFile() || info.isSymbolicLink()) fail('stage_file');
      existing = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!existing) {
      await assertContentDiskSpace(directory, artifact.size, options.diskPolicy);
      await options.http.download(artifact, temporary, { signal: options.signal });
    }
    const source = existing ? archivePath : temporary;
    let size = 0;
    const hashes = Object.fromEntries(
      Object.keys(artifact.hashes).map((name) => [name, createHash(name)]),
    );
    for await (const chunk of createReadStream(source)) {
      size += chunk.length;
      if (size > artifact.size) fail('download_size');
      for (const hash of Object.values(hashes)) hash.update(chunk);
    }
    if (
      size !== artifact.size ||
      Object.entries(hashes).some(
        ([name, hash]) =>
          hash.digest('hex') !== artifact.hashes[name as keyof typeof artifact.hashes],
      )
    )
      fail('download_hash');
    const plan = await inspectModpack(source, { limits: options.limits });
    if (!existing) await rename(temporary, archivePath);
    return { archivePath, plan };
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
