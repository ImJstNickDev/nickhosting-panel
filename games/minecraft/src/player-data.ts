import { DomainError } from '@nickhosting/core';
import { simplify } from 'prismarine-nbt';
import { decodeMinecraftNbt } from './nbt.js';
import type { MinecraftPlayerDetail } from './player-details-contracts.js';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const integer = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : null);
const text = (value: unknown, limit = 256) =>
  typeof value === 'string' && value.length <= limit && !/[\p{Cc}\p{Cf}]/u.test(value)
    ? value
    : null;
function displayName(value: unknown): string | null {
  if (typeof value === 'string') {
    try {
      return displayName(JSON.parse(value));
    } catch {
      return text(value, 1024);
    }
  }
  const chat = object(value);
  return chat ? text(chat.text, 1024) : null;
}
function items(value: unknown): MinecraftPlayerDetail['inventory'] {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 256) return null;
  const result: NonNullable<MinecraftPlayerDetail['inventory']> = [];
  for (const raw of value) {
    const entry = object(raw);
    if (!entry) return null;
    const slot = integer(entry.Slot ?? entry.slot),
      count = integer(entry.Count ?? entry.count);
    const id = text(entry.id) ?? (integer(entry.id) !== null ? `legacy:${entry.id}` : null);
    if (slot === null || slot < -128 || slot > 255 || count === null || count < 0 || !id)
      return null;
    const tag = object(entry.tag),
      components = object(entry.components);
    const enchantments: NonNullable<MinecraftPlayerDetail['inventory']>[number]['enchantments'] =
      [];
    const legacyEnchantments = tag?.Enchantments ?? tag?.ench;
    if (Array.isArray(legacyEnchantments)) {
      if (legacyEnchantments.length > 256) return null;
      for (const rawEnchantment of legacyEnchantments.slice(0, 256)) {
        const enchantment = object(rawEnchantment);
        const level = integer(enchantment?.lvl);
        if (enchantment && level !== null)
          enchantments.push({
            id: text(enchantment.id) ?? `legacy:${integer(enchantment.id) ?? 'unknown'}`,
            level,
          });
      }
    }
    const enchantmentComponent = object(components?.['minecraft:enchantments']);
    for (const [id, level] of Object.entries(
      object(enchantmentComponent?.levels) ?? enchantmentComponent ?? {},
    ).slice(0, 256)) {
      const parsed = integer(level);
      if (parsed !== null && text(id)) enchantments.push({ id, level: parsed });
    }
    if (enchantments.length > 256) return null;
    const rawDamage = integer(components?.['minecraft:damage'] ?? tag?.Damage ?? entry.Damage);
    result.push({
      slot: slot < 0 ? slot + 256 : slot,
      id,
      count,
      damage: rawDamage !== null && rawDamage >= 0 ? rawDamage : null,
      name: displayName(components?.['minecraft:custom_name'] ?? object(tag?.display)?.Name),
      enchantments,
      hasUnknownComponents:
        !!components &&
        Object.keys(components).some(
          (key) =>
            !['minecraft:damage', 'minecraft:custom_name', 'minecraft:enchantments'].includes(key),
        ),
    });
  }
  if (new Set(result.map((entry) => entry.slot)).size !== result.length) return null;
  return result;
}

