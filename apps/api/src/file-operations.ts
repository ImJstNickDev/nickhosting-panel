import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createGunzip } from 'node:zlib';
import {
  assertContentDiskSpace,
  type ContentDiskPolicy,
  contentStageDirectory,
  safeArchivePath,
  visitArchive,
} from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';
import { getSettings, recordAudit } from '@nickhosting/database';
import {
  type PterodactylAdapter,
  relativePath,
  type ServerFile,
} from '@nickhosting/pterodactyl-adapter';
import {
  assertServerStorageCapacity,
  getPlatformTransfers,
  parse,
  reserveUploadIngestion,
  type UploadTiming,
} from '@nickhosting/server-management';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Variables } from './app.js';
import { inspectFilePath } from './file-browsing.js';
import { createFileDirectoryPlan, fileDirectoryAncestors } from './file-directory-plan.js';
import { createFileOperationTrace } from './file-operation-trace.js';
import type { ServerRouteOptions } from './servers.js';

export const extractFormats = [
  'zip',
  'jar',
  'tar',
  'tar.gz',
  'tgz',
  'tar.bz2',
  'tar.xz',
  'tar.zst',
  '7z',
  'rar',
] as const;
const maxEntries = 20_000;
const maxDepth = 64;
const maxArchiveBytes = 8 * 1024 ** 3;
const maxExpandedBytes = 16 * 1024 ** 3;
const maxCompressionRatio = 500;
const pathJoin = (...parts: string[]) => parts.filter(Boolean).join('/');
function clean(value: string, root = false) {
  return relativePath(value, root).slice(1);
}
function child(value: string) {
  const path = clean(value);
  if (path.includes('/')) throw new DomainError('validation_failed');
  return path;
}
function badArchive(reason: string): never {
  throw new DomainError('validation_failed', 400, { fileReason: reason });
}
export interface CopyEntry {
  path: string;
  source: string;
  size: number;
  directory: boolean;
}

/** Provider batches are bounded; the complete request is validated before this runs. */
export async function applyFileChunks<T>(
  entries: T[],
  authorize: () => Promise<void>,
  apply: (chunk: T[]) => Promise<void>,
) {
  let completed = 0;
  let dispatched = false;
  try {
    for (let offset = 0; offset < entries.length; offset += 1000) {
      dispatched = false;
      await authorize();
      const chunk = entries.slice(offset, offset + 1000);
      dispatched = true;
      await apply(chunk);
      completed += chunk.length;
    }
  } catch (error) {
    if (!completed && !dispatched) throw error;
    // The failing chunk can itself be partial: never offer to replay the full selection.
    throw new DomainError('operation_uncertain', 409, {
      completed,
      fileReason: 'partial_or_uncertain',
      cause: error instanceof DomainError ? error.code : 'provider_error',
    });
  }
}

function directoryIndex(entries: ServerFile[]) {
  const index = new Map<string, ServerFile[]>();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    const matches = index.get(key);
    if (matches) matches.push(entry);
    else index.set(key, [entry]);
  }
  return index;
}

/** Reuse listings and name indexes within one operation; never cache mutation results. */
function planningDirectory(list: (path: string) => Promise<ServerFile[]>) {
  const listings = new Map<string, Promise<ServerFile[]>>();
  const indexes = new Map<string, Promise<ReturnType<typeof directoryIndex>>>();
  const cached = (path: string) => {
    let pending = listings.get(path);
    if (!pending) {
      pending = list(path);
      listings.set(path, pending);
    }
    return pending;
  };
  return {
    list: cached,
    matches: async (path: string, name: string) => {
      let pending = indexes.get(path);
      if (!pending) {
        pending = cached(path).then(directoryIndex);
        indexes.set(path, pending);
      }
      return (await pending).get(name.toLowerCase()) ?? [];
    },
  };
}

function selectedAncestor(path: string, selected: ReadonlySet<string>, self = true) {
  let cursor = self ? path : path.slice(0, Math.max(0, path.lastIndexOf('/')));
  while (cursor) {
    if (selected.has(cursor)) return true;
    const slash = cursor.lastIndexOf('/');
    cursor = slash < 0 ? '' : cursor.slice(0, slash);
  }
  return false;
}

