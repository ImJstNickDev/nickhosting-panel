import { minecraftGameArtwork } from '../../../../games/minecraft/src/ui/game-artwork.js';
import { openworldGameArtwork } from '../../../../games/openworld/src/ui/artwork.js';

const artwork = new Map<string, string>();
for (const asset of [minecraftGameArtwork, openworldGameArtwork]) {
  if (asset.src) artwork.set(asset.gameId, asset.src);
}
export const getGameArtwork = (gameId: string) => artwork.get(gameId);
