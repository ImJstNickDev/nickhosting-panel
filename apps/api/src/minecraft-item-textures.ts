import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import type { FilemanEntry } from '@nickhosting/game-sdk';
import { renderMinecraftItemModel, itemResource as resource } from './minecraft-item-model.js';

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
  expiresAt: number;
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

/** Process-local, bounded asset metadata/PNG cache. No open files or credentials are retained. */
export class MinecraftItemTextureCache {
  readonly #catalogs = new Map<string, Catalog>();
  readonly #pending = new Map<string, Pending<Catalog>>();
  readonly #renders = new Map<string, Pending<Record<string, string | undefined>>>();
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
  ): Promise<Record<string, string>> {
    signal.throwIfAborted();
    const key = createHash('sha256')
      .update(JSON.stringify([identity, jars]))
      .digest('hex');
    let catalog = this.#catalogs.get(key);
    if (catalog && catalog.expiresAt < Date.now()) {
      this.#catalogs.delete(key);
      catalog = undefined;
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
        work.promise = this.#index(jars, open, controller.signal)
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
    const output: Record<string, string> = {};
    const missing = ids.filter((id) => !current.textures.has(id)).sort();
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
        work.promise = renderBatch(current.resources, missing, open, controller.signal)
          .then((textures) => {
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
    if (
      Object.values(output).reduce((bytes, texture) => bytes + texture.length * 2, 0) >
      8 * 1024 ** 2
    )
      throw new DomainError('resources_unavailable');
    return output;
  }
  async #index(jars: readonly MinecraftTextureJar[], open: OpenArchive, signal: AbortSignal) {
    const catalog: Catalog = {
      resources: new Map(),
      textures: new Map(),
      bytes: 0,
      expiresAt: Date.now() + 300_000,
    };
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, jars.length) }, async () => {
        while (next < jars.length) {
          signal.throwIfAborted();
          const jar = jars[next++];
          if (!jar) break;
          const archive = await open(jar, signal);
          try {
            for (const path of archive.assets()) {
              if (
                !/^assets\/[a-z0-9_.-]+\/(?:models|items)\/[a-z0-9_./-]+\.json$/.test(path) &&
                !/^assets\/[a-z0-9_.-]+\/textures\/[a-z0-9_./-]+\.png$/.test(path) &&
                !/^assets\/[a-z0-9_.-]+\/models\/[a-z0-9_./-]+\.(?:obj(?:\.mek)?|mtl)$/.test(path)
              )
                continue;
              if (path.split('/').some((part) => !part || part === '.' || part === '..')) continue;
              // Ambiguous overrides have no trustworthy pack-order; never guess between two mods.
              if (catalog.resources.has(path)) catalog.resources.set(path, null);
              else {
                catalog.bytes += path.length * 2 + 128;
                if (catalog.bytes > MAX_CATALOG_BYTES)
                  throw new DomainError('resources_unavailable');
                catalog.resources.set(path, jar);
              }
            }
          } finally {
            await archive.close();
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
): Promise<Record<string, string | undefined>> {
  const archives = new Map<string, MinecraftTextureArchive>();
  const read = async (path: string, maximum: number) => {
    signal.throwIfAborted();
    const jar = resources.get(path);
    if (!jar) return;
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
        (path) => resources.has(path),
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