/** Duplicate or nested deletes can straddle chunks; reject them before any dispatch. */
export function validateFileDeletes(root: string, names: string[]) {
  root = clean(root, true);
  const paths = names.map((name) => pathJoin(root, clean(name)).toLowerCase());
  const selected = new Set(paths);
  if (
    selected.size !== paths.length ||
    paths.some((path) => selectedAncestor(path, selected, false))
  )
    throw new DomainError('validation_failed');
}

function assertCopyDestination(
  listing: ServerFile[] | ReturnType<typeof directoryIndex>,
  target: string,
  sourceIsFile: boolean,
  approved: ReadonlySet<string>,
) {
  const name = target.split('/').at(-1);
  const matches =
    listing instanceof Map
      ? (listing.get(name?.toLowerCase() ?? '') ?? [])
      : listing.filter((entry) => entry.name.toLowerCase() === name?.toLowerCase());
  if (
    matches.length > 0 &&
    (!approved.has(target) ||
      !sourceIsFile ||
      matches.length !== 1 ||
      matches[0]?.name !== name ||
      !matches[0]?.is_file ||
      matches[0]?.is_symlink)
  )
    throw new DomainError('conflict');
}

async function assertCopyDirectory(list: (path: string) => Promise<ServerFile[]>, path: string) {
  const parts = path.split('/').filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const matches = (await list(parts.slice(0, index).join('/'))).filter(
      (entry) => entry.name.toLowerCase() === parts[index]?.toLowerCase(),
    );
    if (
      matches.length !== 1 ||
      matches[0]?.name !== parts[index] ||
      matches[0]?.is_file ||
      matches[0]?.is_symlink
    )
      throw new DomainError('conflict');
  }
}

/** Enumerate the complete selection before the first destination mutation. */
export async function planFileCopy(
  list: (path: string) => Promise<ServerFile[]>,
  root: string,
  names: string[],
  destination: string,
  overwrite: string[] = [],
): Promise<CopyEntry[]> {
  root = clean(root, true);
  destination = clean(destination, true);
  list = planningDirectory(list).list;
  const selected = names.map(child);
  if (new Set(selected.map((name) => name.toLowerCase())).size !== selected.length)
    throw new DomainError('validation_failed');
  const approved = overwrite.map((path) => clean(path));
  const targetPaths = new Set(selected.map((name) => pathJoin(destination, name)));
  if (new Set(approved).size !== approved.length || approved.some((path) => !targetPaths.has(path)))
    throw new DomainError('validation_failed');
  const approvedTargets = new Set(approved);
  const sources = new Set(selected.map((name) => pathJoin(root, name).toLowerCase()));
  const targetsLower = new Set([...targetPaths].map((path) => path.toLowerCase()));
  if (
    [...targetsLower].some((target) => selectedAncestor(target, sources)) ||
    [...sources].some((source) => selectedAncestor(source, targetsLower))
  )
    throw new DomainError('conflict');
  for (const path of [root, destination]) await assertCopyDirectory(list, path);
  const targets = directoryIndex(await list(destination));
  const entries: CopyEntry[] = [];
  let bytes = 0;
  async function visit(source: string, target: string, entry: ServerFile, depth: number) {
    if (entry.is_symlink || depth > maxDepth || entries.length >= maxEntries)
      throw new DomainError('validation_failed');
    if (
      !entry.is_file &&
      destination !== '' &&
      (destination === source || destination.startsWith(`${source}/`))
    )
      throw new DomainError('validation_failed');
    bytes += entry.is_file ? entry.size : 0;
    if (!Number.isSafeInteger(bytes) || bytes > maxExpandedBytes)
      throw new DomainError('validation_failed', 413);
    entries.push({ path: target, source, size: entry.size, directory: !entry.is_file });
    if (!entry.is_file) {
      const children = await list(source);
      const seen = new Set<string>();
      for (const item of children) {
        const name = child(item.name);
        if (seen.has(name.toLowerCase())) throw new DomainError('conflict');
        seen.add(name.toLowerCase());
        await visit(pathJoin(source, name), pathJoin(target, name), item, depth + 1);
      }
    }
  }
  const source = directoryIndex(await list(root));
  for (const name of selected) {
    const matches = source.get(name.toLowerCase()) ?? [];
    if (matches.length !== 1 || matches[0]?.name !== name) throw new DomainError('conflict');
    const selected = matches[0];
    if (!selected) throw new DomainError('conflict');
    const target = pathJoin(destination, name);
    if (approvedTargets.has(target) && (!selected.is_file || selected.is_symlink))
      throw new DomainError('conflict');
    assertCopyDestination(targets, target, selected.is_file, approvedTargets);
    await visit(pathJoin(root, name), target, selected, 0);
  }
  return entries;
}