/** Observation only: never rewrites unknown tags or upgrades a player save. */
export function inspectMinecraftPlayerData(input: Uint8Array) {
  const { root } = decodeMinecraftNbt(input, {
    maxCompressedBytes: 4 * 1024 ** 2,
    maxUncompressedBytes: 16 * 1024 ** 2,
  });
  const value = object(simplify(root));
  if (!value) throw new DomainError('integration_unavailable');
  if (
    ![
      'Inventory',
      'inventory',
      'EnderItems',
      'ender_items',
      'Health',
      'health',
      'foodLevel',
      'food_level',
      'XpLevel',
      'XpTotal',
      'Pos',
      'pos',
      'playerGameType',
    ].some((key) => Object.hasOwn(value, key))
  )
    throw new DomainError('integration_unavailable');
  let inventory = items(value.Inventory ?? value.inventory);
  // Modern equipment is a separate map; selected mainhand already belongs to Inventory.
  const equipment = object(value.equipment);
  if (Object.hasOwn(value, 'equipment') && !equipment) inventory = null;
  if (equipment && inventory !== null) {
    for (const [name, slot] of [
      ['head', 103],
      ['chest', 102],
      ['legs', 101],
      ['feet', 100],
      ['offhand', 150],
    ] as const) {
      if (!Object.hasOwn(equipment, name)) continue;
      const item = object(equipment[name]);
      if (!item) {
        inventory = null;
        break;
      }
      if (!Object.keys(item).length) continue;
      const parsed = items([{ ...item, Slot: slot }]);
      if (!parsed || inventory?.some((entry) => entry.slot === slot)) {
        inventory = null;
        break;
      }
      inventory = [...(inventory ?? []), ...parsed];
    }
  }
  const pos = value.Pos ?? value.pos;
  const dimension = value.Dimension ?? value.dimension;
  let maxHealth: number | null = null;
  const attributes = value.Attributes ?? value.attributes;
  if (Array.isArray(attributes))
    for (const raw of attributes) {
      const attribute = object(raw);
      if (
        attribute &&
        ['generic.maxHealth', 'minecraft:generic.max_health', 'minecraft:max_health'].includes(
          String(attribute.Name ?? attribute.id),
        )
      )
        maxHealth = number(attribute.Base ?? attribute.base);
    }
  return {
    dataVersion: integer(value.DataVersion),
    inventory,
    enderChest: items(value.EnderItems ?? value.ender_items),
    selectedSlot: integer(value.SelectedItemSlot ?? value.selected_item_slot),
    vitals: {
      health: number(value.Health ?? value.health),
      maxHealth,
      food: number(value.foodLevel ?? value.food_level),
      saturation: number(value.foodSaturationLevel ?? value.food_saturation_level),
      experienceLevel: number(value.XpLevel ?? value.xp_level),
      experienceProgress: number(value.XpP ?? value.xp_progress),
      experienceTotal: number(value.XpTotal ?? value.xp_total),
      gameMode: number(value.playerGameType ?? value.player_game_type),
    },
    position:
      Array.isArray(pos) && pos.length === 3 && pos.every((part) => number(part) !== null)
        ? {
            x: pos[0] as number,
            y: pos[1] as number,
            z: pos[2] as number,
            dimension: text(dimension) ?? number(dimension),
          }
        : null,
  };
}

export function inspectMinecraftPlayerStatistics(
  input: Uint8Array,
): NonNullable<MinecraftPlayerDetail['statistics']> {
  if (input.byteLength > 4 * 1024 ** 2) throw new DomainError('integration_unavailable');
  let root: Record<string, unknown> | undefined;
  try {
    root = object(JSON.parse(Buffer.from(input).toString('utf8')));
  } catch {
    throw new DomainError('integration_unavailable');
  }
  if (!root) throw new DomainError('integration_unavailable');
  const statistics: NonNullable<MinecraftPlayerDetail['statistics']> = [];
  const groups = object(root.stats);
  if (Object.hasOwn(root, 'stats') && !groups) throw new DomainError('integration_unavailable');
  const append = (category: string, id: string, value: unknown) => {
    if (number(value) === null || !text(category) || !text(id))
      throw new DomainError('integration_unavailable');
    if (statistics.length >= 20000) throw new DomainError('integration_unavailable');
    statistics.push({ category, id, value: value as number });
  };
  if (groups)
    for (const [category, entries] of Object.entries(groups)) {
      const values = object(entries);
      if (!values) throw new DomainError('integration_unavailable');
      for (const [id, value] of Object.entries(values)) append(category, id, value);
    }
  else
    for (const [id, value] of Object.entries(root))
      if (id !== 'DataVersion') append('legacy', id, value);
  return statistics;
}
