import { useState } from 'react';
import type { OpenworldSavedPlayerDetail } from '../../../../../games/openworld/src/offline-players.js';
import {
  type InventoryItem,
  inventoryItem,
  knownInventoryKind,
} from '../../../../../games/openworld/src/player-inventory.js';
import type { OpenworldTelemetryData } from '../../../../../games/openworld/src/telemetry.js';
import { inventoryNameKey } from '../../../../../games/openworld/src/ui/player-inventory-catalog.js';
import { useLocale, useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { InventoryGlyph } from './inventory-glyph.js';
import { key, useMetricsFormat } from './telemetry.js';
import './player-hud-fonts.css';
import './player-inventory.css';

type Player = OpenworldTelemetryData['player'];
type Props = (
  | { source: 'live'; player: Player }
  | { source: 'saved'; player: OpenworldSavedPlayerDetail }
) & { version?: string | null };
type Item = ReturnType<typeof inventoryItem>;
type Equipment = Pick<Player, 'armor' | 'heldItem'> & { gear?: Player['armor'] };
const armorSlots = ['helmet', 'chestplate', 'leggings', 'boots'];
const gearSlots = ['outfit', 'accessory'];
type T = ReturnType<typeof useT>;
const inv = (id: string) => `games.openworld.inventory.${id}`;
const grade =
  /^(wood|stone|iron|titanium|cast iron|raisonite|copper|leather|steel|gold|electrum|diamond) (pickaxe|axe|chisel|shovel|shears|helmet|chestplate|leggings|boots)$/i;
const nativeTool =
  /^(pioche|hache|burin|pelle|cisailles) en (wood|stone|iron|titanium|cast iron|raisonite)$/i;
const compact = {
  en: new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 0 }),
  it: new Intl.NumberFormat('it', { notation: 'compact', maximumFractionDigits: 0 }),
};
const nativeToolKinds: Record<string, string> = {
  pioche: 'pickaxe',
  hache: 'axe',
  burin: 'chisel',
  pelle: 'shovel',
  cisailles: 'shears',
};
function presentation(item: Item, t: T) {
  const direct = grade.exec(item.name ?? '');
  const native = nativeTool.exec(item.name ?? '');
  const material = (direct?.[1] ?? native?.[2])?.toLowerCase();
  const type = direct?.[2]?.toLowerCase() ?? nativeToolKinds[native?.[1]?.toLowerCase() ?? ''];
  if (material && type && type === item.kind) {
    return {
      material,
      name: t(inv('materialName'), {
        material: t(inv(material)),
        kind: t(inv(type)).toLowerCase(),
      }).replace(/^./u, (s) => s.toLocaleUpperCase()),
    };
  }
  const itemKey = item.name && inventoryNameKey(item.name);
  return {
    material: undefined,
    name: itemKey
      ? t(itemKey)
      : (item.name ?? t(inv(knownInventoryKind(item.kind) ? item.kind : 'unnamed'))),
  };
}
function Durability({ wear }: { wear: number | null }) {
  if (wear === null) return null;
  return (
    <span className="ow-item-condition" aria-hidden="true">
      <i data-worn={wear >= 80} style={{ width: `${100 - wear}%` }} />
    </span>
  );
}
function Details({ item, t }: { item: Item; t: T }) {
  const { name, material } = presentation(item, t);
  const f = useMetricsFormat();
  return (
    <div className="ow-item-detail">
      <div className="ow-item-detail-art">
        <InventoryGlyph kind={item.kind} tile={item.tile} material={material} />
      </div>
      <div>
        <strong>{name}</strong>
        <div className="ow-item-meta">
          {item.count != null && <span>{t(inv('stack'), { count: f.number(item.count) })}</span>}
          {item.wear !== null && <span>{t(key('wear'), { value: f.metric(item.wear, '%') })}</span>}
          {item.code !== null && <small>#{item.code}</small>}
        </div>
      </div>
    </div>
  );
}
export function PlayerInventory(props: Props) {
  const t = useT(),
    f = useMetricsFormat();
  const { locale } = useLocale();
  const [picked, setPicked] = useState<number | null>(null);
  const inventory = props.player.inventory;
  if (!inventory || (props.source === 'live' && props.player.inventoryKnown === false))
    return (
      <p className="ow-empty">
        {t(key(props.source === 'live' ? 'inventoryUnknown' : 'noSavedInventory'))}
      </p>
    );
  const hot = inventory.hotbar,
    bag = inventory.bag;
  const entries = new Map<number, Item>();
  for (const [items, start] of [
    [hot, 0],
    [bag, 12],
  ] as const)
    items.forEach((value, index) => {
      if (value) entries.set(index + start, inventoryItem(value, props.version));
    });
  const selected = inventory.selected;
  const active =
    picked !== null && entries.has(picked)
      ? picked
      : selected != null && entries.has(selected)
        ? selected
        : entries.keys().next().value;
  const detail = active === undefined ? undefined : entries.get(active);
  const reported = props.source === 'live' ? props.player.inventory?.reportedAgoS : undefined;
  function grid(
    slots: (InventoryItem | null)[],
    name: 'hotbar' | 'bag',
    offset: number,
    count: number,
  ) {
    return (
      <section className={`ow-item-group ow-kit-${name}`} aria-label={t(key(name))}>
        <div className="ow-item-heading">
          <h3>{t(key(name))}</h3>
          {name === 'bag' && slots.length === count && (
            <small className="ow-kit-usage">
              {t(inv('bagUsage'), { filled: slots.filter(Boolean).length, total: count })}
            </small>
          )}
          {name === 'hotbar' && reported != null && (
            <small>{t(key('inventoryAge'), { age: f.duration(reported) })}</small>
          )}
        </div>
        <ol className="ow-item-grid">
          {Array.from({ length: count }, (_, i) => {
            const index = offset + i,
              slot = t(inv('slot'), { number: index + 1 }),
              item = entries.get(index);
            const inHand = selected === index && name === 'hotbar';
            if (!item)
              return (
                <li
                  key={index}
                  className="ow-item-slot ow-item-empty"
                  data-in-hand={inHand}
                  data-missing={i >= slots.length}
                  aria-label={[
                    slot,
                    t(i >= slots.length ? inv('missing') : key('emptySlot')),
                    inHand ? t(inv('selectedSlot')) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                >
                  {name === 'hotbar' && <small aria-hidden="true">{i + 1}</small>}
                </li>
              );
            const { name: title, material } = presentation(item, t);
            const tooltip = [
              title,
              slot,
              inHand ? t(inv('selectedSlot')) : null,
              item.count != null ? t(inv('stack'), { count: f.number(item.count) }) : null,
              item.wear !== null ? t(key('wear'), { value: f.metric(item.wear, '%') }) : null,
              item.code !== null ? `#${item.code}` : null,
            ]
              .filter(Boolean)
              .join('\n');
            return (
              <li key={index}>
                <Tooltip content={tooltip}>
                  <button
                    type="button"
                    className="ow-item-slot"
                    data-in-hand={inHand}
                    aria-label={`${slot} · ${title}${inHand ? ` · ${t(inv('selectedSlot'))}` : ''}`}
                    aria-pressed={index === active}
                    onClick={() => setPicked(index)}
                  >
                    {name === 'hotbar' && <small aria-hidden="true">{i + 1}</small>}
                    <InventoryGlyph kind={item.kind} tile={item.tile} material={material} />
                    {item.count != null && item.count > 1 && (
                      <b aria-hidden="true">
                        {item.count > 999
                          ? compact[locale === 'it' ? 'it' : 'en'].format(item.count)
                          : f.number(item.count)}
                      </b>
                    )}
                    <Durability wear={item.wear} />
                  </button>
                </Tooltip>
              </li>
            );
          })}
        </ol>
      </section>
    );
  }
  const hasEquipment = !!props.player.armor || !!('gear' in props.player && props.player.gear);
  return (
    <div className="ow-inventory">
      <div className="ow-kit-board" data-equipped={hasEquipment}>
        {hasEquipment && (
          <PlayerEquipment player={props.player} version={props.version} inventory />
        )}
        {grid(bag, 'bag', 12, 36)}
        {grid(hot, 'hotbar', 0, 12)}
        {detail && <Details item={detail} t={t} />}
      </div>
    </div>
  );
}

export function PlayerEquipment({
  player,
  version,
  inventory = false,
}: {
  player: Equipment;
  version?: string | null;
  inventory?: boolean;
}) {
  const t = useT();
  const f = useMetricsFormat();
  const groups = [
    { id: 'armor', label: t(key('equipment')), slots: armorSlots, items: player.armor },
    { id: 'gear', label: t(inv('gear')), slots: gearSlots, items: player.gear },
    ...(!inventory && player.heldItem !== undefined
      ? [{ id: 'held', label: t(key('held')), slots: ['held'], items: [player.heldItem] }]
      : []),
  ].filter((group) => group.items != null);
  if (!groups.length) return null;
  return (
    <div className="ow-equipment">
      {groups.map(({ id, label, slots, items }) => (
        <section key={id} className="ow-kit-loadout" aria-label={label}>
          <h3>{label}</h3>
          <ul>
            {slots.map((slot, i) => {
              const keyInSave = slot === 'accessory' ? 'equipment' : slot;
              const indexItem = items?.[i];
              const raw =
                items?.find((entry) => entry && 'slot' in entry && entry.slot === keyInSave) ??
                (indexItem && 'slot' in indexItem && indexItem.slot && indexItem.slot !== keyInSave
                  ? undefined
                  : indexItem);
              const item = raw ? inventoryItem(raw, version) : null;
              const view = item ? presentation(item, t) : null;
              const glyph = slot === 'accessory' ? 'parachute' : slot;
              return (
                <li key={slot} data-empty={!item}>
                  <span className="ow-equipment-art" aria-hidden="true">
                    <InventoryGlyph
                      kind={item?.kind ?? glyph}
                      tile={item?.tile ?? null}
                      material={view?.material}
                    />
                  </span>
                  <div>
                    {id !== 'held' && <small>{t(inv(slot))}</small>}
                    <strong>
                      {view?.name ?? t(raw === undefined ? inv('missing') : key('emptySlot'))}
                    </strong>
                    {item?.wear != null && (
                      <small>{t(key('wear'), { value: f.metric(item.wear, '%') })}</small>
                    )}
                    {item?.code != null && <small className="ow-equipment-id">#{item.code}</small>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
