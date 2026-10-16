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

// Owner executable contributions are bundled first-party imports. Metadata never imports code.
import { lazy } from 'react';
import { MinecraftResponseSettings } from './integration-game-settings.js';

const MinecraftVersions = lazy(() =>
  import('./minecraft-admin.js').then((module) => ({ default: module.OwnerMinecraftPage })),
);
const MinecraftScan = lazy(() =>
  import('./minecraft-admin.js').then((module) => ({ default: module.MinecraftCatalogScan })),
);
const ownerComponents = new Map([
  [
    'minecraft-versions',
    {
      Component: MinecraftVersions,
      Background: MinecraftScan,
    },
  ],
]);
const ownerConnectionComponents = new Map([
  [minecraftUiModule.descriptor.gameId, MinecraftResponseSettings],
]);
export function getGameAdminSections(gameId: string) {
  return (gameUiRegistry.get(gameId)?.descriptor.administration ?? []).flatMap((section) => {
    const registered = ownerComponents.get(section.component);
    return registered ? [{ ...section, ...registered }] : [];
  });
}
export function getGameConnectionAdmin(gameId: string) {
  return ownerConnectionComponents.get(gameId);
}
