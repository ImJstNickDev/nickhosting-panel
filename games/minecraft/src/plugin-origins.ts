/** Built-in plugin catalogs and their download hosts. Custom download origins
 * remain Owner settings; provider credentials never accompany artifact requests. */
export const minecraftPluginOrigins = [
  'https://hangar.papermc.io',
  'https://hangarcdn.papermc.io',
  'https://api.spiget.org',
  'https://cdn.spiget.org',
  'https://avocado.api.spiget.org',
  'https://spigotmc.org',
  'https://www.spigotmc.org',
] as const;
