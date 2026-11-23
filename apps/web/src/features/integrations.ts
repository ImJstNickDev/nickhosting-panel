import {
  availableGameUiSections,
  createTrustedGameUiRegistry,
  type FilemanPathEntry,
  type GameUiClient,
} from '@nickhosting/game-sdk/ui';
import { minecraftUiModule } from '@nickhosting/minecraft/ui';
import { openworldUiModule } from '../../../../games/openworld/src/ui/index.js';
import { satisfactoryUiModule } from '../../../../games/satisfactory/src/ui/index.js';
import { api, queryClient, upload } from '../api/client.js';
import type { ServerInfo } from './service-contracts.js';

/** Executable modules and artwork are build-time imports, never API URLs. */
export const gameUiRegistry = createTrustedGameUiRegistry([
  minecraftUiModule,
  satisfactoryUiModule,
  openworldUiModule,
]);
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
/** Presentation-only grouping from the server's compiled integration. */
export function getFileEntryGroup(
  gameId: string | undefined,
  runtimeId: string | undefined,
  path: string,
  entry: FilemanPathEntry,
  directoryGroup?: 'visible' | 'hidden',
) {
  if (!gameId || !runtimeId) return undefined;
  return gameUiRegistry.get(gameId)?.fileEntryGroup?.({ path, runtimeId, entry, directoryGroup });
}
/** Directory artwork is selected from existing metadata by the compiled integration. */
export function getFileDirectoryIcon(
  gameId: string,
  runtimeId: string,
  path: string,
  entries: readonly (FilemanPathEntry & { readonly size: number })[],
) {
  const module = gameUiRegistry.get(gameId);
  const icon = module?.fileDirectoryIcon?.({ path, runtimeId, entries });
  if (!icon) return undefined;
  return {
    file: icon.file,
    assetId: icon.assetId,
    src: icon.assetId ? module?.assets?.[icon.assetId] : undefined,
  };
}
export function getRuntimeArtwork(gameId: string, runtimeId: string) {
  const module = gameUiRegistry.get(gameId);
  const artwork = module?.runtimeArtwork?.(runtimeId);
  const src = artwork && module?.assets?.[artwork.assetId];
  return src ? { src, tone: artwork?.tone } : undefined;
}
export { getGameArtwork } from './game-artwork.js';
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

/** Start the requested view's module while its authorized section data is loading. */
function sectionView<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  const Component = lazy(load);
  return Object.assign(Component, { preload: () => void load().catch(() => {}) });
}

const MinecraftSettingsForm = sectionView(async () => ({
  default: (await import('../integrations/minecraft/settings.js')).MinecraftSettingsForm,
}));
const formViews = new Map<string, ComponentType<GameFormViewProps> & { preload(): void }>([
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
const SatisfactoryInstallationPolicy = lazy(() =>
  import('../integrations/satisfactory/installation-policy.js').then((module) => ({
    default: module.SatisfactoryInstallationPolicy,
  })),
);
const OpenworldVersions = lazy(() => import('../integrations/openworld/versions.js'));
const ownerComponents = new Map([
  ['openworld-versions', { Component: OpenworldVersions, Background: undefined }],
  [
    'satisfactory-installation',
    { Component: SatisfactoryInstallationPolicy, Background: undefined },
  ],
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

const MinecraftPlayersSection = sectionView(async () => ({
  default: (await import('../integrations/minecraft/players.js')).MinecraftPlayersSection,
}));
const MinecraftWorldsSection = sectionView(async () => ({
  default: (await import('../integrations/minecraft/worlds.js')).MinecraftWorldsSection,
}));
const MinecraftDatapacksSection = sectionView(async () => ({
  default: (await import('../integrations/minecraft/datapacks.js')).MinecraftDatapacksSection,
}));
const MinecraftModsSection = sectionView(async () => ({
  default: (await import('../integrations/minecraft/mods.js')).MinecraftModsSection,
}));
const MinecraftPluginsSection = sectionView(async () => ({
  default: (await import('../integrations/minecraft/mods.js')).MinecraftPluginsSection,
}));
const MinecraftModpacksSection = sectionView(async () => ({
  default: (await import('../integrations/minecraft/modpacks.js')).MinecraftModpacksSection,
}));
const SatisfactorySettingsSection = sectionView(async () => ({
  default: (await import('../integrations/satisfactory/settings.js')).SatisfactorySettingsSection,
}));
const SatisfactoryModsSection = sectionView(async () => ({
  default: (await import('../integrations/satisfactory/mods.js')).SatisfactoryModsSection,
}));
const OpenworldRulesSection = sectionView(async () => ({
  default: (await import('../integrations/openworld/rules.js')).OpenworldRules,
}));
const OpenworldSeedSection = sectionView(async () => ({
  default: (await import('../integrations/openworld/seed-inspector.js')).OpenworldSeedInspector,
}));
const OpenworldFactoriesSection = sectionView(async () => ({
  default: (await import('../integrations/openworld/factories.js')).OpenworldFactories,
}));
const OpenworldMapSection = sectionView(async () => ({
  default: (await import('../integrations/openworld/world-map.js')).OpenworldMap,
}));
const OpenworldPlayersSection = sectionView(async () => ({
  default: (await import('../integrations/openworld/players.js')).OpenworldPlayers,
}));
const OpenworldPerformanceSection = sectionView(async () => ({
  default: (await import('../integrations/openworld/performance.js')).OpenworldPerformance,
}));
const OpenworldOverviewSection = sectionView(async () => ({
  default: (await import('../integrations/openworld/overview.js')).OpenworldOverview,
}));
const OpenworldVersionSection = sectionView(async () => ({
  default: (await import('../integrations/openworld/version-settings.js')).OpenworldVersionSettings,
}));
const OpenworldDashboardSection = sectionView(async () => ({
  default: (await import('../integrations/openworld/dashboard.js')).OpenworldDashboard,
}));
const SatisfactoryOverviewSection = sectionView(async () => ({
  default: (await import('../integrations/satisfactory/overview.js')).SatisfactoryOverviewSection,
}));
const SatisfactoryWorldsSection = sectionView(async () => ({
  default: (await import('../integrations/satisfactory/worlds.js')).SatisfactoryWorldsSection,
}));
const sectionViews = new Map<string, ComponentType<GameSectionViewProps> & { preload(): void }>([
  ['openworld-map', OpenworldMapSection],
  ['openworld-rules', OpenworldRulesSection],
  ['openworld-seed', OpenworldSeedSection],
  ['openworld-factories', OpenworldFactoriesSection],
  ['openworld-players', OpenworldPlayersSection],
  ['openworld-overview', OpenworldOverviewSection],
  ['openworld-performance', OpenworldPerformanceSection],
  ['openworld-version', OpenworldVersionSection],
  ['openworld-dashboard', OpenworldDashboardSection],
  ['satisfactory-overview', SatisfactoryOverviewSection],
  ['satisfactory-worlds', SatisfactoryWorldsSection],
  ['satisfactory-mods', SatisfactoryModsSection],
  ['satisfactory-settings', SatisfactorySettingsSection],
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
