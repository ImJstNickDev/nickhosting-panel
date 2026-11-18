import type { QueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../../api/client.js';

const identifier = /^[a-z0-9_.-]+:[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/;

/** One stable set for both inventories; no request is tied to an individual slot. */
export function inventoryTextureIds(...inventories: ({ id: string }[] | null | undefined)[]) {
  return [...new Set(inventories.flatMap((items) => items?.map((item) => item.id) ?? []))]
    .filter(
      (id) =>
        identifier.test(id) && !id.split(/[/:]/).some((part) => part === '..' || part === '.'),
    )
    .sort();
}

const revisionKey = (server: string) => ['minecraft-texture-revision', server];
const itemKey = (server: string, revision: string, id: string) => [
  'minecraft-item-texture',
  server,
  revision,
  id,
];
type TextureResult = { textures: Record<string, string>; preparing: boolean };
type TextureResponse = { textures: Record<string, string>; revision?: string; preparing?: boolean };

export function cachedInventoryTextures(
  cache: QueryClient,
  server: string,
  ids: readonly string[],
) {
  const revision = cache.getQueryData<string>(revisionKey(server));
  if (!revision) return;
  const textures: Record<string, string> = {};
  for (const id of ids) {
    const png = cache.getQueryData<string | null>(itemKey(server, revision, id));
    if (png) textures[id] = png;
  }
  return { textures, preparing: false };
}

export async function fetchInventoryTextures(
  serverId: string,
  ids: readonly string[],
  signal?: AbortSignal,
  cache?: QueryClient,
): Promise<TextureResult> {
  const textures: Record<string, string> = {};
  const previous = cache?.getQueryData<string>(revisionKey(serverId));
  let preparing = false;
  let batchRevision: string | undefined;
  for (let offset = 0; offset < ids.length; offset += 64) {
    const batch = ids.slice(offset, offset + 64);
    const query = new URLSearchParams({ ids: batch.join(',') });
    const known = new Map<string, string | null>();
    if (previous && cache) {
      for (const id of batch) {
        const value = cache.getQueryData<string | null>(itemKey(serverId, previous, id));
        if (value !== undefined) known.set(id, value);
      }
      if (known.size) {
        query.set('revision', previous);
        query.set('known', [...known.keys()].join(','));
      }
    }
    const result = await api<TextureResponse>(
      `/v1/servers/${encodeURIComponent(serverId)}/minecraft/item-textures?${query}`,
      { signal },
    ).catch((error: unknown) => {
      if (cache && error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        cache.removeQueries({ queryKey: ['minecraft-item-texture', serverId] });
        cache.removeQueries({ queryKey: revisionKey(serverId) });
        cache.removeQueries({
          queryKey: ['minecraft-inventory-server-textures', serverId],
          type: 'inactive',
        });
      }
      throw error;
    });
    // A pack replacement between batches requires a fresh, coherent set.
    if (offset && batchRevision !== result.revision) return { textures: {}, preparing: true };
    batchRevision = result.revision;
    preparing ||= result.preparing === true;
    for (const id of batch) {
      const value =
        previous && previous === result.revision && known.has(id)
          ? known.get(id)
          : result.textures[id];
      const png =
        typeof value === 'string' && value.startsWith('data:image/png;base64,') ? value : null;
      if (png) textures[id] = png;
      if (cache && result.revision && (png || !result.preparing))
        cache.setQueryData(itemKey(serverId, result.revision, id), png);
    }
  }
  if (batchRevision && cache) {
    const latest = cache.getQueryData<string>(revisionKey(serverId));
    if (latest !== previous && latest !== batchRevision) return { textures: {}, preparing: true };
    if (previous && previous !== batchRevision) {
      cache.removeQueries({ queryKey: ['minecraft-item-texture', serverId, previous] });
      cache.removeQueries({
        queryKey: ['minecraft-inventory-server-textures', serverId],
        type: 'inactive',
      });
    }
    cache.setQueryData(revisionKey(serverId), batchRevision);
  }
  return { textures, preparing };
}
