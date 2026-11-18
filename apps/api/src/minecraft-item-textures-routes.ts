import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import { permissionRuntime } from '../../../packages/server-management/src/permission-runtime.js';
import type { Variables } from './app.js';
import { getFileViewerService } from './file-viewers.js';
import {
  MinecraftItemTextureCache,
  type MinecraftTextureArchive,
  minecraftTextureIds,
  minecraftTextureJars,
} from './minecraft-item-textures.js';
import type { MinecraftPlayerRouteOptions } from './minecraft-players.js';
import { createArchiveViewer } from './viewer-archive.js';
import { ViewerFormatError } from './viewer-cache.js';

export function registerMinecraftItemTextureRoutes(
  app: Hono<{ Variables: Variables }>,
  options: MinecraftPlayerRouteOptions,
  profile: (connection: MinecraftPlayerRouteOptions['db'], serverId: string) => Promise<unknown>,
) {
  const cache = new MinecraftItemTextureCache();
  app.get('/v1/servers/:id/minecraft/item-textures', async (c) => {
    const context = await options.principal(c);
    const serverId = c.req.param('id');
    const ids = minecraftTextureIds(c.req.query('ids'));
    const service = permissionRuntime(await options.management(), 'game.minecraft.players');
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]);
    const textures = await service.fileReadScope(
      context,
      serverId,
      async (files, _identifier, connection, _current, server) => {
        await profile(connection, serverId);
        const mods = (await files.list('')).find((entry) => entry.name === 'mods');
        if (!mods) return {};
        if (mods.kind !== 'directory') throw new DomainError('integration_unavailable');
        const jars = minecraftTextureJars(await files.list('mods'));
        if (!jars.length) return {};
        if (!options.codec) throw new DomainError('integration_unavailable');
        const viewer = await getFileViewerService({
          db: options.db,
          env: options.env,
          codec: options.codec,
        });
        return cache.resolve(
          service.uploadBatchBinding(server),
          jars,
          ids,
          async (jar, requestSignal) => {
            const source = await viewer.open(
              context,
              service,
              serverId,
              jar.path,
              requestSignal,
              'game.minecraft.players.read',
            );
            const matches = (stat: { size: number; mtimeMs: number }) =>
              stat.size === jar.size &&
              Math.floor(stat.mtimeMs / 1000) === Math.floor(Date.parse(jar.modifiedAt) / 1000);
            try {
              if (!matches(source.source)) throw new DomainError('conflict');
              const archive = await createArchiveViewer(source.source, {
                name: jar.path,
                key: source.key,
                cache: source.cache,
                signal: source.signal,
                limits: { maxEntries: 100_000, maxMetadataBytes: 32 * 1024 ** 2 },
              });
              let closed = false;
              const handle: MinecraftTextureArchive = {
                *assets() {
                  const queue = ['assets'];
                  for (let index = 0; index < queue.length; index++) {
                    let offset: number | null = 0;
                    do {
                      let page: ReturnType<typeof archive.list>;
                      try {
                        page = archive.list({ directory: queue[index], offset, limit: 500 });
                      } catch (error) {
                        if (
                          error instanceof ViewerFormatError &&
                          error.code === 'viewer_archive_not_found'
                        )
                          break;
                        throw error;
                      }
                      for (const entry of page.entries) {
                        if (entry.directory) queue.push(entry.path);
                        else yield entry.path;
                      }
                      offset = page.nextOffset;
                    } while (offset !== null);
                  }
                },
                async read(path, maximum) {
                  const entry = await archive.open(path, source.signal);
                  if (entry.size > maximum) {
                    await entry.stream.cancel();
                    throw new ViewerFormatError('viewer_archive_budget');
                  }
                  const reader = entry.stream.getReader();
                  const chunks: Buffer[] = [];
                  let size = 0;
                  try {
                    for (;;) {
                      source.signal.throwIfAborted();
                      const part = await reader.read();
                      if (part.done) break;
                      size += part.value.length;
                      if (size > maximum) throw new ViewerFormatError('viewer_archive_budget');
                      chunks.push(Buffer.from(part.value));
                    }
                    return Buffer.concat(chunks);
                  } finally {
                    await reader.cancel().catch(() => {});
                  }
                },
                async close() {
                  if (closed) return;
                  closed = true;
                  try {
                    if (!source.signal.aborted && !matches(await source.restat()))
                      throw new DomainError('conflict');
                  } finally {
                    archive.close();
                    await source.close();
                  }
                },
              };
              return handle;
            } catch (error) {
              await source.close();
              throw error;
            }
          },
          signal,
        );
      },
      signal,
    );
    c.header('Cache-Control', 'no-store');
    return c.json({ textures });
  });
}