/** Batch renames are not transactional upstream. Reject predictable collisions before any effect. */
export async function validateFileMoves(
  adapter: Pick<PterodactylAdapter, 'listFiles'>,
  id: string,
  root: string,
  moves: { from: string; to: string }[],
  overwrite: string[] = [],
  timing?: UploadTiming,
) {
  root = clean(root, true);
  const planned = moves.map((move) => ({
    from: pathJoin(root, clean(move.from)),
    to: pathJoin(root, clean(move.to)),
  }));
  const approved = overwrite.map((target) => pathJoin(root, clean(target)));
  const exactTargets = new Set(planned.map((move) => move.to));
  if (
    new Set(approved).size !== approved.length ||
    approved.some((target) => !exactTargets.has(target))
  )
    throw new DomainError('validation_failed');
  const approvedTargets = new Set(approved);
  const sources = new Set<string>(),
    targets = new Set<string>();
  for (const move of planned) {
    const from = move.from.toLowerCase(),
      to = move.to.toLowerCase();
    if (from === to || to.startsWith(`${from}/`) || sources.has(from) || targets.has(to))
      throw new DomainError('conflict');
    sources.add(from);
    targets.add(to);
  }
  for (const target of targets)
    if (selectedAncestor(target, sources)) throw new DomainError('conflict');
  for (const source of sources)
    if (selectedAncestor(source, sources, false)) throw new DomainError('conflict');
  const directories = planningDirectory((path) =>
    timing
      ? timing.measure('move.listDirectory', () => adapter.listFiles(id, path))
      : adapter.listFiles(id, path),
  );
  async function inspect(path: string) {
    const parts = path.split('/');
    let entry: ServerFile | undefined;
    for (let index = 0; index < parts.length; index++) {
      const matches = await directories.matches(
        parts.slice(0, index).join('/'),
        parts[index] ?? '',
      );
      if (matches.length > 1) throw new DomainError('conflict');
      entry = matches[0];
      if (!entry || entry.name !== parts[index]) return undefined;
      if (entry.is_symlink || (index < parts.length - 1 && entry.is_file))
        throw new DomainError('forbidden');
    }
    return entry;
  }
  for (const move of planned) {
    const source = await inspect(move.from);
    if (!source) throw new DomainError('not_found');
    const parts = move.to.split('/');
    const name = parts.pop();
    const parent = parts.join('/');
    if (parent) {
      const directory = await inspect(parent);
      if (!directory || directory.is_file) throw new DomainError('conflict');
    }
    const existing = await directories.matches(parent, name ?? '');
    if (
      existing.length > 0 &&
      (!approvedTargets.has(move.to) ||
        existing.length !== 1 ||
        existing[0]?.name !== name ||
        !source.is_file ||
        !existing[0]?.is_file ||
        existing[0]?.is_symlink)
    )
      throw new DomainError('conflict');
  }
}

