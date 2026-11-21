// The two official images are prepared locally by games/openworld/prepare-artwork.mjs.
/// <reference types="vite/client" />
const local = import.meta.env
  ? import.meta.glob<string>('./assets/local/*.{webp,png}', {
      eager: true,
      query: '?url',
      import: 'default',
    })
  : {};

export const openworldGameArtwork = {
  gameId: 'openworld',
  assetId: 'landscape',
  src: local['./assets/local/game.webp'],
} as const;

export const openworldRuntimeArtwork = {
  assetId: 'runtime-dedicated',
  src: local['./assets/local/runtime.png'],
  presentation: 'icon',
  tone: 'light',
} as const;
