import { createContext, useContext } from 'react';
import {
  type ContentCatalogProvider,
  createMinecraftModsController,
} from '../../../../../games/minecraft/src/ui/mods-controller.js';
import { useT } from '../../app/i18n.js';
import { gameUiClient } from '../../features/integrations.js';

export type AddonKind = 'mods' | 'plugins';
export type AddonCatalog = ContentCatalogProvider | 'voxel' | 'builtbybit';
export const addonProviderLabel: Record<AddonCatalog, string> = {
  modrinth: 'Modrinth',
  curseforge: 'CurseForge',
  hangar: 'Hangar',
  spiget: 'SpigotMC',
  voxel: 'Voxel',
  builtbybit: 'builtbybit',
};
function scope(kind: AddonKind) {
  return {
    kind,
    controller: createMinecraftModsController(gameUiClient, kind),
    key: (name: string) => `games.minecraft.${kind}.${name}`,
    queryKey: (serverId: string, suffix = '') =>
      [`minecraft-${kind}${suffix ? `-${suffix}` : ''}`, serverId] as const,
    providers: (kind === 'mods'
      ? ['modrinth', 'curseforge']
      : ['modrinth', 'hangar', 'spiget', 'curseforge', 'voxel', 'builtbybit']) as AddonCatalog[],
  };
}
export const addonsScopes = { mods: scope('mods'), plugins: scope('plugins') };
export const AddonsContext = createContext(addonsScopes.mods);
export const useAddons = () => useContext(AddonsContext);
/** Shared presentation retains one vocabulary, translated through its explicit content scope. */
export function useAddonsT(): ReturnType<typeof useT> {
  const t = useT();
  const { kind } = useAddons();
  return (key, values) =>
    t(
      kind === 'plugins'
        ? key.replace(/^games\.minecraft\.mods\./, 'games.minecraft.plugins.')
        : key,
      values,
    );
}
