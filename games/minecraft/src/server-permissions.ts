import { DomainError, type ServerPermissionDefinition } from '@nickhosting/core';

const permission = (resource: string, action: string): ServerPermissionDefinition => ({
  key: `game.minecraft.${resource}.${action}`,
  resource: `game.minecraft.${resource}`,
  kind: action === 'read' || action === 'write' ? action : 'additional',
  legacy: action === 'read' || action === 'download' ? 'read' : 'manage',
  labelKey: `games.minecraft.permissions.${resource}.${action}`,
  resourceLabelKey: `games.minecraft.permissions.resource.${resource}`,
});

/** Compiled integration data, never a browser-supplied authorization policy. */
export const minecraftServerPermissions: readonly ServerPermissionDefinition[] = [
  ...['read', 'write'].map((action) => permission('properties', action)),
  ...['read', 'whitelist', 'op', 'kick', 'ban'].map((action) => permission('players', action)),
  ...['read', 'import', 'select', 'download', 'delete'].map((action) =>
    permission('worlds', action),
  ),
  ...['mods', 'plugins', 'datapacks'].flatMap((resource) =>
    ['read', 'write', 'delete'].map((action) => permission(resource, action)),
  ),
  ...['read', 'write'].map((action) => permission('modpacks', action)),
];

export function minecraftPlayerPermission(action: string): string {
  const operation = ['whitelist-add', 'whitelist-remove', 'whitelist-on', 'whitelist-off'].includes(
    action,
  )
    ? 'whitelist'
    : ['op', 'deop'].includes(action)
      ? 'op'
      : ['ban', 'pardon'].includes(action)
        ? 'ban'
        : action === 'kick'
          ? 'kick'
          : undefined;
  if (!operation) throw new DomainError('validation_failed');
  return `game.minecraft.players.${operation}`;
}

/** Authorization of the exact persisted command is repeated before worker effects. */
export function minecraftContentPermissionKeys(command: {
  kind: string;
  list?: string;
  replace?: unknown;
  backupBefore?: boolean;
}): string[] {
  const map: Record<string, string> = {
    verify: 'properties.write',
    properties: 'properties.write',
    'world-import': 'worlds.import',
    'world-select': 'worlds.select',
    'world-remove': 'worlds.delete',
    install: 'mods.write',
    remove: 'mods.delete',
    modpack: 'modpacks.write',
    'modpack-upload': 'modpacks.write',
    player: command.list === 'operators' ? 'players.op' : 'players.whitelist',
  };
  const value = map[command.kind];
  if (!value) throw new DomainError('validation_failed');
  // Legacy generic commands select their directory from runtime/receipt state.
  // Keep their original manager boundary; scoped Mods/Plugins APIs use independent grants.
  const keys = ['install', 'remove'].includes(command.kind)
    ? ['server:manage']
    : [`game.minecraft.${value}`];
  // The legacy replacement preview wipes mods, plugins, configuration and worlds.
  // Its full reset remains a manager operation; domain write/delete grants do
  // not authorize this cross-domain wipe. Scoped Modpacks uses its own flow.
  if (['modpack', 'modpack-upload'].includes(command.kind) && command.replace)
    keys.push('server:manage');
  if (command.kind === 'world-import' && command.replace) keys.push('game.minecraft.worlds.delete');
  const replacement = command.replace as { backupBefore?: boolean } | undefined;
  if (command.backupBefore || replacement?.backupBefore) keys.push('backups.create');
  return keys;
}