export interface StagedFile {
  path: string;
  size: number;
  local: string;
  directory?: boolean;
}
/** No archive entry is written remotely until all names, bytes and checksums validate. */
export async function stageFileArchive(
  archive: string,
  format: (typeof extractFormats)[number],
  stage: string,
  signal?: AbortSignal,
  diskPolicy: ContentDiskPolicy = {},
): Promise<StagedFile[]> {
  const files: StagedFile[] = [];
  const seen = new Map<string, 'file' | 'directory'>();
  let expanded = 0,
    count = 0;
  const archiveSize = (await lstat(archive)).size;
  if (archiveSize > maxArchiveBytes) badArchive('archive_too_large');
  function validate(name: string, size: number, directory = false) {
    const safe = safeArchivePath(name).replace(/\/$/, '');
    const parts = safe.split('/');
    const key = safe.toLowerCase();
    if (parts.length > maxDepth || seen.has(key) || !Number.isSafeInteger(size) || size < 0)
      badArchive('archive_entry');
    for (let i = 1; i < parts.length; i++) {
      if (seen.get(parts.slice(0, i).join('/').toLowerCase()) === 'file')
        badArchive('archive_conflict');
    }
    if (!directory && [...seen.keys()].some((path) => path.startsWith(`${key}/`)))
      badArchive('archive_conflict');
    seen.set(key, directory ? 'directory' : 'file');
    expanded += size;
    count++;
    if (
      count > maxEntries ||
      expanded > maxExpandedBytes ||
      expanded > Math.max(archiveSize, 1) * maxCompressionRatio
    )
      badArchive('archive_budget');
    return safe;
  }
  async function stageEntry(path: string, size: number, input: Readable, expectedCrc?: number) {
    signal?.throwIfAborted();
    const local = join(stage, path);
    await mkdir(dirname(local), { recursive: true, mode: 0o700 });
    await assertContentDiskSpace(stage, size, diskPolicy);
    let length = 0,
      checksum = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        length += chunk.length;
        if (length > size) return done(new Error('archive_size_mismatch'));
        if (expectedCrc !== undefined) checksum = crc32(chunk, checksum);
        done(null, chunk);
      },
    });
    await pipeline(input, guard, createWriteStream(local, { flags: 'wx', mode: 0o600 }), {
      signal,
    });
    if (length !== size || (expectedCrc !== undefined && checksum !== expectedCrc))
      badArchive('archive_integrity');
    files.push({ path, size, local });
  }
  try {
    if (format === 'zip' || format === 'jar') {
      await visitArchive(
        archive,
        async (entry) => {
          const path = validate(entry.path, entry.size);
          await stageEntry(path, entry.size, await entry.open(), entry.entry.crc32);
        },
        {
          maxArchiveBytes,
          maxExpandedBytes,
          maxFileBytes: maxArchiveBytes,
          maxEntries,
          maxCompressionRatio,
        },
        async (name) => {
          const path = validate(name, 0, true);
          files.push({ path, size: 0, local: '', directory: true });
        },
      );
    } else if (format === '7z' || format === 'rar') {
      // Reuse the bounded isolated decoder. Only temporary local files are touched;
      // the existing caller dispatches provider writes after the entire staging pass.
      const [{ createArchiveViewer }, { ViewerCache, cachedFileSource, viewerNodeReadable }] =
        await Promise.all([import('./viewer-archive.js'), import('./viewer-cache.js')]);
      const cacheRoot = await mkdtemp(join(dirname(stage), 'archive-decoder-'));
      const decoderBytes = 64 * 1024 ** 2;
      const cache = new ViewerCache({
        root: cacheRoot,
        maxFileBytes: decoderBytes,
        maxBytes: decoderBytes * 3,
      });
      let viewer: Awaited<ReturnType<typeof createArchiveViewer>> | undefined;
      try {
        await assertContentDiskSpace(stage, Math.min(archiveSize, decoderBytes), diskPolicy);
        viewer = await createArchiveViewer(cachedFileSource(archive, archiveSize, 0), {
          name: `source.${format}`,
          key: archive,
          cache,
          signal,
          limits: {
            maxEntries,
            maxEntryBytes: maxArchiveBytes,
            maxExpandedBytes,
            maxCompressionRatio,
          },
        });
        const entries: { path: string; size: number; directory: boolean }[] = [];
        const directories = [''];
        while (directories.length) {
          const directory = directories.pop() as string;
          let offset = 0;
          while (true) {
            const page = viewer.list({ directory, offset, limit: 200 });
            for (const entry of page.entries) {
              const path = validate(entry.path, entry.size, entry.directory);
              if (!entry.directory && entry.size > decoderBytes) badArchive('archive_budget');
              entries.push({ path, size: entry.size, directory: entry.directory });
              if (entry.directory) directories.push(path);
            }
            if (page.nextOffset === null) break;
            offset = page.nextOffset;
          }
        }
        for (const entry of entries) {
          if (entry.directory) files.push({ ...entry, local: '' });
          else {
            // One cached decoder output plus its staged copy may coexist.
            await assertContentDiskSpace(stage, entry.size * 2, diskPolicy);
            const opened = await viewer.open(entry.path, signal);
            await stageEntry(entry.path, entry.size, viewerNodeReadable(opened.stream));
          }
        }
      } finally {
        viewer?.close();
        await cache.close();
        await rm(cacheRoot, { recursive: true, force: true });
      }
    } else {
      const { extract } = await import('tar-stream');
      const parser = extract();
      parser.on('entry', (header, stream, next) => {
        stream.on('error', () => {});
        void (async () => {
          if (header.type !== 'file' && header.type !== 'directory')
            badArchive('archive_special_file');
          const path = validate(header.name, header.size ?? 0, header.type === 'directory');
          if (header.type === 'directory') {
            if (header.size) badArchive('archive_directory');
            files.push({ path, size: 0, local: '', directory: true });
            stream.resume();
          } else await stageEntry(path, header.size ?? 0, Readable.from(stream));
        })().then(
          () => next(),
          (error: Error) => {
            next(error);
          },
        );
      });
      const input = createReadStream(archive);
      let tarBytes = 0;
      const streamLimit = Math.min(
        maxExpandedBytes + maxEntries * 1024,
        Math.max(archiveSize * maxCompressionRatio, 1024 * 1024),
      );
      const expansionGuard = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          tarBytes += chunk.length;
          done(
            tarBytes > streamLimit
              ? new DomainError('validation_failed', 413, { fileReason: 'archive_budget' })
              : null,
            chunk,
          );
        },
      });
      if (format === 'tar') await pipeline(input, expansionGuard, parser, { signal });
      else if (format === 'tar.gz' || format === 'tgz')
        await pipeline(input, createGunzip(), expansionGuard, parser, { signal });
      else {
        // Keep TAR extraction streaming: share the viewer's codec without creating
        // a second full decoded TAR on disk just to stage its selected files.
        const [{ createTarDecoder }, { viewerNodeReadable }] = await Promise.all([
          import('./viewer-archive.js'),
          import('./viewer-cache.js'),
        ]);
        const decode = await createTarDecoder(format);
        await pipeline(
          viewerNodeReadable(decode(Readable.toWeb(input) as ReadableStream<Uint8Array>, signal)),
          expansionGuard,
          parser,
          { signal },
        );
      }
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (
      ['viewer_file_too_large', 'viewer_archive_budget', 'viewer_cache_busy'].includes(
        (error as { code?: string })?.code ?? '',
      )
    )
      badArchive('archive_budget');
    if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC')
      throw new DomainError('resources_unavailable');
    badArchive('archive_invalid');
  }
  return files;
}

