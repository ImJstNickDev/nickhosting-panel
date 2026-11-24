import type { CSSProperties } from 'react';

const metal: Record<string, string> = {
  wood: '#bc8f61',
  stone: '#aab1b1',
  iron: '#c7d6d8',
  'cast iron': '#929bac',
  titanium: '#b4bad7',
  raisonite: '#cda6e9',
  copper: '#e9a076',
  leather: '#ae845f',
  steel: '#b1c4ce',
  gold: '#e8c76d',
  electrum: '#d9d89a',
  diamond: '#8ed2da',
};
// Original, deliberately low-resolution silhouettes for item kinds with no distributed sprite.
const silhouettes: Record<string, string> = {
  pickaxe: 'M5 3h10v2h3v2h2v5h-2V9h-2V7h-4V5H5z',
  axe: 'M9 2h4v2h6v2h2v5h-2v2h-6V9h-2V6H9z',
  shovel: 'M12 3h7v2h2v6h-2v2h-4v-2h-2V9h-2V5h1z',
  chisel: 'M12 5h4V3h4v4h-2v3h-3v2h-3z',
  shears:
    'M3 16h2v-3h5v2h2v-2h3V9h2V5h2V2h2v7h-2v4h-2v3h2v5h-2v1h-4v-2h-2v-4H9v4H7v2H3v-2H2v-3h1zm2 0v3h2v-3zm9 1v2h3v-2z',
  weapon:
    'M5 15h3v-2h2v-2h2V9h2V7h2V5h2V3h4v5h-2v2h-2v2h-2v2h-2v2h-2v1h2v3h-3v-2H8v2H6v2H3v-3h2v-2H3v-3h2z',
  helmet: 'M5 6h3V4h9v2h3v3h1v10h-5v-3h2v-5H7v5h2v3H4V9h1z',
  chestplate: 'M4 5h5v2h2v1h3V7h2V5h5v6h-2v9h-2v1H8v-1H6v-9H4z',
  leggings: 'M6 4h13v17h-5v-8h-3v8H6z',
  boots: 'M4 5h6v13H8v2H2v-5h2zm10 0h6v10h2v5h-6v-2h-2z',
  food: 'M6 8h4V6h5v2h3v1h2v8h-2v3h-3v1h-2v-1h-2v1H8v-2H6v-2H4v-7h2zm6-3V2h2v3zm2 1V4h4v2z',
  resource: 'M4 12h2v-2h3V8h9v2h2v5h-2v2h-3v2H5v-2H3v-4h1z',
  bone: 'M3 4h3v2h3v3h2v2h2v2h2v2h4v2h2v3h-3v2h-3v-4h-2v-2h-2v-2H9v-2H7v-2H3V8H1V5h2z',
  key: 'M4 4h7v2h2v5h-2v2H8v2H6v2H4v3H1v-6h2v-2h2v-1H3V6h1zm2 3v3h4V7z',
  blueprint: 'M5 3h13v2h2v16H5zm3 5v1h8V8zm0 3v1h4v4h1v-5zm6 4v1h2v-1z',
  bucket: 'M5 8h2V5h2V3h6v2h2v3h2v2h1v2h-1v6h-2v3H7v-3H5v-6H4v-2h1zm3 0h8V6h-2V5h-4v1H8z',
  rocketpart: 'M12 2h2v2h2v3h1v6h2v3h2v4h-5l-2-2h-3l-2 2H4v-4h2v-3h2V7h2V4h2z',
  propellant: 'M10 4h4v3h2v3h2v3h2v4h-2v3h-3v1H9v-1H6v-3H4v-4h2v-3h2V7h2z',
  furniture: 'M4 3h4v9h10v-2h2v11h-3v-6H7v6H4z',
  parachute: 'M2 10h2V7h3V5h3V3h4v2h3v2h3v3h2v3h-2l-6 7v2h-4v-2l-6-7H2zm5 2 4 6v-6zm6 0v6l4-6z',
  spyglass: 'M2 16h3v-2h3v-2h2V9h3V7h3V4h3v1h2v2h2v3h-2v2h-3v2h-3v2h-3v2H9v2H6v2H3v-2H1v-3h1z',
  vehicle: 'M5 8h3V5h8v3h3v3h2v7h-2v3h-4v-3H8v3H4v-3H2v-6h3zm3 3h8V9h-2V7h-4v2H8z',
  satellite: 'M2 4h6v2h2v4h3V8h3V6h6v6h-2v2h-4v3h-3v3h-2v2H9v-4h2v-4H8v-3H4V9H2z',
  gascylinder: 'M9 2h6v2h-1v2h2v2h2v11h-2v2H8v-2H6V8h2V6h2V4H9z',
  unknown: 'M3 7l9-4 9 4v11l-9 4-9-4zm2 2v7l6 3v-7zm8 3v7l6-3V9zm-6-5 5 3 5-3-5-2z',
};
const aliases: Record<string, string> = {
  block: 'unknown',
  outfit: 'chestplate',
  fabric: 'blueprint',
  customprefab: 'blueprint',
  spacegear: 'rocketpart',
};
export function InventoryGlyph({
  kind,
  tile,
  material,
}: {
  kind: string;
  tile: number | null;
  material?: string;
}) {
  if (tile !== null) {
    const style = {
      '--ow-tile-x': `${((tile % 20) * 100) / 19}%`,
      '--ow-tile-y': `${(Math.floor(tile / 20) * 100) / 16}%`,
    } as CSSProperties;
    return <span className="ow-item-tile" style={style} aria-hidden="true" />;
  }
  const tool = ['pickaxe', 'axe', 'shovel', 'chisel'].includes(kind);
  const canonical = Object.hasOwn(silhouettes, kind)
    ? kind
    : Object.hasOwn(aliases, kind)
      ? (aliases[kind] ?? 'unknown')
      : 'unknown';
  return (
    <svg
      className={`ow-item-glyph ow-item-glyph-${canonical}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      shapeRendering="crispEdges"
      style={material && Object.hasOwn(metal, material) ? { color: metal[material] } : undefined}
    >
      {tool && (
        <path
          d="M3 18h2v-2h2v-2h2v-2h2v-2h2V8h2V6h3v3h-2v2h-2v2h-2v2h-2v2H8v2H6v2H3z"
          fill="#ac8158"
        />
      )}
      <path d={silhouettes[canonical]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
