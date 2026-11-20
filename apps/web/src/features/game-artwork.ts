import { minecraftGameArtwork } from '../../../../games/minecraft/src/ui/game-artwork.js';

const artwork = new Map<string, string>([[minecraftGameArtwork.gameId, minecraftGameArtwork.src]]);
export const getGameArtwork = (gameId: string) => artwork.get(gameId);
