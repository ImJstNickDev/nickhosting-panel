import {
  type ContentHttp,
  type CurseForgeProvider,
  HangarProvider,
  ModrinthProvider,
  SpigetProvider,
} from '@nickhosting/content-providers';
import type {
  ContentCatalogProvider,
  ModCatalogDetails,
  ModCatalogProjects,
} from '../../content-providers/src/mod-catalog.js';
import type { ModCatalogSearchInput } from '../../content-providers/src/mod-resolution.js';
import type { ModAdviceProvider } from './minecraft-mod-advice.js';

/** One internal catalog facade; publication remains the same for mods and plugins. */
export interface MinecraftAddonProvider extends ModAdviceProvider {
  http: ContentHttp;
  searchMods(input: ModCatalogSearchInput): Promise<ModCatalogProjects>;
  modDetails(projectId: string, signal?: AbortSignal): Promise<ModCatalogDetails>;
}
export function minecraftAddonProviders(options: {
  kind: 'mod' | 'plugin';
  http?: ContentHttp;
  curseforge?: CurseForgeProvider;
}): Partial<Record<ContentCatalogProvider, MinecraftAddonProvider>> {
  const modrinth = options.http ? new ModrinthProvider(options.http) : undefined;
  if (options.kind === 'mod')
    return {
      ...(modrinth ? { modrinth } : {}),
      ...(options.curseforge ? { curseforge: options.curseforge } : {}),
    };
  const adapt = (
    provider: ModrinthProvider | CurseForgeProvider | HangarProvider | SpigetProvider,
  ): MinecraftAddonProvider => ({
    http: provider.http,
    searchMods: provider.searchPlugins.bind(provider),
    modDetails: provider.pluginDetails.bind(provider),
    modVersion: provider.pluginVersion.bind(provider),
    modVersions: provider.pluginVersions.bind(provider),
    resolveMods: provider.resolvePlugins.bind(provider),
  });
  return {
    ...(modrinth ? { modrinth: adapt(modrinth) } : {}),
    ...(options.curseforge ? { curseforge: adapt(options.curseforge) } : {}),
    ...(options.http
      ? {
          hangar: adapt(new HangarProvider(options.http)),
          spiget: adapt(new SpigetProvider(options.http)),
        }
      : {}),
  };
}
