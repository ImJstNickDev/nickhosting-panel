import { api } from '../../api/client.js';

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

export async function fetchInventoryTextures(
  serverId: string,
  ids: readonly string[],
  signal?: AbortSignal,
) {
  const textures: Record<string, string> = {};
  // A normal inventory plus ender chest can contain more than 64 distinct items.
  for (let offset = 0; offset < ids.length; offset += 64) {
    const batch = ids.slice(offset, offset + 64);
    const query = new URLSearchParams({ ids: batch.join(',') });
    const result = await api<{ textures: Record<string, string> }>(
      `/v1/servers/${encodeURIComponent(serverId)}/minecraft/item-textures?${query}`,
      { signal },
    );
    for (const id of batch) {
      const value = result.textures[id];
      if (typeof value === 'string' && value.startsWith('data:image/png;base64,'))
        textures[id] = value;
    }
  }
  return textures;
}
