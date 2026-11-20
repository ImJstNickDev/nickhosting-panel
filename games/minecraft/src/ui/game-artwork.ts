// The dashboard needs only the bundled illustration, before any game workspace opens.
export const minecraftGameArtwork = {
  gameId: 'minecraft',
  assetId: 'landscape',
  src: new URL('./assets/minecraft-landscape.svg', import.meta.url).href,
} as const;
