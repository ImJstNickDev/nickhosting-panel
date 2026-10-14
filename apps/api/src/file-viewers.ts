import { posix } from 'node:path';
import { authSessionId, DomainError, type SecretCodec } from '@nickhosting/core';
import { getSecret, getSettings } from '@nickhosting/database';
import type { DatagridPage, DatagridQuery } from '@nickhosting/game-sdk/ui';
import { authorizeServer, parse } from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Variables } from './app.js';
import { streamFileZip } from './file-browsing.js';
import type { ServerRouteOptions } from './servers.js';
import { viewerArchivePath } from './viewer-archive.js';
import { archiveChain, selectArchiveEntries, ViewerArchiveTree } from './viewer-archive-tree.js';
import { ViewerFormatError, ViewerSessionCache } from './viewer-cache.js';
import { viewerBody, viewerHeaders, viewerRange } from './viewer-http.js';
import type { FileViewerService } from './viewer-service.js';
import { openSqliteViewer, type ViewerSqliteSession } from './viewer-sqlite.js';
import type { SubtitleViewerSession } from './viewer-subtitles.js';
import {
  createViewerTiming,
  motionTimingInput,
  motionTimingLimiter,
  type ViewerTiming,
} from './viewer-timing.js';

const preferenceSchema = z.strictObject({
  scope: z.enum(['server', 'game', 'global']),
  extension: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9.+_-]*$/),
  viewerId: z.union([
    z.enum(['text', 'image', 'audio', 'video', 'archive', 'sqlite', 'json']),
    z
      .string()
      .max(128)
      .regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/),
  ]),
});
const formatMessages: Record<string, string> = {
  viewer_sqlite_wal: 'viewer.sqliteWal',
  viewer_sqlite_invalid: 'viewer.sqliteInvalid',
  viewer_sqlite_changed: 'viewer.sqliteChanged',
  viewer_sqlite_unavailable: 'viewer.sqliteUnavailable',
  viewer_sqlite_timeout: 'viewer.sqliteTimeout',
  viewer_sqlite_budget: 'viewer.sqliteBudget',
  viewer_sqlite_column: 'viewer.sqliteColumnInvalid',
  viewer_sqlite_cell: 'viewer.sqliteCellUnavailable',
  viewer_subtitles_unavailable: 'viewer.videoSubtitleFailed',
};
const services = new WeakMap<object, Promise<FileViewerService>>();
export async function closeFileViewers(db: object) {
  const pending = services.get(db);
  services.delete(db);
  if (pending) await (await pending).close();
}
type Retained<T> = { value: T; signal: AbortSignal };
const archiveCaches = new WeakMap<object, ViewerSessionCache<Retained<ViewerArchiveTree>>>();
const sqliteCaches = new WeakMap<object, ViewerSessionCache<Retained<ViewerSqliteSession>>>();
const subtitleCaches = new WeakMap<object, ViewerSessionCache<Retained<SubtitleViewerSession>>>();
export async function closeViewerArchives(db: object) {
  const archive = archiveCaches.get(db),
    sqlite = sqliteCaches.get(db),
    subtitles = subtitleCaches.get(db);
  archiveCaches.delete(db);
  sqliteCaches.delete(db);
  subtitleCaches.delete(db);
  await Promise.all([archive?.close(), sqlite?.close(), subtitles?.close()]);
}
function disposition(name: string) {
  const filename = posix.basename(name);
  return `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
type C = Context<{ Variables: Variables }>;
/** Preview routes reuse the existing file access proof and one shared SFTP broker. */
export function registerFileViewerRoutes(
  app: Hono<{ Variables: Variables }>,
  options: ServerRouteOptions & { codec: SecretCodec },
) {
  const { db, principal, management } = options;
  const viewer = () => {
    let pending = services.get(db);
    if (!pending) {
      pending = import('./viewer-service.js').then(
        (module) => new module.FileViewerService(options),
      );
      services.set(db, pending);
      void pending.catch(() => {
        if (services.get(db) === pending) services.delete(db);
      });
    }
    return pending;
  };
  const archives = new ViewerSessionCache<Retained<ViewerArchiveTree>>();
  const databases = new ViewerSessionCache<Retained<ViewerSqliteSession>>({ maximum: 4 });
  const subtitles = new ViewerSessionCache<Retained<SubtitleViewerSession>>({ maximum: 8 });
  archiveCaches.set(db, archives);
  sqliteCaches.set(db, databases);
  subtitleCaches.set(db, subtitles);
  const gameId = async (mappingId: string) =>
    (
      await db
        .selectFrom('runtime_egg_mappings')
        .select('game_id')
        .where('id', '=', mappingId)
        .executeTakeFirstOrThrow()
    ).game_id;
  const timings = new WeakMap<C, ViewerTiming>();
  const guarded = (work: (c: C) => Promise<Response>) => async (c: C) => {
    const timing = createViewerTiming(options.logger, {
      traceId: c.req.query('motionTrace'),
      purpose: c.req.query('motionPurpose'),
      requestId: c.get('requestId'),
      serverId: c.req.param('id'),
    });
    if (timing) timings.set(c, timing);
    try {
      const response = await work(c);
      timing?.headers(response);
      if (!timing?.streaming) timing?.finish(response.ok ? 'succeeded' : 'failed');
      return response;
    } catch (error) {
      timing?.finish(c.req.raw.signal.aborted ? 'cancelled' : 'failed');
      if (error instanceof ViewerFormatError)
        return c.json(
          {
            error: {
              code: error.code,
              messageKey: formatMessages[error.code] ?? 'viewer.formatUnavailable',
            },
          },
          422,
        );
      throw error;
    }
  };
  const open = async (c: C, persistent = false) => {
    const timing = timings.get(c);
    const context = timing
        ? await timing.measure('principal', () => principal(c))
        : await principal(c),
      service = timing ? await timing.measure('management', management) : await management();
    const work = async () =>
      (await viewer()).open(
        context,
        service,
        c.req.param('id')!,
        c.req.query('path') ?? '',
        persistent ? new AbortController().signal : c.req.raw.signal,
      );
    const opened = timing ? await timing.measure('viewerOpen', work) : await work();
    return { opened, context };
  };
  // Parsed sessions outlive a single HTTP request. An abandoned tab cannot
  // cancel another request sharing that session; authorization revokes them all.
  const retained = async <T extends { close(): void | Promise<void>; closedSignal?: AbortSignal }>(
    c: C,
    cache: ViewerSessionCache<Retained<T>>,
    create: (opened: Awaited<ReturnType<typeof open>>['opened'], key: string) => Promise<T>,
  ) => {
    const { opened, context } = await open(c, true);
    let adopted = false;
    const key = JSON.stringify([
      context[authSessionId],
      context.actorUserId,
      context.subjectUserId,
      context.support?.id,
      opened.key,
    ]);
    try {
      const timing = timings.get(c);
      const acquire = () =>
        cache.acquire(
          key,
          async () => {
            adopted = true;
            try {
              const session = timing
                ? await timing.measure('parserOpen', () => create(opened, key))
                : await create(opened, key);
              const invalidate = () => {
                void cache.invalidate(key);
              };
              opened.signal.addEventListener('abort', invalidate, { once: true });
              session.closedSignal?.addEventListener('abort', invalidate, { once: true });
              if (opened.signal.aborted || session.closedSignal?.aborted) {
                await session.close();
                throw new DomainError('forbidden');
              }
              return {
                session: { value: session, signal: opened.signal },
                dispose: async () => {
                  opened.signal.removeEventListener('abort', invalidate);
                  session.closedSignal?.removeEventListener('abort', invalidate);
                  await session.close();
                  await opened.close();
                },
              };
            } catch (error) {
              await opened.close();
              throw error;
            }
          },
          c.req.raw.signal,
        );
      const lease = timing ? await timing.measure('retainedAcquire', acquire) : await acquire();
      timing?.cache(!adopted);
      return { session: lease.session.value, release: lease.release, signal: lease.session.signal };
    } finally {
      if (!adopted) await opened.close();
    }
  };
  const archive = async (c: C) => {
    let chain: string[];
    try {
      chain = archiveChain(JSON.parse(c.req.query('archives') ?? '[]'));
    } catch {
      throw new DomainError('validation_failed');
    }
    const root = await retained(c, archives, async (opened, key) => {
      const { createArchiveViewer } = await import('./viewer-archive.js');
      const session = await createArchiveViewer(opened.source, {
        name: opened.path,
        key,
        cache: opened.cache,
        signal: opened.signal,
      });
      return new ViewerArchiveTree(session, {
        key,
        cache: opened.cache,
        signal: opened.signal,
        mtimeMs: opened.source.mtimeMs,
      });
    });
    try {
      const child = await root.session.acquire(chain, c.req.raw.signal);
      return {
        session: child.session,
        signal: root.signal,
        release() {
          child.release();
          root.release();
        },
      };
    } catch (error) {
      root.release();
      throw error;
    }
  };
  const sqlite = (c: C) =>
    retained(c, databases, (opened, key) =>
      openSqliteViewer(
        { ...opened.source, restat: opened.restat, siblingExists: opened.siblingExists },
        { key, cache: opened.cache, signal: opened.signal },
      ),
    );
  app.get('/v1/servers/:id/files/viewer/capabilities', async (c) => {
    await authorizeServer(db, await principal(c), c.req.param('id'), 'server:read');
    const [{ values }, key] = await Promise.all([
      getSettings(db, options.env),
      getSecret(db, options.codec, 'viewerSftpgoApiKey', options.env),
    ]);
    return c.json({
      available: !!(values.fileViewers && key),
      ...(options.logger?.isEnabled('debug') ? { debugTiming: true } : {}),
      previewLimits: { imageBytes: 67108864, icoBytes: 16777216, jsonBytes: 8388608 },
    });
  });
  const acceptTiming = motionTimingLimiter();
  app.post('/v1/servers/:id/files/viewer/motion-timing', async (c) => {
    if (!options.logger?.isEnabled('debug')) return c.body(null, 404);
    const context = await principal(c);
    await authorizeServer(db, context, c.req.param('id'), 'server:read');
    if (!acceptTiming(context[authSessionId] ?? context.actorUserId))
      throw new DomainError('rate_limited');
    if (!c.req.header('content-type')?.startsWith('application/json'))
      throw new DomainError('validation_failed');
    const input = parse(motionTimingInput, await c.req.json().catch(() => null));
    try {
      options.logger.log('debug', 'viewer.motion_browser', {
        source: 'browser',
        requestId: c.get('requestId'),
        serverId: c.req.param('id'),
        ...input,
      });
    } catch {
      /* Diagnostics must not change playback. */
    }
    return c.body(null, 204);
  });
  app.get('/v1/servers/:id/files/viewer/preferences', async (c) => {
    const context = await principal(c),
      server = await authorizeServer(db, context, c.req.param('id'), 'server:read');
    const game = await gameId(server.mapping_id);
    const preferences = await db
      .selectFrom('file_viewer_preferences')
      .select(['scope', 'extension', 'viewer_id'])
      .where('user_id', '=', context.actorUserId)
      .where((eb) =>
        eb.or([
          eb.and([eb('scope', '=', 'global'), eb('scope_id', '=', '')]),
          eb.and([eb('scope', '=', 'game'), eb('scope_id', '=', game)]),
          eb.and([eb('scope', '=', 'server'), eb('scope_id', '=', server.id)]),
        ]),
      )
      .execute();
    return c.json({
      preferences: preferences.map(({ viewer_id, ...row }) => ({ ...row, viewerId: viewer_id })),
    });
  });
  for (const method of ['PUT', 'DELETE'] as const)
    app.on(method, '/v1/servers/:id/files/viewer/preferences', async (c) => {
      const context = await principal(c),
        server = await authorizeServer(db, context, c.req.param('id')!, 'server:read');
      if (!c.req.header('content-type')?.startsWith('application/json'))
        throw new DomainError('validation_failed');
      const input = parse(
        method === 'PUT' ? preferenceSchema : preferenceSchema.omit({ viewerId: true }),
        await c.req.json().catch(() => null),
      );
      const scopeId =
        input.scope === 'server'
          ? server.id
          : input.scope === 'game'
            ? await gameId(server.mapping_id)
            : '';
      if (method === 'DELETE')
        await db
          .deleteFrom('file_viewer_preferences')
          .where('user_id', '=', context.actorUserId)
          .where('scope', '=', input.scope)
          .where('scope_id', '=', scopeId)
          .where('extension', '=', input.extension)
          .execute();
      else {
        const viewerId = preferenceSchema.parse(input).viewerId;
        await db
          .insertInto('file_viewer_preferences')
          .values({
            user_id: context.actorUserId,
            scope: input.scope,
            scope_id: scopeId,
            extension: input.extension,
            viewer_id: viewerId,
          })
          .onConflict((conflict) =>
            conflict
              .columns(['user_id', 'scope', 'scope_id', 'extension'])
              .doUpdateSet({ viewer_id: viewerId }),
          )
          .execute();
      }
      return c.body(null, 204);
    });
  app.get(
    '/v1/servers/:id/files/viewer',
    guarded(async (c) => {
      const { opened } = await open(c);
      try {
        return c.json({ size: opened.source.size, mtimeMs: opened.source.mtimeMs });
      } finally {
        await opened.close();
      }
    }),
  );
  app.get(
    '/v1/servers/:id/files/viewer/content',
    guarded(async (c) => {
      const { opened } = await open(c);
      try {
        const size = opened.source.size,
          range = viewerRange(c.req.header('Range'), size);
        if (!range) {
          await opened.close();
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` },
          });
        }
        const headers = {
          ...viewerHeaders(opened.path, size, range),
          ...(c.req.query('download') === 'true'
            ? { 'Content-Disposition': disposition(opened.path) }
            : {}),
        };
        if (c.req.method === 'HEAD') {
          await opened.close();
          return new Response(null, { status: range.partial ? 206 : 200, headers });
        }
        const timing = timings.get(c);
        if (timing) timing.streaming = true;
        return new Response(
          viewerBody(
            opened.source.stream(range.start, range.endExclusive),
            opened.signal,
            opened.close,
            timing,
          ),
          { status: range.partial ? 206 : 200, headers },
        );
      } catch (error) {
        await opened.close();
        throw error;
      }
    }),
  );
  app.get(
    '/v1/servers/:id/files/viewer/archive',
    guarded(async (c) => {
      const lease = await archive(c);
      try {
        const directory = c.req.query('directory') ?? '',
          offset = parse(z.coerce.number().int().min(0), c.req.query('offset') ?? '0'),
          limit = parse(z.coerce.number().int().min(1).max(500), c.req.query('limit') ?? '200'),
          query = parse(z.string().max(256), c.req.query('query') ?? ''),
          sort = parse(z.enum(['name', 'size', 'modifiedAt']), c.req.query('sort') ?? 'name'),
          direction = parse(z.enum(['asc', 'desc']), c.req.query('direction') ?? 'asc');
        return c.json({
          ...lease.session.list({ directory, offset, limit, query, sort, direction }),
          directory,
          offset,
          limit,
        });
      } finally {
        lease.release();
      }
    }),
  );
  app.on(
    ['GET', 'POST'],
    '/v1/servers/:id/files/viewer/archive/download',
    guarded(async (c) => {
      let directory = c.req.query('directory') ?? '';
      let selected = c.req.query('entries') ?? 'null';
      if (c.req.method === 'POST') {
        if (
          c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !==
          'application/x-www-form-urlencoded'
        )
          throw new DomainError('validation_failed');
        const form = await c.req.parseBody();
        directory = typeof form.directory === 'string' ? form.directory : '';
        selected = typeof form.entries === 'string' ? form.entries : 'null';
      }
      let paths: string[];
      try {
        paths = parse(
          z.array(z.string().min(1).max(1024)).min(1).max(25_000),
          JSON.parse(selected),
        );
      } catch {
        throw new DomainError('validation_failed');
      }
      const lease = await archive(c);
      try {
        directory = directory ? viewerArchivePath(directory) : '';
        const entries = selectArchiveEntries(lease.session, paths, directory).map((entry) => ({
          ...entry,
          name: directory ? entry.path.slice(directory.length + 1) : entry.path,
          file: { is_file: !entry.directory, size: entry.size },
        }));
        const signal = AbortSignal.any([c.req.raw.signal, lease.signal]);
        const stream = streamFileZip(
          entries,
          async (entry, transferSignal) =>
            (await lease.session.open(entry.path, transferSignal)).stream,
          signal,
        );
        const filename = `${posix.basename(c.req.query('path') ?? 'archive')}-selection.zip`;
        return new Response(
          viewerBody(stream, signal, async () => lease.release()),
          {
            headers: {
              'Content-Type': 'application/zip',
              'Content-Disposition': disposition(filename),
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        );
      } catch (error) {
        lease.release();
        throw error;
      }
    }),
  );
  app.get(
    '/v1/servers/:id/files/viewer/archive/content',
    guarded(async (c) => {
      const lease = await archive(c);
      try {
        const entry = c.req.query('entry') ?? '',
          file = await lease.session.open(entry, c.req.raw.signal);
        const range = viewerRange(c.req.header('Range'), file.size);
        if (!range) {
          await file.stream.cancel();
          lease.release();
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${file.size}` },
          });
        }
        if (c.req.method === 'HEAD') {
          await file.stream.cancel();
          lease.release();
          return new Response(null, {
            status: range.partial ? 206 : 200,
            headers: viewerHeaders(entry, file.size, range),
          });
        }
        // ZIP compressed members have no physical byte offset. Stream only up to
        // the requested end; never buffer the entire member in the HTTP layer.
        let offset = 0;
        const reader = file.stream.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            while (offset < range.endExclusive) {
              const { value, done } = await reader.read();
              if (done) {
                if (offset < range.endExclusive) throw new DomainError('conflict');
                controller.close();
                return;
              }
              const begin = Math.max(0, range.start - offset),
                end = Math.min(value.length, range.endExclusive - offset);
              offset += value.length;
              if (end > begin) {
                controller.enqueue(value.subarray(begin, end));
                return;
              }
            }
            if (range.endExclusive === file.size) {
              // Full members must drain decoder EOF, including CRC/size guards.
              const tail = await reader.read();
              if (!tail.done) throw new DomainError('conflict');
            } else await reader.cancel();
            controller.close();
          },
          async cancel() {
            await reader.cancel();
          },
        });
        const timing = timings.get(c);
        if (timing) timing.streaming = true;
        return new Response(
          viewerBody(
            body,
            AbortSignal.any([c.req.raw.signal, lease.signal]),
            async () => {
              lease.release();
            },
            timing,
          ),
          {
            status: range.partial ? 206 : 200,
            headers: {
              ...viewerHeaders(entry, file.size, range),
              ...(c.req.query('download') === 'true'
                ? { 'Content-Disposition': disposition(entry) }
                : {}),
            },
          },
        );
      } catch (error) {
        lease.release();
        throw error;
      }
    }),
  );
  app.get(
    '/v1/servers/:id/files/viewer/subtitles',
    guarded(async (c) => {
      const track = parse(z.string().min(1).max(32).regex(/^\d+$/), c.req.query('track'));
      const time = parse(
        z.coerce
          .number()
          .finite()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER / 1000 - 20),
        c.req.query('time') ?? '0',
      );
      const lease = await retained(c, subtitles, async (opened) => {
        const { createSubtitleViewer } = await import('./viewer-subtitles.js');
        return createSubtitleViewer(opened.source, { signal: opened.signal });
      });
      try {
        const timing = timings.get(c);
        const work = () => lease.session.readWindow(track, time, c.req.raw.signal);
        return c.json(timing ? await timing.measure('subtitleWindow', work) : await work());
      } finally {
        lease.release();
      }
    }),
  );
  const sqliteQuery = (c: C): DatagridQuery => ({
    table: c.req.query('table') ?? '',
    offset: parse(z.coerce.number().int().min(0).max(1_000_000), c.req.query('offset') ?? '0'),
    limit: 100,
    query: parse(z.string().max(200).optional(), c.req.query('query')),
    filterColumn: c.req.query('filterColumn'),
    sort: c.req.query('sort'),
    direction: parse(z.enum(['asc', 'desc']).optional(), c.req.query('direction')),
  });
  app.get(
    '/v1/servers/:id/files/viewer/sqlite',
    guarded(async (c) => {
      const query = sqliteQuery(c);
      const lease = await sqlite(c);
      try {
        const tables = lease.session.tables().map((row) => row.name);
        const table = c.req.query('table') ?? tables[0];
        const page =
          table === undefined
            ? undefined
            : await lease.session.rows(
                { ...query, table },
                AbortSignal.any([c.req.raw.signal, lease.signal]),
              );
        const result: DatagridPage = {
          tables,
          revision: lease.session.revision,
          consistency: lease.session.consistency,
          ...(page
            ? {
                table,
                columns: page.columns.map((column) => column.name),
                schema: page.columns,
                rows: page.rows,
                offset: page.offset,
                hasMore: page.nextOffset !== null,
              }
            : { columns: [], schema: [], rows: [], offset: 0, hasMore: false }),
        };
        return c.json(result);
      } finally {
        lease.release();
      }
    }),
  );
  app.get(
    '/v1/servers/:id/files/viewer/sqlite/cell',
    guarded(async (c) => {
      const query = sqliteQuery(c);
      const rowOffset = parse(
        z.coerce.number().int().min(0).max(1_000_000),
        c.req.query('rowOffset'),
      );
      const start = parse(
        z.coerce
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER - 65537),
        c.req.query('start') ?? '0',
      );
      const column = parse(z.string(), c.req.query('column'));
      const revision = parse(z.string().min(1).max(128), c.req.query('revision'));
      const lease = await sqlite(c);
      try {
        return c.json(
          await lease.session.cell(
            { ...query, rowOffset, start, column, revision },
            AbortSignal.any([c.req.raw.signal, lease.signal]),
          ),
        );
      } finally {
        lease.release();
      }
    }),
  );
}
