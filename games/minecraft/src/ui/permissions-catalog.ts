/** Integration-owned labels for the shared Subusers matrix. */
export const minecraftPermissionMessages: Record<string, [string, string]> = {
  'permissions.resource.properties': ['Minecraft settings', 'Impostazioni Minecraft'],
  'permissions.resource.players': ['Players', 'Giocatori'],
  'permissions.resource.worlds': ['Worlds', 'Mondi'],
  'permissions.resource.mods': ['Mods', 'Mod'],
  'permissions.resource.plugins': ['Plugins', 'Plugin'],
  'permissions.resource.datapacks': ['Datapacks', 'Datapack'],
  'permissions.resource.modpacks': ['Modpacks', 'Modpack'],
  ...Object.fromEntries(
    ['properties', 'players', 'worlds', 'mods', 'plugins', 'datapacks', 'modpacks'].map(
      (resource) => [`permissions.${resource}.read`, ['Read', 'Lettura'] as [string, string]],
    ),
  ),
  ...Object.fromEntries(
    ['properties', 'mods', 'plugins', 'datapacks', 'modpacks'].map((resource) => [
      `permissions.${resource}.write`,
      ['Write', 'Scrittura'] as [string, string],
    ]),
  ),
  ...Object.fromEntries(
    ['worlds', 'mods', 'plugins', 'datapacks'].map((resource) => [
      `permissions.${resource}.delete`,
      ['Delete', 'Eliminazione'] as [string, string],
    ]),
  ),
  'permissions.players.whitelist': ['Whitelist', 'Whitelist'],
  'permissions.players.op': ['Operator status', 'Stato operatore'],
  'permissions.players.kick': ['Kick', 'Espulsione'],
  'permissions.players.ban': ['Ban', 'Ban'],
  'permissions.worlds.import': ['Import', 'Importazione'],
  'permissions.worlds.select': ['Select active world', 'Selezione mondo attivo'],
  'permissions.worlds.download': ['Download', 'Download'],
};
