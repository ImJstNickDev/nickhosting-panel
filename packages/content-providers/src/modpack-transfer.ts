import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { fail, safeArchivePath } from './contracts.js';
import { assertModpackPaths } from './modpack-paths.js';
import type { ModpackStagedFile } from './modpack-staging.js';
import { contentStageDirectory } from './staging.js';

export interface ModpackTransferArchive {
  archivePath: string;
  archiveBytes: number;
  archiveSha256: string;
  expandedBytes: number;
  /** ZIP member paths already include the hidden remote staging root. */
  files: ModpackStagedFile[];
}
export interface ModpackTransferOptions {
  directory: string;
  files: readonly ModpackStagedFile[];
  /** A coordinator-generated hidden top-level directory; never a browser/provider path. */
  stagingRoot: string;
  destination: string;
  signal?: AbortSignal;
}

/**
 * Reuses the prepared file seals, writing each selected file once into a STORE ZIP.
 * No provider request, archive rescan, recompression or second disk pass. File seals
 * are verified during the mandatory ZIP read, before publication can begin.
 * The private attempt directory remains immutable until publication/cleanup completes.
 */
export async function buildModpackTransferArchive(
  options: ModpackTransferOptions,
): Promise<ModpackTransferArchive | null> {
  options.signal?.throwIfAborted();
  if (!options.files.length) return null;
  if (
    options.files.length > 10000 ||
    !/^\.nickhosting-pack-[A-Za-z0-9_-]{1,128}-stage$/.test(options.stagingRoot)
  )
    fail('modpack_transfer');
  safeArchivePath(options.stagingRoot);
  assertModpackPaths(options.files.map((file) => file.path));
  let expandedBytes = 0;
  const files = options.files.map((file) => {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))
      fail('modpack_transfer');
    expandedBytes += file.size;
    return {
      path: safeArchivePath(`${options.stagingRoot}/${file.path}`),
      size: file.size,
      sha256: file.sha256,
    };
  });
  if (
    !Number.isSafeInteger(expandedBytes) ||
    !isAbsolute(options.directory) ||
    !isAbsolute(options.destination)
  )
    fail('modpack_transfer');
  const directory = resolve(options.directory);
  // Only the new output's parent may be created. A missing source is never recreated.
  if ((await realpath(directory)) !== directory) fail('stage_symlink');
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('stage_symlink');
  const destination = resolve(options.destination);
  if (destination === directory || destination.startsWith(`${directory}${sep}`))
    fail('modpack_transfer_destination');
  await contentStageDirectory(dirname(destination));
  const checked = new Set<string>([directory]);
  const checkDirectory = async (path: string): Promise<void> => {
    if (checked.has(path)) return;
    const inside = relative(directory, path);
    if (inside.startsWith('..') || isAbsolute(inside)) fail('stage_symlink');
    await checkDirectory(dirname(path));
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('stage_symlink');
    checked.add(path);
  };
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  let active: Readable | undefined;
  const abort = () => {
    const error =
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error('modpack_transfer_cancelled');
    active?.destroy(error);
    output.destroy(error);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  zip.on('error', (error: Error) => {
    active?.destroy(error);
    output.destroy(error);
  });
  let archiveBytes = 0;
  const hash = createHash('sha256');
  const outputFile = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  let created = false;
  outputFile.once('open', () => {
    created = true;
  });
  const completion = pipeline(
    output,
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        archiveBytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    outputFile,
    { signal: options.signal },
  );
  // Observe immediately: lazy source opening may fail before the final await below.
  void completion.catch(() => {});
  try {
    for (const [index, file] of options.files.entries()) {
      zip.addReadStreamLazy(
        files[index]?.path as string,
        {
          compress: false,
          size: file.size,
          mode: 0o100644,
          mtime: new Date('2000-01-01T00:00:00Z'),
        },
        (callback) => {
          void (async () => {
            options.signal?.throwIfAborted();
            const path = join(directory, file.path);
            await checkDirectory(dirname(path));
            if (output.destroyed) throw new Error('modpack_transfer_cancelled');
            const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const info = await handle.stat();
              if (output.destroyed) throw new Error('modpack_transfer_cancelled');
              if (!info.isFile() || info.size !== file.size) fail('stage_file');
              const source = handle.createReadStream({
                autoClose: true,
                highWaterMark: 256 * 1024,
                signal: options.signal,
              });
              const fileHash = createHash('sha256');
              let size = 0;
              const verified = new Transform({
                transform(chunk: Buffer, _encoding, done) {
                  size += chunk.length;
                  fileHash.update(chunk);
                  done(size > file.size ? new Error('stage_file_changed') : null, chunk);
                },
                flush(done) {
                  done(
                    size !== file.size || fileHash.digest('hex') !== file.sha256
                      ? new Error('stage_file_changed')
                      : null,
                  );
                },
              });
              active = verified;
              void pipeline(source, verified, { signal: options.signal }).catch(
                (error: unknown) => {
                  const failure = error instanceof Error ? error : new Error('stage_file_changed');
                  verified.destroy(failure);
                  output.destroy(failure);
                },
              );
              callback(null, active);
            } catch (error) {
              await handle.close();
              throw error;
            }
          })().catch((error: unknown) => callback(error, undefined as never));
        },
      );
    }
    zip.end();
    await completion;
    options.signal?.throwIfAborted();
    return {
      archivePath: destination,
      archiveBytes,
      archiveSha256: hash.digest('hex'),
      expandedBytes,
      files,
    };
  } catch (error) {
    active?.destroy();
    output.destroy();
    await completion.catch(() => {});
    if (created) await rm(destination, { force: true });
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}
