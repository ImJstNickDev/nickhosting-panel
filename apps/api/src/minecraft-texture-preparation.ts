import { setTimeout as delay } from 'node:timers/promises';
import { DomainError, runtimeStorageRoot } from '@nickhosting/core';
import { inspectMinecraftCombination } from '@nickhosting/server-management';
import { verifyManagedIdentity } from '../../../packages/server-management/src/lifecycle.js';
import { getFileViewerService } from './file-viewers.js';
import type { MinecraftTextureJar } from './minecraft-item-textures.js';
import type { MinecraftPlayerRouteOptions } from './minecraft-players.js';
import {
  installedModJars,
  inventoryTextureCache,
  openTextureArchive,
} from './minecraft-texture-archives.js';
import { getMinecraftVanillaResources } from './minecraft-vanilla-resources.js';

type Options = Required<Pick<MinecraftPlayerRouteOptions, 'db' | 'env' | 'management' | 'codec'>>;
function candidates(db: Options['db']) {
  return db
    .selectFrom('managed_servers as s')
    .innerJoin('minecraft_server_profiles as p', 'p.server_id', 's.id')
    .where('s.deleted_at', 'is', null)
    .where('s.active_operation_id', 'is', null)
    .where('p.installed', '=', true)
    .where('s.pterodactyl_identifier', 'is not', null);
}

async function prepare(options: Options, id: string, signal: AbortSignal) {
  const { db } = options;
  const viewer = await getFileViewerService(options);
  const service = await options.management();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const current = () =>
    candidates(db)
      .selectAll('s')
      .select('p.combination_id')
      .where('s.id', '=', id)
      .executeTakeFirst();
  const server = await current();
  if (!server?.pterodactyl_id || !server.pterodactyl_uuid || !server.pterodactyl_identifier) return;
  const uuid = server.pterodactyl_uuid;
  const choice = await inspectMinecraftCombination(db, server.combination_id, options.env);
  if (!choice.capabilities.playerManagement) return;
  const remote = await service.adapter.getApplicationServer(server.pterodactyl_id);
  await verifyManagedIdentity(db, server, remote);
  const identity = service.uploadBatchBinding(server);
  const checkBinding = async () => {
    const fresh = await current();
    if (
      !fresh ||
      fresh.combination_id !== server.combination_id ||
      service.uploadBatchBinding(fresh) !== identity
    )
      throw new DomainError('conflict');
  };
  const files = service.fileReadPhase(server.pterodactyl_identifier, server, deadline);
  const jars = await installedModJars(files);
  if (!jars.length) return;
  if (!viewer.configured(await viewer.settings())) throw new DomainError('integration_unavailable');
  await checkBinding();
  const vanilla = await getMinecraftVanillaResources(
    choice.combination.release,
    runtimeStorageRoot(options.env),
  );
  const cache = inventoryTextureCache(db, options.env);
  const open = async (jar: MinecraftTextureJar, archiveSignal: AbortSignal) =>
    openTextureArchive(
      jar,
      await viewer.openMinecraftMod(id, uuid, identity, jar.path, archiveSignal, checkBinding),
    );
  await cache.resolve(identity, jars, [], open, deadline, vanilla);
  // Fill thumbnails in short groups; leave the broker and event loop free between batches.
  const end = performance.now() + 2000;
  while (
    performance.now() < end &&
    (await cache.prepareNext(identity, jars, open, deadline, vanilla))
  ) {
    await delay(75, undefined, { signal: deadline });
  }
}

const wakeups = new WeakMap<object, (id: string) => void>();

export function requestTexturePreparation(db: object, id: string) {
  const wake = wakeups.get(db);
  if (!wake) throw new DomainError('integration_unavailable');
  wake(id);
}

export function startMinecraftTexturePreparation(
  options: Options,
  failed: (serverId?: string) => void,
) {
  const visit = async () => {
    const viewer = await getFileViewerService(options);
    if (!viewer.configured(await viewer.settings())) return [];
    return (await candidates(options.db).select('s.id').orderBy('s.id').execute()).map(
      (row) => row.id,
    );
  };
  const schedule = scheduleMinecraftTextures(
    visit,
    (id, signal) => prepare(options, id, signal),
    failed,
  );
  wakeups.set(options.db, schedule.request);
  return async () => {
    wakeups.delete(options.db);
    await schedule.close();
  };
}

/** One server at a time. Request handlers enqueue missing packs and return immediately. */
export function scheduleMinecraftTextures(
  list: () => Promise<string[]>,
  prepareOne: (id: string, signal: AbortSignal) => Promise<void>,
  failed: (id?: string) => void,
) {
  const controller = new AbortController();
  const queue = new Set<string>();
  const failures = new Map<string, number>();
  let active: string | undefined;
  let busy: Promise<void> | undefined;
  let listing: Promise<void> | undefined;
  const drain = () => {
    if (busy || controller.signal.aborted) return;
    busy = (async () => {
      for (const id of queue) {
        queue.delete(id);
        if (controller.signal.aborted) break;
        active = id;
        try {
          await prepareOne(id, controller.signal);
          failures.delete(id);
        } catch {
          if (!controller.signal.aborted) {
            if (failures.size >= 1024) failures.delete(failures.keys().next().value as string);
            failures.set(id, Date.now());
            failed(id);
          }
        } finally {
          active = undefined;
        }
      }
    })().finally(() => {
      busy = undefined;
      if (queue.size && !controller.signal.aborted) drain();
    });
  };
  const discover = () => {
    listing = list()
      .then((ids) => {
        for (const id of ids) if (active !== id) queue.add(id);
        drain();
      })
      .catch(() => {
        if (!controller.signal.aborted) failed();
      })
      .finally(() => {
        if (!controller.signal.aborted) timer = setTimeout(discover, 300_000).unref();
      });
  };
  let timer = setTimeout(discover, 1000).unref();
  return {
    request(id: string) {
      if ((failures.get(id) ?? 0) + 15_000 > Date.now())
        throw new DomainError('integration_unavailable');
      if (id !== active) queue.add(id);
      drain();
    },
    async close() {
      controller.abort();
      clearTimeout(timer);
      queue.clear();
      await listing;
      await busy;
    },
  };
}
