import type { TrustedGameUiModule } from '@nickhosting/game-sdk/ui';
import { z } from 'zod';

const visibleFiles = new Set([
  'server.jar',
  'server.properties',
  'server-icon.png',
  'bukkit.yml',
  'commands.yml',
  'help.yml',
  'permissions.yml',
  'spigot.yml',
  'paper.yml',
  'purpur.yml',
]);
const visibleDirectories = new Set([
  'world',
  'config',
  'mods',
  'plugins',
  'logs',
  'crash-reports',
  'defaultconfigs',
  'kubejs',
  'scripts',
  'schematics',
  'patchouli_books',
  'datapacks',
  'backups',
  'ftbbackups3',
]);

/** A nested level-name protects the root directory containing it. Legacy Paper
 * stores dimensions beside a top-level world under its configured name. */
export function configuredMinecraftWorldRoots(
  value: string | null | undefined,
): string[] | undefined {
  if (!value || value.startsWith('/') || value.startsWith('\\')) return undefined;
  const parts: string[] = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  const root = parts[0];
  if (!root) return undefined;
  return parts.length === 1 ? [root, `${root}_nether`, `${root}_the_end`] : [root];
}

const indexSchema = z.object({
  worlds: z.array(z.string()),
  selectedWorld: z.string().nullable(),
  nonWorldDirectories: z.array(z.string()),
});

export const minecraftFileRootGroups: NonNullable<TrustedGameUiModule['fileRootGroups']> = async (
  client,
  serverId,
  signal,
) => {
  const index = indexSchema.parse(
    await client.request(`/v1/servers/${encodeURIComponent(serverId)}/minecraft/worlds/fileman`, {
      signal,
    }),
  );
  const groups = new Map<string, 'visible' | 'hidden'>();
  for (const name of index.nonWorldDirectories) groups.set(name, 'hidden');
  for (const name of index.worlds) groups.set(name, 'visible');
  for (const root of configuredMinecraftWorldRoots(index.selectedWorld) ?? []) {
    groups.set(root, 'visible');
  }
  return groups;
};

export const minecraftFileEntryGroup: NonNullable<TrustedGameUiModule['fileEntryGroup']> = ({
  path,
  entry,
  directoryGroup,
}) => {
  if (path !== '' && path !== '/') return undefined;
  if (entry.is_file) return visibleFiles.has(entry.name) ? undefined : 'hidden';
  if (directoryGroup === 'visible' || visibleDirectories.has(entry.name)) return undefined;
  // Older Bukkit layouts can keep dimension data without a separate level.dat.
  if (entry.name.endsWith('_nether') || entry.name.endsWith('_the_end')) return undefined;
  if (
    directoryGroup === 'hidden' ||
    entry.name.startsWith('.') ||
    entry.name === 'libraries' ||
    entry.name === 'versions'
  )
    return 'hidden';
  // A custom directory can be a world, including legacy names with spaces.
  // A missing or incomplete observation cannot rule that out.
  return undefined;
};
