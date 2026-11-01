import type { FilemanPathEntry } from '@nickhosting/game-sdk/ui';

const rootHiddenNames = new Set(['libraries', 'versions', 'eula.txt', 'usercache.json']);

/** All Minecraft runtimes share these root housekeeping entries; nothing is removed. */
export function minecraftFileEntryGroup({
  path,
  entry,
}: {
  readonly path: string;
  readonly runtimeId: string;
  readonly entry: FilemanPathEntry;
}): 'hidden' | undefined {
  if (path !== '' && path !== '/') return undefined;
  return (!entry.is_file && entry.name.startsWith('.')) || rootHiddenNames.has(entry.name)
    ? 'hidden'
    : undefined;
}
