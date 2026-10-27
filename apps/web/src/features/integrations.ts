import {
  availableGameUiSections,
  createTrustedGameUiRegistry,
  type GameUiClient,
} from '@nickhosting/game-sdk/ui';
import { minecraftUiModule } from '@nickhosting/minecraft/ui';
import { api, queryClient, upload } from '../api/client.js';
import type { ServerInfo } from './service-contracts.js';

/** Executable modules and artwork are build-time imports, never API URLs. */
export const gameUiRegistry = createTrustedGameUiRegistry([minecraftUiModule]);
export function availableGameSections(
  server: ServerInfo,
  module = gameUiRegistry.get(server.gameId),
) {
  return module
    ? availableGameUiSections(module, {
        runtimeId: server.runtimeId,
        permissions: [
          ...Object.entries(server.permissions).flatMap(([name, allowed]) =>
            allowed ? [`server:${name}`] : [],
          ),
          ...((server as ServerInfo & { permissionKeys?: string[] }).permissionKeys ?? []),
        ],
        capabilities: server.capabilities,
      })
    : [];
}
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
export function getRuntimeArtwork(gameId: string, runtimeId: string) {
  const module = gameUiRegistry.get(gameId);
  const artwork = module?.runtimeArtwork?.(runtimeId);
  const src = artwork && module?.assets?.[artwork.assetId];
  return src ? { src, tone: artwork?.tone } : undefined;
}
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

import type { GatewayMessageDefinition } from '@nickhosting/game-sdk';
import type { ComponentType } from 'react';
// Owner executable contributions are bundled first-party imports. Metadata never imports code.
import { lazy } from 'react';
import type { GameFormViewProps } from './game-form-view.js';
import type { GameSectionViewProps } from './game-section-view.js';
import { MinecraftModSettings, MinecraftResponseSettings } from './integration-game-settings.js';

const MinecraftSettingsForm = lazy(() =>
  import('../integrations/minecraft/settings.js').then((module) => ({
    default: module.MinecraftSettingsForm,
  })),
);
const formViews = new Map<string, ComponentType<GameFormViewProps>>([
  ['minecraft-properties', MinecraftSettingsForm],
]);
/** Form views replace presentation only, never the shared authorization or mutation path. */
export function getGameFormView(renderer: string | undefined) {
  return renderer ? formViews.get(renderer) : undefined;
}

const MinecraftGatewayEditor = lazy(() =>
  import('../integrations/minecraft/gateway-editor.js').then((module) => ({
    default: module.MinecraftGatewayEditor,
  })),
);
const gatewayMessageEditors = new Map([
  [
    'minecraft-26.1',
    {
      Component: MinecraftGatewayEditor,
      accepts: (definition: GatewayMessageDefinition) =>
        definition.channels.every((channel) => ['motd', 'disconnect'].includes(channel.id)),
    },
  ],
]);
export function getGameGatewayMessageEditor(
  gameId: string | undefined,
  definition: GatewayMessageDefinition,
) {
  const key = gameId ? gameUiRegistry.get(gameId)?.gatewayMessageEditor : undefined;
  const registered = key ? gatewayMessageEditors.get(key) : undefined;
  return registered?.accepts(definition) ? registered.Component : undefined;
}

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
const ownerContentComponents = new Map([
  [minecraftUiModule.descriptor.gameId, MinecraftModSettings],
]);
export function getGameContentAdmin(gameId: string) {
  return ownerContentComponents.get(gameId);
}

const MinecraftPlayersSection = lazy(() =>
  import('../integrations/minecraft/players.js').then((module) => ({
    default: module.MinecraftPlayersSection,
  })),
);
const MinecraftWorldsSection = lazy(() =>
  import('../integrations/minecraft/worlds.js').then((module) => ({
    default: module.MinecraftWorldsSection,
  })),
);
const MinecraftDatapacksSection = lazy(() =>
  import('../integrations/minecraft/datapacks.js').then((module) => ({
    default: module.MinecraftDatapacksSection,
  })),
);
const MinecraftModsSection = lazy(() =>
  import('../integrations/minecraft/mods.js').then((module) => ({
    default: module.MinecraftModsSection,
  })),
);
const MinecraftPluginsSection = lazy(() =>
  import('../integrations/minecraft/mods.js').then((module) => ({
    default: module.MinecraftPluginsSection,
  })),
);
const MinecraftModpacksSection = lazy(() =>
  import('../integrations/minecraft/modpacks.js').then((module) => ({
    default: module.MinecraftModpacksSection,
  })),
);
const sectionViews = new Map<string, ComponentType<GameSectionViewProps>>([
  ['minecraft-players', MinecraftPlayersSection],
  ['minecraft-worlds', MinecraftWorldsSection],
  ['minecraft-datapacks', MinecraftDatapacksSection],
  ['minecraft-mods', MinecraftModsSection],
  ['minecraft-plugins', MinecraftPluginsSection],
  ['minecraft-modpacks', MinecraftModpacksSection],
]);
export function getGameSectionView(renderer: string | undefined) {
  return renderer ? sectionViews.get(renderer) : undefined;
}
