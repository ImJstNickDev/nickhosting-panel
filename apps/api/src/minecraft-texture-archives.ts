import { DomainError, runtimeStorageRoot } from '@nickhosting/core';
import type { FilemanReadService } from '@nickhosting/game-sdk';
import {
  catalogPath,
  MinecraftItemTextureCache,
  type MinecraftTextureArchive,
  type MinecraftTextureJar,
  minecraftTextureJars,
} from './minecraft-item-textures.js';
import { openSelectedZip, type SelectedZipDirectory } from './viewer-archive.js';
import { ViewerFormatError } from './viewer-cache.js';
import type { FileViewerService } from './viewer-service.js';

const caches = new WeakMap<object, MinecraftItemTextureCache>();
export function inventoryTextureCache(
  db: object,
  env: Readonly<Record<string, string | undefined>>,
) {
  let cache = caches.get(db);
  if (!cache) {
    cache = new MinecraftItemTextureCache(runtimeStorageRoot(env));
    caches.set(db, cache);
  }
  return cache;
}

export async function closeInventoryTextureCache(db: object) {
  const cache = caches.get(db);
  caches.delete(db);
  await cache?.close();
}

export async function installedModJars(files: FilemanReadService) {
  const mods = (await files.list('')).find((entry) => entry.name === 'mods');
  if (!mods) return [];
  if (mods.kind !== 'directory') throw new DomainError('integration_unavailable');
  return minecraftTextureJars(await files.list('mods'));
}

// One bounded directory cache per configured viewer generation. Source keys include
// server binding, viewer settings, path, size and exact provider modification time.
class ResourceZipDirectories {
  readonly entries = new Map<string, SelectedZipDirectory>();
  bytes = 0;
  retain(key: string, directory: SelectedZipDirectory) {
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.bytes -= old.bytes;
    }
    this.entries.set(key, directory);
    this.bytes += directory.bytes;
    while (this.bytes > 48 * 1024 ** 2 || this.entries.size > 512) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
  }
}
const sourceDirectories = new WeakMap<object, ResourceZipDirectories>();

export async function openTextureArchive(
  jar: MinecraftTextureJar,
  source: Pick<
    Awaited<ReturnType<FileViewerService['open']>>,
    'source' | 'signal' | 'cache' | 'key' | 'restat' | 'close'
  >,
): Promise<MinecraftTextureArchive> {
  const matches = (stat: { size: number; mtimeMs: number }) =>
    stat.size === jar.size &&
    Math.floor(stat.mtimeMs / 1000) === Math.floor(Date.parse(jar.modifiedAt) / 1000);
  try {
    if (!matches(source.source)) throw new DomainError('conflict');
    let directories = sourceDirectories.get(source.cache);
    if (!directories) {
      directories = new ResourceZipDirectories();
      sourceDirectories.set(source.cache, directories);
    }
    const archive = await openSelectedZip(
      source.source,
      source.signal,
      {
        maxEntries: 100_000,
        maxMetadataBytes: 32 * 1024 ** 2,
      },
      catalogPath,
      directories.entries.get(source.key),
    );
    let closed = false;
    const handle: MinecraftTextureArchive = {
      assets: () => archive.directory.entries.keys(),
      async read(path, maximum) {
        const entry = await archive.open(path, maximum);
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
          if (!source.signal.aborted) {
            const fresh = await source.restat();
            if (!matches(fresh) || fresh.mtimeMs !== source.source.mtimeMs)
              throw new DomainError('conflict');
            directories.retain(source.key, archive.directory);
          }
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
}
