import type { MinecraftPlayers as Snapshot } from '@nickhosting/minecraft/ui';

export type MinecraftPlayerRow = {
  name: string;
  nameKnown?: boolean;
  uuid?: string;
  online: boolean;
  operator?: Snapshot['operators'][number];
  whitelisted: boolean;
  whitelistEntry?: Snapshot['whitelist'][number];
  banned?: Snapshot['banned'][number];
};

/** Saved UUIDs establish identity; online names annotate those same rows. */
export function mergeMinecraftPlayers(
  snapshot: Snapshot,
  online: readonly { name: string }[],
): MinecraftPlayerRow[] {
  const rows = new Map<string, MinecraftPlayerRow>();
  const byName = new Map<string, MinecraftPlayerRow | null>();
  const rememberName = (name: string, row: MinecraftPlayerRow) => {
    const prior = byName.get(name);
    byName.set(name, prior === undefined || prior === row ? row : null);
  };
  const add = (player: { name: string; uuid?: string }) => {
    const identity = player.uuid?.replaceAll('-', '').toLowerCase();
    const name = player.name.toLowerCase();
    const existing = identity ? rows.get(identity) : byName.get(name);
    if (existing) {
      if (identity) rows.set(identity, existing);
      rememberName(name, existing);
      if (!identity) existing.name = player.name;
      return existing;
    }
    const row: MinecraftPlayerRow = { ...player, online: false, whitelisted: false };
    rows.set(identity ?? name, row);
    rememberName(name, row);
    return row;
  };
  for (const player of snapshot.operators) add(player).operator = player;
  for (const player of snapshot.whitelist) {
    const row = add(player);
    row.whitelisted = true;
    row.whitelistEntry = player;
  }
  for (const player of snapshot.banned) add(player).banned = player;
  for (const player of snapshot.knownPlayers ?? []) {
    const row = add({ name: player.name ?? player.uuid, uuid: player.uuid });
    if (player.name) {
      row.name = player.name;
      row.nameKnown = true;
    } else if (row.name === player.uuid) row.nameKnown = false;
  }
  for (const player of online) add(player).online = true;
  return [...new Set(rows.values())].sort(
    (a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
  );
}
