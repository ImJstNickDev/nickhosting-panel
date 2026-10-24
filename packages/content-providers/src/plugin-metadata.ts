import type { ContentTarget } from './contracts.js';
import type { ModCompatibilityIssue, ModEnvironment } from './mod-catalog.js';

/** Paper implements Bukkit/Spigot APIs. Folia support is a separate explicit declaration. */
export function pluginLoaders(target: ContentTarget): string[] {
  return target.loader === 'paper' ? ['paper', 'spigot', 'bukkit'] : [target.loader];
}
export function pluginCompatibility(
  gameVersions: string[],
  loaders: string[],
  environment: ModEnvironment,
  target: ContentTarget,
  minorVersionDeclarations = false,
): ModCompatibilityIssue[] {
  const issues: ModCompatibilityIssue[] = [];
  const supported = gameVersions.some(
    (version) =>
      version === target.minecraftVersion ||
      (minorVersionDeclarations &&
        /^1\.\d+$/.test(version) &&
        target.minecraftVersion.startsWith(`${version}.`)),
  );
  if (!supported) issues.push('minecraft-version');
  if (!pluginLoaders(target).some((loader) => loaders.includes(loader))) issues.push('loader');
  if (environment.kind === 'client') issues.push('client-only');
  return issues;
}
