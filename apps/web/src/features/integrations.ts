import { createTrustedGameUiRegistry, type GameUiClient } from '@nickhosting/game-sdk/ui';
import { minecraftUiModule } from '@nickhosting/minecraft/ui';
import { api, queryClient, upload } from '../api/client.js';

/** Executable modules and artwork are build-time imports, never API URLs. */
export const gameUiRegistry = createTrustedGameUiRegistry([minecraftUiModule]);
export const gameUiClient: GameUiClient = {
  request: api,
  upload,
  catalogRequest: (path) =>
    queryClient.fetchQuery({
      queryKey: ['creation', 'request', path],
      queryFn: ({ signal }) => api(path, { signal }),
      staleTime: 60_000,
    }),
};
export function getGameArtwork(gameId: string): string | undefined {
  const module = gameUiRegistry.get(gameId);
  const asset = module?.descriptor.artwork;
  return asset ? module?.assets?.[asset.assetId] : undefined;
}
/** Decorative metadata only; an icon never establishes editor support or permission. */
export function getGameFileIcon(gameId: string | undefined, name: string): string | undefined {
  const module = gameId ? gameUiRegistry.get(gameId) : undefined;
  const filename = name.split('/').at(-1)?.toLowerCase() ?? '';
  const extension = filename.includes('.') ? (filename.split('.').at(-1) ?? '') : '';
  const icon = module?.descriptor.fileIcons?.find((rule) => rule.extensions.includes(extension));
  return icon ? module?.assets?.[icon.assetId] : undefined;
}

// Owner executable contributions are also static first-party imports.
import { OwnerMinecraftPage } from './minecraft-admin.js';

const adminModules = new Map([[minecraftUiModule.descriptor.gameId, OwnerMinecraftPage]]);
export function getGameAdmin(gameId: string) {
  return adminModules.get(gameId);
}
