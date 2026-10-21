import type {
  ModpackCatalogVersion,
  ModpackProvider,
} from '../../../../../packages/content-providers/src/modpack-catalog.js';

export const modpackProviders: Record<ModpackProvider, string> = {
  modrinth: 'Modrinth',
  curseforge: 'CurseForge',
  ftb: 'FTB',
  technic: 'Technic',
  voidswrath: 'Voids Wrath',
  atlauncher: 'ATLauncher',
};
export const modpackKey = (name: string) => `games.minecraft.modpacks.${name}`;
export const modpackQueryKey = (serverId: string, suffix = '') =>
  [`minecraft-modpacks${suffix ? `-${suffix}` : ''}`, serverId] as const;
export const modpackIdentity = (project: { provider: ModpackProvider; id: string }) =>
  `${project.provider}:${project.id}`;
/** Provider order is the tie-breaker when a catalog does not publish release dates. */
export function recommendedPackVersion(versions: readonly ModpackCatalogVersion[]) {
  const eligible = versions.filter((version) => version.available);
  const stable = eligible.filter((version) => version.channel === 'release');
  return [...(stable.length ? stable : eligible)].sort((left, right) => {
    const a = left.publishedAt ? Date.parse(left.publishedAt) : 0;
    const b = right.publishedAt ? Date.parse(right.publishedAt) : 0;
    return b - a;
  })[0];
}
const loaderLabels: Record<string, string> = {
  vanilla: 'Vanilla',
  paper: 'Paper',
  folia: 'Folia',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
};
export const packLoaderLabel = (loader: string) => loaderLabels[loader] ?? loader;
export function packRuntimeLabel(target: {
  minecraftVersion: string;
  loader: string;
  loaderVersion?: string;
}) {
  return `Minecraft ${target.minecraftVersion} · ${packLoaderLabel(target.loader)}${target.loaderVersion ? ` ${target.loaderVersion}` : ''}`;
}
