import { defineTrustedGameViewer, type GameViewerSource } from '@nickhosting/game-sdk/ui';

/** A suggestion, not an access rule. Personal Open with preferences take precedence. */
export function matchesMinecraftMod(source: GameViewerSource) {
  return (
    source.gameId === 'minecraft' &&
    !source.entry &&
    !source.archives?.length &&
    /^\/?mods\/(?:[^/]+\/)*[^/]+\.jar(?:\.(?:disabled|pending))?$/i.test(source.path)
  );
}

export function matchesMinecraftPlugin(source: GameViewerSource) {
  return (
    source.gameId === 'minecraft' &&
    !source.entry &&
    !source.archives?.length &&
    /^\/?plugins\/(?:[^/]+\/)*[^/]+\.jar(?:\.(?:disabled|pending))?$/i.test(source.path)
  );
}

export const minecraftViewers = [
  defineTrustedGameViewer(
    {
      id: 'minecraft:modscope',
      gameId: 'minecraft',
      labelKey: 'games.minecraft.viewers.modscope.name',
      extensions: ['jar', 'jar.disabled', 'jar.pending'],
      readOnly: true,
    },
    () => import('./mod-viewer.js'),
    matchesMinecraftMod,
  ),
  defineTrustedGameViewer(
    {
      id: 'minecraft:plugscope',
      gameId: 'minecraft',
      labelKey: 'games.minecraft.viewers.plugscope.name',
      extensions: ['jar', 'jar.disabled', 'jar.pending'],
      readOnly: true,
    },
    () => import('./plugin-viewer.js'),
    matchesMinecraftPlugin,
  ),
] as const;
