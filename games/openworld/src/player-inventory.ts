import facts from './inventory-facts.json' with { type: 'json' };

// Factual code/name pairs were obtained from the dedicated Linux formatter of each
// listed release. Tiles use the corresponding default pack (Openworld, CC0-1.0).
// The atlas contains only the base-color PNGs; indices retain historical tile variants.
type Changes<T> = Partial<Record<string, T | null>>;
const catalog: {
  versions: Record<string, number>;
  items: Record<string, string>;
  tiles: Record<string, number>;
  changes: { items: Changes<string>; tiles: Changes<number>; maxKind: number }[];
} = facts;

const kinds = [
  '',
  'block',
  'bone',
  'pickaxe',
  'axe',
  'chisel',
  'weapon',
  'food',
  'outfit',
  'parachute',
  'helmet',
  'chestplate',
  'leggings',
  'boots',
  'resource',
  'rocketpart',
  'propellant',
  'key',
  'shovel',
  'shears',
  'bucket',
  'gascylinder',
  'fabric',
  'furniture',
  'customprefab',
  'blueprint',
  'spyglass',
  'unknown',
  'spacegear',
  'satellite',
  'furniture',
  'vehicle',
  'hearthmark',
];
const knownKinds = new Set(kinds.filter((kind) => kind && kind !== 'unknown'));
export function knownInventoryKind(kind: string) {
  return knownKinds.has(kind);
}
const graded = new Set([
  'pickaxe',
  'axe',
  'chisel',
  'helmet',
  'chestplate',
  'leggings',
  'boots',
  'shovel',
  'shears',
]);
export type InventoryItem = {
  code?: number | null;
  count?: number | null;
  name?: string | null;
  kind?: string | null;
  wearPct?: number | null;
  icon?: string | null;
};
function published<T>(key: string, base: Record<string, T>, changes: Changes<T>) {
  if (Object.hasOwn(changes, key)) return changes[key] ?? null;
  return Object.hasOwn(base, key) ? (base[key] ?? null) : null;
}
export function inventoryItem(item: InventoryItem, version?: string | null) {
  const release =
    version && Object.hasOwn(catalog.versions, version) ? catalog.versions[version] : undefined;
  const changes = release === undefined ? undefined : catalog.changes[release];
  const code =
    typeof item.code === 'number' &&
    Number.isInteger(item.code) &&
    item.code > 0 &&
    item.code <= 0xffffffff
      ? item.code
      : null;
  const tag = code === null ? 0 : code >>> 24;
  const codeKind = changes && tag > 0 && tag <= changes.maxKind ? kinds[tag] : undefined;
  const kind = item.kind?.trim() || codeKind || 'unknown';
  let name: string | null = null;
  let tile: number | null = null;
  let condition: number | null = null;
  if (changes && code !== null && codeKind && codeKind === kind) {
    let lookup = code;
    // Non-extended tools and armor store wear in the low 20 bits.
    if (graded.has(kind) && !(code & 0x800000)) {
      lookup = code - (code & 0xfffff);
      condition = Math.round(((code & 0xfffff) / 0xfffff) * 100);
    }
    const record = published(String(lookup), catalog.items, changes.items);
    if (record) {
      const [label, index] = record.split('|');
      name = label ?? null;
      tile = index === undefined ? null : Number(index);
    }
  }
  const rawName = item.name?.trim();
  // A native report can carry a custom name or an enchantment suffix.
  if (rawName && (!name || rawName.toLowerCase().replaceAll('_', ' ') !== name.toLowerCase()))
    name = rawName;
  if (changes && item.icon) {
    const asset = /^\/pack\/(ow_[a-z0-9_]+)\.png$/.exec(item.icon)?.[1];
    if (asset) tile = published(asset, catalog.tiles, changes.tiles);
  }
  const wear = item.wearPct === undefined ? condition : item.wearPct;
  return {
    code,
    kind,
    name,
    tile,
    count: item.count,
    wear: typeof wear === 'number' && wear >= 0 && wear <= 100 ? wear : null,
  };
}
