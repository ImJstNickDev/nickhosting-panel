import type {
  MinecraftModMetadata,
  MinecraftModRoot,
  MinecraftModsSnapshot,
} from '../../../../../games/minecraft/src/ui/mods-controller.js';

type Identity = Pick<MinecraftModRoot, 'provider' | 'projectId'> & { versionId?: string };
type Item = { metadata: MinecraftModMetadata | null; aliases?: Identity[] };
export function matchesMod(item: Item, root: Identity) {
  return [item.metadata, ...(item.aliases ?? [])].some(
    (entry) => entry?.provider === root.provider && entry.projectId === root.projectId,
  );
}
export function versionForMod(item: Item, root: Identity) {
  const alias = item.aliases?.find(
    (entry) => entry.provider === root.provider && entry.projectId === root.projectId,
  );
  const id = alias?.versionId ?? item.metadata?.versionId;
  return id && item.metadata ? { id, name: item.metadata.version } : undefined;
}
export function modRootState(
  snapshot: MinecraftModsSnapshot | undefined,
  root: Identity,
  saving = false,
): 'queued' | 'preparing' | 'ready' | 'failed' | 'uncertain' | 'alreadyInstalled' | 'blocked' {
  if (saving) return 'queued';
  const change = snapshot?.changes.find((item) => matchesMod(item, root));
  if (change) return change.state;
  if (snapshot?.preparing) return 'preparing';
  if (snapshot?.error) return 'failed';
  if (snapshot?.blockers.length) return 'blocked';
  const installed = snapshot?.packs.find((pack) => matchesMod(pack, root));
  if (installed && (!root.versionId || versionForMod(installed, root)?.id === root.versionId))
    return 'alreadyInstalled';
  return 'queued';
}
