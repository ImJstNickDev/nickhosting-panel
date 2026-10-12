import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DomainError,
  decodeEditableText,
  FILE_EDITOR_MAX_BYTES,
  fileEditorAvailability,
} from '@nickhosting/core';
import { recordAudit } from '@nickhosting/database';
import {
  type PterodactylAdapter,
  relativePath,
  type ServerFile,
} from '@nickhosting/pterodactyl-adapter';
import type { Hono } from 'hono';
import { ZipFile } from 'yazl';
import { z } from 'zod';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export const editorMaxBytes = FILE_EDITOR_MAX_BYTES;
function requireEditableFile(file: Parameters<typeof fileEditorAvailability>[0]) {
  const availability = fileEditorAvailability(file);
  if (availability === 'too_large') throw new DomainError('validation_failed', 413);
  if (availability !== 'text') throw new DomainError('file_not_editable');
}
export function fileRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function path(value: string, root = false) {
  return relativePath(value, root).slice(1);
}
const join = (...parts: string[]) => parts.filter(Boolean).join('/');
/** Check every component; the provider still owns the filesystem sandbox. */
export async function inspectFilePath(
  adapter: Pick<PterodactylAdapter, 'listFiles'>,
  id: string,
  value: string,
) {
  const parts = path(value).split('/');
  let directory = '';
  let entry: ServerFile | undefined;
  for (let index = 0; index < parts.length; index++) {
    entry = (await adapter.listFiles(id, directory)).find((file) => file.name === parts[index]);
    if (!entry) {
      if (index === parts.length - 1) return undefined;
      throw new DomainError('not_found');
    }
    if (entry.is_symlink || (index < parts.length - 1 && entry.is_file))
      throw new DomainError('forbidden');
    directory = join(directory, parts[index] ?? '');
  }
  return entry;
}
export interface ArchiveEntry {
  path: string;
  name: string;
  file: ServerFile;
}
export async function collectArchiveEntries(
  adapter: PterodactylAdapter,
  id: string,
  root: string,
  names: string[],
  authorize: () => Promise<void>,
  signal?: AbortSignal,
): Promise<ArchiveEntry[]> {
  root = path(root, true);
  if (root) {
    const folder = await inspectFilePath(adapter, id, root);
    if (!folder || folder.is_file) throw new DomainError('not_found');
  }
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  const visit = async (directory: string, selected?: string[], depth = 0): Promise<void> => {
    if (signal?.aborted) throw new DomainError('integration_unavailable');
    if (depth > 64) throw new DomainError('validation_failed');
    await authorize();
    const listing = await adapter.listFiles(id, directory);
    const files = selected
      ? selected.map((name) => {
          if (path(name).includes('/')) throw new DomainError('validation_failed');
          const found = listing.find((entry) => entry.name === name);
          if (!found) throw new DomainError('not_found');
          return found;
        })
      : listing;
    for (const file of files) {
      const safe = path(file.name);
      if (safe.includes('/') || file.is_symlink) throw new DomainError('forbidden');
      const source = join(directory, safe);
      const name = root ? source.slice(root.length + 1) : source;
      if (seen.has(name)) throw new DomainError('validation_failed');
      seen.add(name);
      if (entries.length >= 10000) throw new DomainError('validation_failed', 413);
      entries.push({ path: source, name, file });
      if (!file.is_file) await visit(source, undefined, depth + 1);
    }
  };
  await visit(root, names);
  return entries;
}
/** Lazy upstream streams: one file at a time, ZIP64 and backpressure, no whole-body buffer. */
export function streamFileZip(
  entries: ArchiveEntry[],
  open: (entry: ArchiveEntry, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const controller = new AbortController();
  let active: Readable | undefined;
  const abort = () => {
    controller.abort();
    active?.destroy();
    output.destroy();
  };
  const cleanup = () => {
    signal?.removeEventListener('abort', abort);
    controller.abort();
    active?.destroy();
  };
  signal?.addEventListener('abort', abort, { once: true });
  output.once('close', cleanup);
  zip.on('error', () => {
    output.destroy(new Error('archive_stream_failed'));
  });
  for (const entry of entries) {
    if (!entry.file.is_file) {
      zip.addEmptyDirectory(entry.name);
      continue;
    }
    zip.addReadStreamLazy(entry.name, { size: entry.file.size, compress: false }, (done) => {
      if (controller.signal.aborted) {
        done(new Error('archive_cancelled'), Readable.from([]));
        return;
      }
      void open(entry, controller.signal).then(
        (body) => {
          if (controller.signal.aborted) {
            void body.cancel();
            done(new Error('archive_cancelled'), Readable.from([]));
            return;
          }
          active = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
          done(null, active);
        },
        () => done(new Error('archive_source_failed'), Readable.from([])),
      );
    });
  }
  zip.end();
  if (signal?.aborted) abort();
  return Readable.toWeb(output) as ReadableStream<Uint8Array>;
}

export function registerFileBrowsingRoutes(
  app: Hono<{ Variables: Variables }>,
  options: ServerRouteOptions,
) {
  const { principal, management } = options;
  app.get('/v1/servers/:id/files/editor', async (c) => {
    const context = await principal(c),
      service = await management();
    const target = path(c.req.query('path') ?? '');
    const result = await service.access(context, c.req.param('id'), false, async (id) => {
      const entry = await inspectFilePath(service.adapter, id, target);
      if (!entry?.is_file) throw new DomainError('not_found');
      requireEditableFile(entry);
      const bytes = await service.adapter.readFile(id, target, editorMaxBytes);
      const content = decodeEditableText(bytes);
      return { content, revision: fileRevision(bytes) };
    });
    c.header('Cache-Control', 'no-store');
    return c.json(result);
  });
  app.put('/v1/servers/:id/files/editor', async (c) => {
    const context = await principal(c),
      service = await management();
    if (!c.req.header('content-type')?.startsWith('application/json'))
      throw new DomainError('validation_failed');
    const result = z
      .object({
        path: z.string(),
        content: z.string().max(editorMaxBytes),
        expectedRevision: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!result.success) throw new DomainError('validation_failed');
    const input = result.data,
      target = path(input.path);
    if (Buffer.byteLength(input.content) > editorMaxBytes)
      throw new DomainError('validation_failed', 413);
    const revision = await service.access(
      context,
      c.req.param('id'),
      true,
      async (id, connection, current) => {
        // Both game-specific and generic guards inspect the same preflight directory
        // observations. Scope them to this authorized request, before any write.
        const directories = new Map<string, Promise<ServerFile[]>>();
        const listFiles = (directory: string) => {
          let listing = directories.get(directory);
          if (!listing) {
            listing = service.adapter.listFiles(id, directory);
            directories.set(directory, listing);
          }
          return listing;
        };
        await service.assertFileMutation(c.req.param('id'), [target], connection, {
          providerIdentifier: id,
          listFiles,
        });
        // Creation cannot bypass the same binary-type policy used for existing files.
        requireEditableFile({ name: target });
        const submitted = Buffer.from(input.content);
        if (decodeEditableText(submitted) !== input.content)
          throw new DomainError('file_not_editable');
        const entry = await inspectFilePath(
          { listFiles: (_id, directory = '') => listFiles(directory) },
          id,
          target,
        );
        if (entry && !entry.is_file) throw new DomainError('conflict');
        if (entry) requireEditableFile(entry);
        let before: string | null = null;
        if (entry) {
          const previous = await service.adapter.readFile(id, target, editorMaxBytes);
          // A binary file renamed to .txt remains non-editable, even with a matching revision.
          decodeEditableText(previous);
          before = fileRevision(previous);
        }
        if (before !== input.expectedRevision) throw new DomainError('conflict');
        await recordAudit(connection, current, 'server.files.requested', {
          serverId: c.req.param('id'),
          action: 'edit',
        });
        // NickHosting writes serialize through access(); Wings offers no external atomic CAS.
        await service.authorizeTransfer(current, c.req.param('id'), true, connection);
        await service.adapter.writeFile(id, target, input.content);
        await service.authorizeTransfer(current, c.req.param('id'), true, connection);
        const expected = fileRevision(Buffer.from(input.content));
        const actual = fileRevision(await service.adapter.readFile(id, target, editorMaxBytes));
        if (actual !== expected) throw new DomainError('conflict');
        return expected;
      },
    );
    return c.json({ revision });
  });
  app.get('/v1/servers/:id/files/archive', async (c) => {
    const requestedAt = new Date();
    const context = await principal(c),
      service = await management(),
      serverId = c.req.param('id');
    let raw: unknown;
    try {
      raw = JSON.parse(c.req.query('files') ?? 'null');
    } catch {
      throw new DomainError('validation_failed');
    }
    const parsed = z.array(z.string().min(1).max(255)).min(1).max(100).safeParse(raw);
    if (!parsed.success) throw new DomainError('validation_failed');
    const authorize = () => service.authorizeTransfer(context, serverId, false);
    const { id, serverName, entries } = await service.access(
      context,
      serverId,
      false,
      async (id, connection, current, server) => ({
        id,
        serverName: server.name,
        entries: await collectArchiveEntries(
          service.adapter,
          id,
          c.req.query('root') ?? '',
          parsed.data,
          () => service.authorizeTransfer(current, serverId, false, connection),
          c.req.raw.signal,
        ),
      }),
    );
    const name =
      serverName
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100)
        .replace(/-+$/g, '') || 'server';
    const timestamp = requestedAt.toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '_');
    const filename = `nhpanel-${name}-${timestamp}.zip`;
    const stream = streamFileZip(
      entries,
      async (entry, signal) => {
        await authorize();
        const current = await inspectFilePath(service.adapter, id, entry.path);
        if (
          !current?.is_file ||
          current.size !== entry.file.size ||
          current.modified_at !== entry.file.modified_at
        )
          throw new DomainError('conflict');
        return (
          await service.adapter.downloadFile(id, entry.path, {
            signal,
            authorize,
            maxBytes: entry.file.size,
          })
        ).body;
      },
      c.req.raw.signal,
    );
    return new Response(stream, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });
}
