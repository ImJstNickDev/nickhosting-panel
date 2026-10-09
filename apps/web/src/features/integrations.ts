import { createTrustedGameUiRegistry, type GameUiClient } from '@nickhosting/game-sdk/ui';
import { minecraftUiModule } from '@nickhosting/minecraft/ui';
import { api, upload } from '../api/client.js';

/** Executable modules and artwork are build-time imports, never API URLs. */
export const gameUiRegistry = createTrustedGameUiRegistry([minecraftUiModule]);
export const gameUiClient: GameUiClient = { request: api, upload };
export function getGameArtwork(gameId: string): string | undefined {
  const module = gameUiRegistry.get(gameId);
  const asset = module?.descriptor.artwork;
  return asset ? module?.assets?.[asset.assetId] : undefined;
}

// Owner executable contributions are also static first-party imports.
import { OwnerMinecraftPage } from './minecraft-admin.js';

const adminModules = new Map([[minecraftUiModule.descriptor.gameId, OwnerMinecraftPage]]);
export function getGameAdmin(gameId: string) {
  return adminModules.get(gameId);
}
