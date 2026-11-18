// Optional local official-client resources: a single atlas avoids importing a
// module per item in development. Named SVG views crop its embedded PNGs.
const base = '../../../../../games/minecraft/src/ui/assets/local-26.1/';
const atlas = import.meta.glob<string>(
  '../../../../../games/minecraft/src/ui/assets/local-26.1/player-atlas.svg',
  { eager: true, query: '?url&no-inline', import: 'default' },
)[`${base}player-atlas.svg`];
const index = import.meta.glob<{
  items: Record<string, string>;
}>('../../../../../games/minecraft/src/ui/assets/local-26.1/player-atlas.json', {
  eager: true,
  import: 'default',
})[`${base}player-atlas.json`];

export function minecraftItemIcon(id: string): string | undefined {
  const name = id.startsWith('minecraft:') ? id.slice('minecraft:'.length) : id;
  if (!/^[a-z0-9_]+(?:\/[a-z0-9_]+)*$/.test(name)) return undefined;
  const fragment = index && Object.hasOwn(index.items, name) ? index.items[name] : undefined;
  return atlas && fragment ? `${atlas}#${fragment}` : undefined;
}

// HUD and bitmap XP digits retain their intrinsic aspect ratio; item sprites
// share the square atlas above. Resources remain optional and local.
const hud = import.meta.glob<string>(
  '../../../../../games/minecraft/src/ui/assets/local-26.1/player-hud/*.png',
  { eager: true, query: '?url&no-inline', import: 'default' },
);

export function minecraftPlayerHudAsset(name: string): string | undefined {
  if (!/^[a-z0-9_]+$/.test(name)) return undefined;
  return hud[`${base}player-hud/${name}.png`];
}

// Inventory slots load native PNGs only when used. This bypasses SVG-internal
// resampling without eagerly fetching one Vite module per vanilla item.
const itemPngs = import.meta.glob<string>(
  '../../../../../games/minecraft/src/ui/assets/local-26.1/player-items/**/*.png',
  { query: '?url&no-inline', import: 'default' },
);
export async function minecraftInventoryIcons(
  ids: readonly string[],
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    ids.map(async (id) => {
      if (!id.startsWith('minecraft:')) return undefined;
      const name = id.slice('minecraft:'.length);
      if (!/^[a-z0-9_]+(?:\/[a-z0-9_]+)*$/.test(name)) return undefined;
      const load = itemPngs[`${base}player-items/${name}.png`];
      return load ? ([id, await load()] as const) : undefined;
    }),
  );
  return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}
