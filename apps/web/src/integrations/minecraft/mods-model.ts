import type {
  MinecraftModMetadata,
  MinecraftModRoot,
  MinecraftModsSnapshot,
  MinecraftModUpdates,
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

/** A response belongs to the observed installed file, never to a later replacement. */
export function currentModUpdates(snapshot: MinecraftModsSnapshot, updates?: MinecraftModUpdates) {
  return (
    updates?.items.filter((update) =>
      snapshot.packs.some(
        (pack) =>
          pack.path === update.path &&
          pack.metadata?.provider === update.provider &&
          pack.metadata.projectId === update.projectId &&
          pack.metadata.versionId === update.currentVersionId,
      ),
    ) ?? []
  );
}

/** Preserve manual selections and file-state actions when preparing a catalog update. */
export function eligibleModUpdates(
  snapshot: MinecraftModsSnapshot,
  updates: MinecraftModUpdates | undefined,
  roots: MinecraftModRoot[],
) {
  return currentModUpdates(snapshot, updates).filter((update) => {
    if (
      update.status !== 'update' ||
      !update.version?.available ||
      update.version.compatibility.length ||
      update.version.provider !== update.provider ||
      update.version.projectId !== update.projectId ||
      update.version.id === update.currentVersionId
    )
      return false;
    const pack = snapshot.packs.find((pack) => pack.path === update.path);
    if (!pack || roots.some((root) => matchesMod(pack, root))) return false;
    return !snapshot.changes.some(
      (change) => change.path === pack.path || matchesMod(change, update),
    );
  });
}

export function installedModsFingerprint(snapshot?: MinecraftModsSnapshot) {
  return JSON.stringify(
    snapshot?.packs
      .filter((pack) => pack.metadata)
      .map((pack) => [
        pack.path,
        pack.metadata?.provider,
        pack.metadata?.projectId,
        pack.metadata?.versionId,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))) ?? [],
  );
}

/** Roots share a dependency; they do not form an invented linear dependency chain. */
export function modBlockerChain(item: MinecraftModsSnapshot['blockers'][number]) {
  const roots = item.roots?.filter((root) => root.projectId !== item.projectId) ?? [];
  const group = [...new Set(roots.map((root) => root.name))].join(', ');
  const parent =
    item.requiredBy &&
    item.requiredBy !== item.projectId &&
    !roots.some((root) => root.projectId === item.requiredBy)
      ? (item.requiredByName ?? item.requiredBy)
      : '';
  return [group, parent].filter(Boolean).join(' → ');
}
