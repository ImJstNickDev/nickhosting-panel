const reservedDirectories = new Set([
  'logs',
  'libraries',
  'plugins',
  'mods',
  'config',
  'versions',
  'crash-reports',
]);

/** A direct, readable path component. External worlds can have spaces or Unicode names. */
export function isMinecraftWorldDirectory(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith('.') &&
    !/[/%\\\p{C}]/u.test(name) &&
    !reservedDirectories.has(name.toLowerCase())
  );
}

export function isManagedMinecraftWorldName(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) && !reservedDirectories.has(name.toLowerCase())
  );
}
