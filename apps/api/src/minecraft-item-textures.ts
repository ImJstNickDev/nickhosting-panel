import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import type { FilemanEntry } from '@nickhosting/game-sdk';
import { renderMinecraftItemModel, itemResource as resource } from './minecraft-item-model.js';
import { MinecraftTextureStore } from './minecraft-texture-store.js';
import type { MinecraftVanillaResources } from './minecraft-vanilla-resources.js';

const MAX_CATALOG_BYTES = 24 * 1024 ** 2;
const MAX_CACHE_BYTES = 64 * 1024 ** 2;
export function minecraftTextureIds(input: string | undefined): string[] {
  const ids = input?.split(',') ?? [];
  if (!ids.length || ids.length > 64 || ids.some((id) => resource(id) !== id))
    throw new DomainError('validation_failed');
  return [...new Set(ids)].sort();
}
export interface MinecraftTextureJar {
  path: string;
  size: number;
  modifiedAt: string;
}
export function minecraftTextureJars(entries: readonly FilemanEntry[]): MinecraftTextureJar[] {
  const jars = entries.filter((entry) => entry.kind === 'file' && entry.name.endsWith('.jar'));
  if (jars.length > 512) throw new DomainError('resources_unavailable');
  return jars
    .map((entry) => {
      if (
        /[/\\]/.test(entry.name) ||
        [...entry.name].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        !entry.modifiedAt ||
        !Number.isFinite(Date.parse(entry.modifiedAt)) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 1 ||
        entry.size > 512 * 1024 ** 2
      )
        throw new DomainError('integration_unavailable');
      return { path: `mods/${entry.name}`, size: entry.size, modifiedAt: entry.modifiedAt };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
export interface MinecraftTextureArchive {
  assets(): Iterable<string>;
  read(path: string, maximum: number): Promise<Uint8Array | undefined>;
  close(): Promise<void>;
}
type OpenArchive = (
  jar: MinecraftTextureJar,
  signal: AbortSignal,
) => Promise<MinecraftTextureArchive>;
type Catalog = {
  resources: Map<string, MinecraftTextureJar | null>;
  textures: Map<string, string | undefined>;
  bytes: number;
  preparation?: { ids: string[]; cursor?: number; active: boolean };
};
type Pending<T> = { controller: AbortController; consumers: number; promise: Promise<T> };
function consume<T>(pending: Pending<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  pending.consumers++;
  return new Promise<T>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener('abort', abort);
      if (--pending.consumers === 0) pending.controller.abort();
    };
    const abort = () => {
      release();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    pending.promise.then(
      (result) => {
        release();
        resolve(result);
      },
      (error) => {
        release();
        reject(error);
      },
    );
  });
}

function digest(parts: unknown[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// Bump the render version when a changed renderer would produce different PNGs.
export function minecraftTextureRevision(
  identity: string,
  jars: readonly MinecraftTextureJar[],
  vanillaRevision?: string,
) {
  return digest(['pack-v2', identity, jars, vanillaRevision]);
}

export function catalogPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length <= 1024 &&
    /^assets\/[a-z0-9_.-]+\/(?:(?:models|items)\/[a-z0-9_./-]+\.json|textures\/[a-z0-9_./-]+\.png|models\/[a-z0-9_./-]+\.(?:obj(?:\.(?:mek|ie))?|mtl))$/.test(
      path,
    ) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

function responseBudget(output: Record<string, string>) {
  if (
    Object.values(output).reduce((bytes, texture) => bytes + texture.length * 2, 0) >
    8 * 1024 ** 2
  )
    throw new DomainError('resources_unavailable');
  return output;
}

/** Pack images and per-archive metadata are reusable across API restarts. Open handles stay scoped to each authorized call. */
export class MinecraftItemTextureCache {
  readonly #catalogs = new Map<string, Catalog>();
  readonly #pending = new Map<string, Pending<Catalog>>();
  readonly #renders = new Map<string, Pending<Record<string, string | undefined>>>();
  readonly #store?: MinecraftTextureStore;

  constructor(cacheRoot?: string) {
    if (cacheRoot) this.#store = new MinecraftTextureStore(cacheRoot);
  }

  async close() {
    await this.#store?.close();
  }

  #retain(key: string, catalog: Catalog) {
    this.#catalogs.delete(key);
    this.#catalogs.set(key, catalog);
    let size = [...this.#catalogs.values()].reduce((sum, value) => sum + value.bytes, 0);
    while (this.#catalogs.size > 8 || size > MAX_CACHE_BYTES) {
      const oldest = this.#catalogs.entries().next().value;
      if (!oldest) break;
      size -= oldest[1].bytes;
      this.#catalogs.delete(oldest[0]);
    }
  }
  async resolve(
    identity: string,
    jars: readonly MinecraftTextureJar[],
    ids: readonly string[],
    open: OpenArchive,
    signal: AbortSignal,
    vanilla?: MinecraftVanillaResources,
  ): Promise<Record<string, string>> {
    return (await this.#resolve(identity, jars, ids, open, signal, vanilla, true)) ?? {};
  }

  /** Foreground reads can render from a prepared catalog or retrieve persistent hits.
   * Undefined means that missing textures require an index that is still cold. */
  resolvePrepared(
    identity: string,
    jars: readonly MinecraftTextureJar[],
    ids: readonly string[],
    open: OpenArchive,
    signal: AbortSignal,
    vanilla?: MinecraftVanillaResources,
    onPending?: (textures: Record<string, string>) => void,
  ) {
    return this.#resolve(identity, jars, ids, open, signal, vanilla, false, onPending);
  }

  async #resolve(
    identity: string,
    jars: readonly MinecraftTextureJar[],
    ids: readonly string[],
    open: OpenArchive,
    signal: AbortSignal,
    vanilla: MinecraftVanillaResources | undefined,
    waitForScan: boolean,
    onPending?: (textures: Record<string, string>) => void,
  ): Promise<Record<string, string> | undefined> {
    signal.throwIfAborted();
    const key = minecraftTextureRevision(identity, jars, vanilla?.revision);
    let catalog = this.#catalogs.get(key);
    const output: Record<string, string> = {};
    const unresolved: string[] = [];
    // Reserve a running scan for blocking consumers during disk lookup, so cancellation
    // by its original caller cannot cancel work already needed by another caller.
    const running = waitForScan ? this.#pending.get(key) : undefined;
    const reservation =
      running && !running.controller.signal.aborted ? new AbortController() : undefined;
    const joined =
      running && reservation
        ? consume(running, AbortSignal.any([signal, reservation.signal]))
        : undefined;
    void joined?.catch(() => {});
    let cachedBytes = 0;
    try {
      // Durable hits remain immediately available even during background preparation.
      for (const id of ids) {
        const texture = catalog?.textures.has(id)
          ? (catalog.textures.get(id) ?? '')
          : this.#store
            ? await this.#store.read(digest(['png', key, id]))
            : undefined;
        signal.throwIfAborted();
        if (texture === undefined) unresolved.push(id);
        else if (texture) {
          output[id] = texture;
          cachedBytes += texture.length * 2;
          if (cachedBytes > 8 * 1024 ** 2) throw new DomainError('resources_unavailable');
        }
      }
      if (ids.length && !unresolved.length) return output;
      if (joined) catalog = await joined;
    } finally {
      reservation?.abort();
    }
    catalog ??= this.#catalogs.get(key);
    if (!catalog && !jars.length) catalog = { resources: new Map(), textures: new Map(), bytes: 0 };
    if (!catalog && !waitForScan) {
      onPending?.(output);
      return;
    }
    if (!catalog) {
      let pending = this.#pending.get(key);
      if (!pending || pending.controller.signal.aborted) {
        if (this.#pending.size >= 4) throw new DomainError('resources_unavailable');
        const controller = new AbortController();
        const work: Pending<Catalog> = {
          controller,
          consumers: 0,
          promise: Promise.resolve(null as never),
        };
        work.promise = this.#index(identity, jars, open, controller.signal)
          .then((value) => {
            controller.signal.throwIfAborted();
            this.#retain(key, value);
            return value;
          })
          .finally(() => {
            if (this.#pending.get(key) === work) this.#pending.delete(key);
          });
        this.#pending.set(key, work);
        pending = work;
      }
      catalog = await consume(pending, signal);
    }
    const current = catalog;
    this.#retain(key, current);
    const missing = unresolved.filter((id) => !current.textures.has(id)).sort();
    if (missing.length) {
      const renderKey = `${key}:${missing.join(',')}`;
      let pending = this.#renders.get(renderKey);
      if (!pending || pending.controller.signal.aborted) {
        if (this.#renders.size >= 4) throw new DomainError('resources_unavailable');
        const controller = new AbortController();
        const work: Pending<Record<string, string | undefined>> = {
          controller,
          consumers: 0,
          promise: Promise.resolve({}),
        };
        work.promise = renderBatch(current.resources, missing, open, controller.signal, vanilla)
          .then(async (textures) => {
            controller.signal.throwIfAborted();
            await this.#store?.write(
              Object.entries(textures).map(([id, texture]) => [
                digest(['png', key, id]),
                texture ?? '',
              ]),
            );
            controller.signal.throwIfAborted();
            for (const [id, texture] of Object.entries(textures)) {
              if (current.textures.has(id) || current.textures.size >= 1024) continue;
              const bytes = id.length * 2 + (texture?.length ?? 0) * 2 + 64;
              if (current.bytes + bytes <= MAX_CATALOG_BYTES) {
                current.textures.set(id, texture);
                current.bytes += bytes;
              }
            }
            this.#retain(key, current);
            return textures;
          })
          .finally(() => {
            if (this.#renders.get(renderKey) === work) this.#renders.delete(renderKey);
          });
        this.#renders.set(renderKey, work);
        pending = work;
      }
      for (const [id, texture] of Object.entries(await consume(pending, signal)))
        if (texture) output[id] = texture;
    }
    for (const id of ids) {
      const value = current.textures.get(id);
      if (value) output[id] = value;
    }
    return responseBudget(output);
  }

  /** The scheduler calls this once per turn. Keep smaller packs and interactive lookups
   * responsive by yielding between bounded batches and keeping no archive handles open. */
  async prepareNext(
    identity: string,
    jars: readonly MinecraftTextureJar[],
    open: OpenArchive,
    signal: AbortSignal,
    vanilla?: MinecraftVanillaResources,
    limit = 4,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const key = minecraftTextureRevision(identity, jars, vanilla?.revision);
    const catalog = this.#catalogs.get(key);
    if (!catalog) return false;
    if (this.#renders.size) return true;
    if (!catalog.preparation) {
      const ids = new Set<string>();
      const add = (id: string) => {
        if (ids.has(id) || resource(id) !== id) return;
        const bytes = id.length * 2 + 64;
        if (catalog.bytes + bytes > MAX_CATALOG_BYTES) return;
        ids.add(id);
        catalog.bytes += bytes;
      };
      for (const [path, jar] of catalog.resources) {
        if (!jar) continue;
        const model = /^assets\/([^/]+)\/(?:models\/item|items)\/(.+)\.json$/.exec(path);
        if (model) add(`${model[1]}:${model[2]}`);
      }
      for (const id of vanilla?.itemIds?.() ?? []) add(id);
      catalog.preparation = { ids: [...ids].sort(), active: false };
      this.#retain(key, catalog);
    }
    const prep = catalog.preparation;
    if (prep.active) return true;
    prep.active = true;
    try {
      const checkpoint = digest(['bake-cursor', key]);
      if (prep.cursor === undefined) {
        const cursor = Number(await this.#store?.read(checkpoint));
        prep.cursor =
          Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= prep.ids.length ? cursor : 0;
      }
      if (prep.cursor === prep.ids.length) return false;
      // Four maximum-size PNGs fit under the per-response byte budget.
      const count = Math.max(1, Math.min(4, Math.trunc(limit) || 1));
      const ids = prep.ids.slice(prep.cursor, prep.cursor + count);
      const result = await this.resolvePrepared(identity, jars, ids, open, signal, vanilla);
      if (!result) return true;
      const next = prep.cursor + ids.length;
      await this.#store?.write([[checkpoint, String(next)]], true);
      prep.cursor = next;
      return next < prep.ids.length;
    } finally {
      prep.active = false;
    }
  }

  async #archivePaths(
    identity: string,
    jar: MinecraftTextureJar,
    open: OpenArchive,
    signal: AbortSignal,
  ): Promise<string[]> {
    const key = digest(['jar-paths-v2', identity, jar]);
    const stored = await this.#store?.read(key);
    if (stored !== undefined) {
      const paths: unknown = JSON.parse(stored);
      if (Array.isArray(paths) && paths.length <= 100_000 && paths.every(catalogPath)) return paths;
      throw new DomainError('integration_unavailable');
    }
    signal.throwIfAborted();
    const archive = await open(jar, signal);
    const paths: string[] = [];
    let bytes = 0;
    try {
      for (const path of archive.assets()) {
        if (!catalogPath(path)) continue;
        bytes += path.length * 2 + 128;
        if (bytes > MAX_CATALOG_BYTES || paths.length >= 100_000)
          throw new DomainError('resources_unavailable');
        paths.push(path);
      }
    } finally {
      await archive.close();
    }
    signal.throwIfAborted();
    if (this.#store) await this.#store.write([[key, JSON.stringify(paths)]]);
    return paths;
  }

  async #index(
    identity: string,
    jars: readonly MinecraftTextureJar[],
    open: OpenArchive,
    signal: AbortSignal,
  ) {
    const catalog: Catalog = {
      resources: new Map(),
      textures: new Map(),
      bytes: 0,
    };
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, jars.length) }, async () => {
        while (next < jars.length) {
          signal.throwIfAborted();
          const jar = jars[next++];
          if (!jar) break;
          const paths = await this.#archivePaths(identity, jar, open, signal);
          signal.throwIfAborted();
          for (const path of paths) {
            // Ambiguous overrides have no trustworthy pack order.
            if (catalog.resources.has(path)) catalog.resources.set(path, null);
            else {
              catalog.bytes += path.length * 2 + 128;
              if (catalog.bytes > MAX_CATALOG_BYTES) throw new DomainError('resources_unavailable');
              catalog.resources.set(path, jar);
            }
          }
        }
      }),
    );
    return catalog;
  }
}

async function renderBatch(
  resources: ReadonlyMap<string, MinecraftTextureJar | null>,
  ids: readonly string[],
  open: OpenArchive,
  signal: AbortSignal,
  vanilla?: MinecraftVanillaResources,
): Promise<Record<string, string | undefined>> {
  const archives = new Map<string, MinecraftTextureArchive>();
  const read = async (path: string, maximum: number) => {
    signal.throwIfAborted();
    const jar = resources.get(path);
    if (jar === undefined) return vanilla?.read(path, maximum);
    if (jar === null) return;
    let archive = archives.get(jar.path);
    if (!archive) {
      // Most inventory items share one mod; reuse its ZIP index without retaining
      // handles across requests or allowing one batch to exhaust the shared broker.
      if (archives.size >= 8) {
        const oldest = archives.entries().next().value;
        if (oldest) {
          archives.delete(oldest[0]);
          await oldest[1].close();
        }
      }
      archive = await open(jar, signal);
      archives.set(jar.path, archive);
    }
    return archive.read(path, maximum);
  };
  try {
    const result: Record<string, string | undefined> = {};
    let bytes = 0;
    for (const id of ids) {
      signal.throwIfAborted();
      const texture = await renderMinecraftItemModel(
        id,
        (path) => resources.has(path) || Boolean(vanilla?.has(path)),
        read,
        signal,
      );
      bytes += (texture?.length ?? 0) * 2;
      if (bytes > 8 * 1024 ** 2) throw new DomainError('resources_unavailable');
      result[id] = texture;
    }
    return result;
  } finally {
    await Promise.all([...archives.values()].map((archive) => archive.close()));
  }
}
