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
  getPlatformTransfers,
  parse,
  reserveUploadIngestion,
} from '@nickhosting/server-management';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Variables } from './app.js';
import { inspectFilePath } from './file-browsing.js';
import type { ServerRouteOptions } from './servers.js';

export const extractFormats = ['zip', 'tar', 'tar.gz', 'tgz'] as const;
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

/** Enumerate the complete selection before the first destination mutation. */
export async function planFileCopy(
  list: (path: string) => Promise<ServerFile[]>,
  root: string,
  names: string[],
  destination: string,
): Promise<CopyEntry[]> {
  root = clean(root, true);
  destination = clean(destination, true);
  const selected = names.map(child);
  if (new Set(selected.map((name) => name.toLowerCase())).size !== selected.length)
    throw new DomainError('validation_failed');
  for (const path of [root, destination]) {
    const parts = path.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const matches = (await list(parts.slice(0, i).join('/'))).filter(
        (item) => item.name.toLowerCase() === parts[i]?.toLowerCase(),
      );
      if (
        matches.length !== 1 ||
        matches[0]?.is_file ||
        matches[0]?.is_symlink ||
        matches[0]?.name !== parts[i]
      )
        throw new DomainError('conflict');
    }
  }
  const targets = await list(destination);
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
  const source = await list(root);
  for (const name of selected) {
    const matches = source.filter((item) => item.name === name);
    if (
      matches.length !== 1 ||
      targets.some((item) => item.name.toLowerCase() === name.toLowerCase())
    )
      throw new DomainError('conflict');
    const selected = matches[0];
    if (!selected) throw new DomainError('conflict');
    await visit(pathJoin(root, name), pathJoin(destination, name), selected, 0);
  }
  return entries;
}

/** Batch renames are not transactional upstream. Reject predictable collisions before any effect. */
export async function validateFileMoves(
  adapter: PterodactylAdapter,
  id: string,
  root: string,
  moves: { from: string; to: string }[],
  overwrite: string[] = [],
) {
  root = clean(root, true);
  const planned = moves.map((move) => ({
    from: pathJoin(root, clean(move.from)),
    to: pathJoin(root, clean(move.to)),
  }));
  const approved = overwrite.map((target) => pathJoin(root, clean(target)));
  if (
    new Set(approved).size !== approved.length ||
    approved.some((target) => !planned.some((move) => move.to === target))
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
    for (const source of sources) {
      if (target === source || target.startsWith(`${source}/`)) throw new DomainError('conflict');
    }
  for (const source of sources)
    for (const other of sources)
      if (source !== other && source.startsWith(`${other}/`)) throw new DomainError('conflict');
  for (const move of planned) {
    const source = await inspectFilePath(adapter, id, move.from);
    if (!source) throw new DomainError('not_found');
    const parts = move.to.split('/');
    const name = parts.pop();
    const parent = parts.join('/');
    if (parent) {
      const directory = await inspectFilePath(adapter, id, parent);
      if (!directory || directory.is_file) throw new DomainError('conflict');
    }
    const existing = (await adapter.listFiles(id, parent)).filter(
      (entry) => entry.name.toLowerCase() === name?.toLowerCase(),
    );
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
    if (format === 'zip') {
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
      else await pipeline(input, createGunzip(), expansionGuard, parser, { signal });
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
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
    const input = parse(
      z.strictObject({
        root: z.string(),
        files: z.array(z.string()).min(1).max(100),
        destination: z.string(),
      }),
      await body(c.req.raw),
    );
    const context = await principal(c),
      serverId = c.req.param('id'),
      service = await management();
    const transferLimits = await canWrite(serverId, context);
    const release = options.acquireUploadSlot();
    try {
      return await service.access(
        context,
        serverId,
        true,
        async (id, connection, current, server) => {
          const entries = await planFileCopy(
            (path) => service.adapter.listFiles(id, path),
            input.root,
            input.files,
            input.destination,
          );
          if (
            entries.some(
              (entry) =>
                !entry.directory && entry.size > (transferLimits.upload.providerMaxFileBytes ?? 0),
            )
          )
            throw new DomainError('validation_failed', 413);
          await service.assertFileMutation(
            serverId,
            entries.map((entry) => entry.path),
            connection,
          );
          const maxBytes = server.limits.disk * 1048576;
          const resources = await service.adapter.getResources(id);
          if (
            resources.resources.disk_bytes +
              entries.reduce((sum, entry) => sum + (entry.directory ? 0 : entry.size), 0) >
            maxBytes
          )
            throw new DomainError('resources_unavailable');
          let completed = 0;
          await recordAudit(connection, current, 'server.files.requested', {
            serverId,
            action: 'copy',
            count: entries.length,
          });
          try {
            for (const entry of entries) {
              c.req.raw.signal.throwIfAborted();
              await service.authorizeTransfer(current, serverId, true, connection);
              await service.assertFileMutation(serverId, [entry.path], connection);
              const parts = entry.path.split('/');
              const name = parts.pop();
              if (!name) throw new DomainError('validation_failed');
              const root = parts.join('/');
              if (root) {
                const parent = await inspectFilePath(service.adapter, id, root);
                if (!parent || parent.is_file) throw new DomainError('conflict');
              }
              const currentSource = await inspectFilePath(service.adapter, id, entry.source);
              if (
                !currentSource ||
                currentSource.is_file === entry.directory ||
                currentSource.size !== entry.size
              )
                throw new DomainError('conflict');
              if (
                (await service.adapter.listFiles(id, root)).some(
                  (item) => item.name.toLowerCase() === name.toLowerCase(),
                )
              )
                throw new DomainError('conflict');
              if (entry.directory) await service.adapter.createDirectory(id, root, name);
              else {
                const claim = await reserveUploadIngestion(
                  connection,
                  current,
                  serverId,
                  entry.size,
                  env,
                );
                try {
                  const download = await service.adapter.downloadFile(id, entry.source, {
                    signal: c.req.raw.signal,
                    authorize: () =>
                      service.authorizeTransfer(current, serverId, false, connection),
                  });
                  await service.adapter.uploadFile(id, entry.path, {
                    body: download.body,
                    contentLength: entry.size,
                    maxBytes,
                    signal: c.req.raw.signal,
                    authorize: () => service.authorizeTransfer(current, serverId, true, connection),
                  });
                  await claim.complete();
                } finally {
                  await claim.unlock();
                }
              }
              completed++;
            }
            await recordAudit(connection, current, 'server.files.completed', {
              serverId,
              action: 'copy',
              completed,
            });
            return c.json({ completed });
          } catch (error) {
            await recordAudit(connection, current, 'server.files.incomplete', {
              serverId,
              action: 'copy',
              completed,
              outcome: 'partial_or_uncertain',
            });
            throw new DomainError('operation_uncertain', 409, {
              completed,
              fileReason: 'partial_or_uncertain',
              cause: error instanceof DomainError ? error.code : 'provider_error',
            });
          }
        },
      );
    } finally {
      release();
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
          const maxBytes = server.limits.disk * 1048576;
          const resources = await service.adapter.getResources(id);
          if (
            resources.resources.disk_bytes + files.reduce((sum, file) => sum + file.size, 0) >
            maxBytes
          )
            throw new DomainError('resources_unavailable');
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
                  maxBytes,
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
