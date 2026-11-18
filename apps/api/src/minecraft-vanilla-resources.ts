import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DomainError, runtimeStorageRoot } from '@nickhosting/core';

export interface MinecraftVanillaResources {
  revision: string;
  itemIds?(): Iterable<string>;
  has(path: string): boolean;
  read(path: string, maximum: number): Promise<Uint8Array | undefined>;
}

const byteLimit = 16 * 1024 ** 2;
const entriesLimit = 32_000;
const releaseName = /^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,79}$/;
const assetPath =
  /^assets\/minecraft\/(?:(?:items|models)\/[a-z0-9_./-]+\.json|textures\/[a-z0-9_./-]+\.png)$/;
const packs = new Map<string, { statKey: string; resources: Promise<MinecraftVanillaResources> }>();

function invalidBundle(): never {
  throw new DomainError('integration_unavailable');
}

function parseBundle(bytes: Buffer, release: string): MinecraftVanillaResources {
  const payload = JSON.parse(bytes.toString('utf8'));
  if (
    payload?.format !== 1 ||
    payload.release !== release ||
    typeof payload.clientSha1 !== 'string' ||
    !/^[0-9a-f]{40}$/.test(payload.clientSha1) ||
    !payload.assets ||
    typeof payload.assets !== 'object' ||
    Array.isArray(payload.assets)
  )
    invalidBundle();
  const assets = new Map<string, string>();
  for (const [name, content] of Object.entries(payload.assets)) {
    if (
      assets.size >= entriesLimit ||
      !assetPath.test(name) ||
      name.split('/').some((part) => !part || part === '.' || part === '..') ||
      typeof content !== 'string' ||
      content.length > 4 * Math.ceil((512 * 1024) / 3)
    )
      invalidBundle();
    assets.set(name, content);
  }
  const revision = createHash('sha256').update(bytes).digest('hex');
  return {
    revision,
    *itemIds() {
      for (const path of assets.keys()) {
        const match = /^assets\/minecraft\/(?:items|models\/item)\/(.+)\.json$/.exec(path);
        if (match) yield `minecraft:${match[1]}`;
      }
    },
    has: (path) => assets.has(path),
    async read(path, maximum) {
      const value = assets.get(path);
      if (!value || Buffer.byteLength(value, 'base64') > maximum) return;
      return Buffer.from(value, 'base64');
    },
  };
}

/** Locally provisioned vanilla pack for this exact release. Never downloads in the request path. */
export async function getMinecraftVanillaResources(
  release: string,
  mountdataRoot = runtimeStorageRoot(),
): Promise<MinecraftVanillaResources | undefined> {
  if (!releaseName.test(release)) return;
  const directory = resolve(mountdataRoot, 'minecraft-vanilla-resources');
  const path = resolve(directory, `${release}.json`);
  try {
    if ((await realpath(directory)) !== directory) invalidBundle();
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > byteLimit) invalidBundle();
      const statKey = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
      const cached = packs.get(path);
      if (cached?.statKey === statKey) return await cached.resources;
      // Provisioning publishes a complete immutable file by atomic link. Coalesce
      // concurrent first readers and retain at most two parsed release bundles.
      const resources = handle.readFile().then((bytes) => {
        if (bytes.length !== stat.size) invalidBundle();
        return parseBundle(bytes, release);
      });
      packs.set(path, { statKey, resources });
      if (packs.size > 2) packs.delete(packs.keys().next().value as string);
      try {
        return await resources;
      } catch (error) {
        if (packs.get(path)?.resources === resources) packs.delete(path);
        throw error;
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new DomainError('integration_unavailable');
  }
}
