/** Shared by the manifest and browser UI; these declarations do not grant permissions. */
export const minecraftContentRuntimes = {
  mods: ['fabric', 'forge'],
  plugins: ['paper', 'folia'],
} as const;

export function minecraftContentCapabilities(runtime: string) {
  return {
    mods: minecraftContentRuntimes.mods.some((id) => id === runtime),
    plugins: minecraftContentRuntimes.plugins.some((id) => id === runtime),
  };
}