async function body(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new DomainError('validation_failed');
  try {
    return await request.json();
  } catch {
    throw new DomainError('validation_failed');
  }
}
export function registerFileOperationRoutes(
  app: Hono<{ Variables: Variables }>,
  options: ServerRouteOptions,
) {
  const { db, env, principal, management } = options;
  app.get('/v1/servers/:id/files/capabilities', async (c) => {
    const context = await principal(c);
    const transfers = await getPlatformTransfers(db, context, c.req.param('id'), env);
    return c.json({
      copy: transfers.upload.available,
      extract: transfers.upload.available,
      extractFormats,
      zipDownload: transfers.download.available,
      reason: transfers.upload.reason,
    });
  });
  async function canWrite(serverId: string, context: Awaited<ReturnType<typeof principal>>) {
    const transfers = await getPlatformTransfers(db, context, serverId, env);
    if (!transfers.upload.available) {
      if (transfers.upload.reason === 'forbidden') throw new DomainError('forbidden');
      if (transfers.upload.reason === 'conflict') throw new DomainError('conflict');
      throw new DomainError('configuration_invalid', 409, { fileReason: transfers.upload.reason });
    }
    return transfers;
  }
  app.post('/v1/servers/:id/files/copy', async (c) => {
    const trace = createFileOperationTrace(c, options.logger, 'copy');
    const { timing } = trace;
    let outcome: 'succeeded' | 'failed' = 'failed';
    let response: Response | undefined;
    try {
      const raw = await timing.measure('copy.body', () => body(c.req.raw));
      const input = timing.measureSync('copy.parse', () =>
        parse(
          z.strictObject({
            root: z.string(),
            files: z.array(z.string()).min(1).max(maxEntries),
            destination: z.string(),
            overwrite: z.array(z.string()).max(maxEntries).optional(),
          }),
          raw,
        ),
      );
      const context = await timing.measure('copy.principal', () => principal(c)),
        serverId = c.req.param('id'),
        service = await timing.measure('copy.management', management);
      const transferLimits = await timing.measure('copy.canWrite', () =>
        canWrite(serverId, context),
      );
      const release = timing.measureSync('copy.acquireSlot', () => options.acquireUploadSlot());
      try {
        response = await timing.measure('copy.access', () =>
          service.fileMutationAccess(
            context,
            serverId,
            async (id, connection, current, server) => {
              const directories = createFileDirectoryPlan({
                batch: (paths) => service.fileDirectoryBatch(id, server, paths, c.req.raw.signal),
                single: (path) => service.adapter.listFiles(id, path),
                timing: trace.enabled ? timing : undefined,
              });
              await timing.measure('copy.directories', () =>
                directories.prime(
                  fileDirectoryAncestors([clean(input.root, true), clean(input.destination, true)]),
                ),
              );
              const entries = await timing.measure('copy.plan', () =>
                planFileCopy(
                  directories.list,
                  input.root,
                  input.files,
                  input.destination,
                  input.overwrite,
                ),
              );
              const approvedTargets = new Set(input.overwrite ?? []);
              if (
                entries.some(
                  (entry) =>
                    !entry.directory &&
                    entry.size > (transferLimits.upload.providerMaxFileBytes ?? 0),
                )
              )
                throw new DomainError('validation_failed', 413);
              await timing.measure('copy.planMutationCheck', () =>
                service.assertFileMutation(
                  serverId,
                  entries.map((entry) => entry.path),
                  connection,
                  { providerIdentifier: id, listFiles: directories.list },
                ),
              );
              const diskBytes = await timing.measure('copy.diskResources', () =>
                service.fileDiskUsage(server, id, trace.enabled ? timing : undefined),
              );
              assertServerStorageCapacity(
                server.limits.disk,
                diskBytes +
                  entries.reduce((sum, entry) => sum + (entry.directory ? 0 : entry.size), 0),
              );
              let completed = 0;
              await timing.measure('copy.auditRequested', () =>
                recordAudit(connection, current, 'server.files.requested', {
                  serverId,
                  action: 'copy',
                  count: entries.length,
                  overwrite: [...approvedTargets],
                }),
              );
              try {
                for (const entry of entries) {
                  c.req.raw.signal.throwIfAborted();
                  await timing.measure('copy.authorizeEntry', () =>
                    service.authorizeTransfer(
                      current,
                      serverId,
                      true,
                      connection,
                      trace.enabled ? timing : undefined,
                    ),
                  );
                  const parts = entry.path.split('/');
                  const name = parts.pop();
                  if (!name) throw new DomainError('validation_failed');
                  const root = parts.join('/');
                  // The fresh operation plan and game guard share one metadata snapshot.
                  // Wings authoritatively opens sources and confines writes; never relist
                  // the same ancestors for each stage or each file.
                  if (entry.directory)
                    await timing.measure('copy.createDirectory', () =>
                      service.adapter.createDirectory(id, root, name),
                    );
                  else {
                    const claim = await timing.measure('copy.reserveIngestion', () =>
                      reserveUploadIngestion(connection, current, serverId, entry.size, env),
                    );
                    try {
                      const download = await timing.measure('copy.downloadNegotiation', () =>
                        service.adapter.downloadFile(id, entry.source, {
                          signal: c.req.raw.signal,
                          authorize: () =>
                            timing.measure('copy.authorizeDownload', () =>
                              service.authorizeTransfer(
                                current,
                                serverId,
                                false,
                                connection,
                                trace.enabled ? timing : undefined,
                              ),
                            ),
                        }),
                      );
                      try {
                        if (
                          download.contentLength !== undefined &&
                          download.contentLength !== entry.size
                        )
                          throw new DomainError('conflict');
                        await timing.measure('copy.uploadStream', () =>
                          service.adapter.uploadFile(id, entry.path, {
                            body: download.body,
                            contentLength: entry.size,
                            maxBytes: entry.size,
                            signal: c.req.raw.signal,
                            authorize: () =>
                              timing.measure('copy.authorizeUpload', () =>
                                service.authorizeTransfer(
                                  current,
                                  serverId,
                                  true,
                                  connection,
                                  trace.enabled ? timing : undefined,
                                ),
                              ),
                          }),
                        );
                      } finally {
                        await timing.measure('copy.downloadCleanup', () =>
                          download.body.cancel().catch(() => {}),
                        );
                      }
                      await timing.measure('copy.completeIngestion', () => claim.complete());
                    } finally {
                      await timing.measure('copy.unlockIngestion', () => claim.unlock());
                    }
                  }
                  completed++;
                }
                await timing.measure('copy.auditCompleted', () =>
                  recordAudit(connection, current, 'server.files.completed', {
                    serverId,
                    action: 'copy',
                    completed,
                  }),
                );
                return timing.measureSync('copy.serialize', () => c.json({ completed }));
              } catch (error) {
                await timing.measure('copy.auditIncomplete', () =>
                  recordAudit(connection, current, 'server.files.incomplete', {
                    serverId,
                    action: 'copy',
                    completed,
                    outcome: 'partial_or_uncertain',
                  }),
                );
                throw new DomainError('operation_uncertain', 409, {
                  completed,
                  fileReason: 'partial_or_uncertain',
                  cause: error instanceof DomainError ? error.code : 'provider_error',
                });
              }
            },
            trace.enabled ? timing : undefined,
          ),
        );
      } finally {
        timing.measureSync('copy.releaseSlot', release);
      }
      outcome = 'succeeded';
      return response;
    } finally {
      trace.finish(outcome, response);
    }
  });
  app.post('/v1/servers/:id/files/extract', async (c) => {
    const input = parse(
      z.strictObject({
        root: z.string(),
        file: z.string(),
        destination: z.string(),
        confirm: z.literal(true),
      }),
      await body(c.req.raw),
    );
    const root = clean(input.root, true),
      name = child(input.file),
      destination = pathJoin(root, child(input.destination));
    const format = name.toLowerCase().endsWith('.tar.gz')
      ? 'tar.gz'
      : extractFormats.find((format) => name.toLowerCase().endsWith(`.${format}`));
    if (!format) badArchive('unsupported_archive');
    const context = await principal(c),
      serverId = c.req.param('id'),
      service = await management();
    const transferLimits = await canWrite(serverId, context);
    const { values } = await getSettings(db, env);
    const configured = values.fileOperationsRoot;
    const diskPolicy = {
      minimumFreeBytes: values.fileOperationsFreeBytes,
      minimumFreePercent: values.fileOperationsFreePercent,
    };
    if (!/^\.\/mountdata\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(configured))
      throw new DomainError('configuration_invalid');
    const base = resolve(configured);
    await contentStageDirectory(base);
    if ((await realpath(base)) !== base) throw new DomainError('configuration_invalid');
    const release = options.acquireUploadSlot();
    let stage: string | undefined;
    try {
      stage = await mkdtemp(join(base, 'extract-'));
      const stagePath = stage;
      return await service.access(
        context,
        serverId,
        true,
        async (id, connection, current, server) => {
          if (root) {
            const directory = await inspectFilePath(service.adapter, id, root);
            if (!directory || directory.is_file) throw new DomainError('conflict');
          }
          const listing = await service.adapter.listFiles(id, root);
          const source = listing.find((item) => item.name === name);
          if (!source?.is_file || source.is_symlink || source.size > maxArchiveBytes)
            badArchive('archive_source');
          if (listing.some((item) => item.name.toLowerCase() === input.destination.toLowerCase()))
            throw new DomainError('conflict');
          await service.assertFileMutation(serverId, [destination], connection);
          await assertContentDiskSpace(stagePath, source.size, diskPolicy);
          const archive = join(stagePath, 'source');
          const download = await service.adapter.downloadFile(id, pathJoin(root, name), {
            signal: c.req.raw.signal,
            authorize: () => service.authorizeTransfer(current, serverId, false, connection),
          });
          let bytes = 0;
          await pipeline(
            Readable.fromWeb(download.body as import('node:stream/web').ReadableStream<Uint8Array>),
            new Transform({
              transform(chunk: Buffer, _encoding, done) {
                bytes += chunk.length;
                done(bytes > source.size ? new Error('archive_changed') : null, chunk);
              },
            }),
            createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
            { signal: c.req.raw.signal },
          );
          if (bytes !== source.size) throw new DomainError('conflict');
          const filesRoot = join(stagePath, 'files');
          await mkdir(filesRoot, { mode: 0o700 });
          const files = await stageFileArchive(
            archive,
            format,
            filesRoot,
            c.req.raw.signal,
            diskPolicy,
          );
          if (files.some((file) => file.size > (transferLimits.upload.providerMaxFileBytes ?? 0)))
            throw new DomainError('validation_failed', 413);
          await service.assertFileMutation(
            serverId,
            files.map((file) => pathJoin(destination, file.path)),
            connection,
          );
          const resources = await service.adapter.getResources(id);
          assertServerStorageCapacity(
            server.limits.disk,
            resources.resources.disk_bytes + files.reduce((sum, file) => sum + file.size, 0),
          );
          await service.authorizeTransfer(current, serverId, true, connection);
          if (
            (await service.adapter.listFiles(id, root)).some(
              (item) => item.name.toLowerCase() === input.destination.toLowerCase(),
            )
          )
            throw new DomainError('conflict');
          let completed = 0;
          await recordAudit(connection, current, 'server.files.requested', {
            serverId,
            action: 'extract',
            count: files.length,
          });
          try {
            if (root) {
              const currentRoot = await inspectFilePath(service.adapter, id, root);
              if (!currentRoot || currentRoot.is_file) throw new DomainError('conflict');
            }
            await service.adapter.createDirectory(id, root, input.destination);
            const directories = new Set([destination]);
            for (const file of files) {
              const target = pathJoin(destination, file.path),
                parts = target.split('/');
              if (!file.directory) parts.pop();
              for (let i = destination.split('/').length + 1; i <= parts.length; i++) {
                const dir = parts.slice(0, i).join('/');
                if (!directories.has(dir)) {
                  await service.authorizeTransfer(current, serverId, true, connection);
                  const parent = await inspectFilePath(
                    service.adapter,
                    id,
                    parts.slice(0, i - 1).join('/'),
                  );
                  if (!parent || parent.is_file) throw new DomainError('conflict');
                  await service.adapter.createDirectory(
                    id,
                    parts.slice(0, i - 1).join('/'),
                    parts[i - 1] ?? '',
                  );
                  directories.add(dir);
                }
              }
              if (file.directory) {
                completed++;
                continue;
              }
              await service.assertFileMutation(serverId, [target], connection);
              if (
                (await service.adapter.listFiles(id, parts.join('/'))).some(
                  (item) => item.name.toLowerCase() === file.path.split('/').at(-1)?.toLowerCase(),
                )
              )
                throw new DomainError('conflict');
              const parent = await inspectFilePath(service.adapter, id, parts.join('/'));
              if (!parent || parent.is_file) throw new DomainError('conflict');
              const claim = await reserveUploadIngestion(
                connection,
                current,
                serverId,
                file.size,
                env,
              );
              try {
                await service.adapter.uploadFile(id, target, {
                  body: Readable.toWeb(createReadStream(file.local)) as ReadableStream<Uint8Array>,
                  contentLength: file.size,
                  maxBytes: file.size,
                  signal: c.req.raw.signal,
                  authorize: () => service.authorizeTransfer(current, serverId, true, connection),
                });
                await claim.complete();
              } finally {
                await claim.unlock();
              }
              completed++;
            }
            await recordAudit(connection, current, 'server.files.completed', {
              serverId,
              action: 'extract',
              completed,
            });
            return c.json({ completed, destination });
          } catch {
            await recordAudit(connection, current, 'server.files.incomplete', {
              serverId,
              action: 'extract',
              completed,
              outcome: 'partial_or_uncertain',
            });
            throw new DomainError('operation_uncertain', 409, {
              completed,
              fileReason: 'partial_or_uncertain',
            });
          }
        },
      );
    } finally {
      try {
        if (stage) await rm(stage, { recursive: true, force: true });
      } finally {
        release();
      }
    }
  });
}
