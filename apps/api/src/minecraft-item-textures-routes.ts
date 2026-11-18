import { DomainError, runtimeStorageRoot } from '@nickhosting/core';
import type { inspectMinecraftCombination } from '@nickhosting/server-management';
import type { Hono } from 'hono';
import { permissionRuntime } from '../../../packages/server-management/src/permission-runtime.js';
import type { Variables } from './app.js';
import { getFileViewerService } from './file-viewers.js';
import { minecraftTextureIds, minecraftTextureRevision } from './minecraft-item-textures.js';
import type { MinecraftPlayerRouteOptions } from './minecraft-players.js';
import {
  installedModJars,
  inventoryTextureCache,
  openTextureArchive,
} from './minecraft-texture-archives.js';
import { requestTexturePreparation } from './minecraft-texture-preparation.js';
import { getMinecraftVanillaResources } from './minecraft-vanilla-resources.js';

export function registerMinecraftItemTextureRoutes(
  app: Hono<{ Variables: Variables }>,
  options: MinecraftPlayerRouteOptions,
  profile: (
    connection: MinecraftPlayerRouteOptions['db'],
    serverId: string,
  ) => ReturnType<typeof inspectMinecraftCombination>,
) {
  app.get('/v1/servers/:id/minecraft/item-textures', async (c) => {
    const context = await options.principal(c);
    const serverId = c.req.param('id');
    const ids = minecraftTextureIds(c.req.query('ids'));
    const service = permissionRuntime(await options.management(), 'game.minecraft.players');
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]);
    const result = await service.fileReadScope(
      context,
      serverId,
      async (files, _id, connection, _current, server) => {
        const choice = await profile(connection, serverId);
        const [jars, vanilla] = await Promise.all([
          installedModJars(files),
          getMinecraftVanillaResources(choice.combination.release, runtimeStorageRoot(options.env)),
        ]);
        const identity = service.uploadBatchBinding(server);
        const revision = minecraftTextureRevision(identity, jars, vanilla?.revision);
        const known =
          c.req.query('revision') === revision
            ? new Set(c.req.query('known')?.split(','))
            : new Set<string>();
        const needed = ids.filter((id) => !known.has(id));
        let partial: Record<string, string> = {};
        const textures = needed.length
          ? await inventoryTextureCache(options.db, options.env).resolvePrepared(
              identity,
              jars,
              needed,
              async (jar, requestSignal) => {
                if (!options.codec) throw new DomainError('integration_unavailable');
                const viewer = await getFileViewerService({
                  db: options.db,
                  env: options.env,
                  codec: options.codec,
                });
                return openTextureArchive(
                  jar,
                  await viewer.open(
                    context,
                    service,
                    serverId,
                    jar.path,
                    requestSignal,
                    'game.minecraft.players.read',
                  ),
                );
              },
              signal,
              vanilla,
              (hits) => {
                partial = hits;
              },
            )
          : {};
        return { revision, textures: textures ?? partial, preparing: textures === undefined };
      },
      signal,
    );
    c.header('Cache-Control', 'no-store');
    if (result.preparing) {
      requestTexturePreparation(options.db, serverId);
      c.header('Retry-After', '2');
      return c.json(result, 202);
    }
    return c.json(result);
  });
}
