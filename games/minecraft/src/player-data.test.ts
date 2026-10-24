import { gzipSync } from 'node:zlib';
import { type NBT, writeUncompressed } from 'prismarine-nbt';
import { describe, expect, it } from 'vitest';
import { inspectMinecraftPlayerData, inspectMinecraftPlayerStatistics } from './player-data.js';
import { minecraftPlayerDetailActionSchema } from './player-details-contracts.js';

const saved = (value: NBT['value']) =>
  gzipSync(writeUncompressed({ type: 'compound', name: '', value }, 'big'));
describe('bounded saved player observations', () => {
  it('reads legacy inventory, signed offhand slot and saved vitals without inventing missing fields', () => {
    const result = inspectMinecraftPlayerData(
      saved({
        Health: { type: 'float', value: 17 },
        foodLevel: { type: 'int', value: 12 },
        Pos: { type: 'list', value: { type: 'double', value: [1.25, 64, -3] } },
        Dimension: { type: 'int', value: -1 },
        Inventory: {
          type: 'list',
          value: {
            type: 'compound',
            value: [
              {
                Slot: { type: 'byte', value: -106 },
                id: { type: 'string', value: 'minecraft:shield' },
                Count: { type: 'byte', value: 1 },
                tag: { type: 'compound', value: { Damage: { type: 'int', value: 4 } } },
              },
            ],
          },
        },
        EnderItems: { type: 'list', value: { type: 'compound', value: [] } },
      }),
    );
    expect(result).toMatchObject({
      dataVersion: null,
      inventory: [{ slot: 150, id: 'minecraft:shield', count: 1, damage: 4 }],
      enderChest: [],
      vitals: { health: 17, maxHealth: null, food: 12, experienceLevel: null },
      position: { x: 1.25, y: 64, z: -3, dimension: -1 },
    });
  });
  it('preserves modern component item identity and reports unknown mod components', () => {
    const result = inspectMinecraftPlayerData(
      saved({
        DataVersion: { type: 'int', value: 5009 },
        Inventory: {
          type: 'list',
          value: {
            type: 'compound',
            value: [
              {
                Slot: { type: 'byte', value: 3 },
                id: { type: 'string', value: 'example:custom_item' },
                count: { type: 'int', value: 32 },
                components: {
                  type: 'compound',
                  value: {
                    'minecraft:damage': { type: 'int', value: 6 },
                    'example:energy': { type: 'int', value: 150 },
                    'minecraft:custom_name': { type: 'string', value: '{"text":"Custom tool"}' },
                    'minecraft:enchantments': {
                      type: 'compound',
                      value: { 'minecraft:unbreaking': { type: 'int', value: 3 } },
                    },
                  },
                },
              },
            ],
          },
        },
      }),
    );
    expect(result.inventory?.[0]).toEqual({
      slot: 3,
      id: 'example:custom_item',
      count: 32,
      damage: 6,
      name: 'Custom tool',
      enchantments: [{ id: 'minecraft:unbreaking', level: 3 }],
      hasUnknownComponents: true,
    });
    expect(result.enderChest).toBeNull();
    expect(result.position).toBeNull();
  });
  it('refuses malformed/compressed oversized NBT and leaves unrecognized inventory unknown', () => {
    expect(() => inspectMinecraftPlayerData(gzipSync(Buffer.alloc(17 * 1024 ** 2)))).toThrow();
    expect(() => inspectMinecraftPlayerData(Buffer.from('invalid'))).toThrow();
    expect(() => inspectMinecraftPlayerData(saved({}))).toThrow();
    expect(
      inspectMinecraftPlayerData(saved({ Inventory: { type: 'string', value: 'future-format' } }))
        .inventory,
    ).toBeNull();
  });
  it('reads modern equipment separately without duplicating the selected mainhand', () => {
    const item = {
      type: 'compound' as const,
      value: {
        id: { type: 'string' as const, value: 'minecraft:diamond_helmet' },
        count: { type: 'int' as const, value: 1 },
      },
    };
    const result = inspectMinecraftPlayerData(
      saved({
        Inventory: { type: 'list', value: { type: 'compound', value: [] } },
        equipment: { type: 'compound', value: { head: item, mainhand: item, offhand: item } },
        XpTotal: { type: 'int', value: 321 },
      }),
    );
    expect(result.inventory?.map((entry) => entry.slot)).toEqual([103, 150]);
    expect(result.vitals.experienceTotal).toBe(321);
  });
  it('normalizes legacy and grouped statistics without inventing counters', () => {
    expect(inspectMinecraftPlayerStatistics(Buffer.from('{"stat.deaths":4}'))).toEqual([
      { category: 'legacy', id: 'stat.deaths', value: 4 },
    ]);
    expect(
      inspectMinecraftPlayerStatistics(
        Buffer.from(
          '{"stats":{"minecraft:custom":{"minecraft:play_time":1200}},"DataVersion":5009}',
        ),
      ),
    ).toEqual([{ category: 'minecraft:custom', id: 'minecraft:play_time', value: 1200 }]);
    expect(() => inspectMinecraftPlayerStatistics(Buffer.from('broken'))).toThrow();
    for (const value of [
      { stats: 'future-format' },
      { stats: { 'minecraft:custom': 'bad' } },
      { future: {} },
      { stats: { 'minecraft:custom': { counter: 'bad' } } },
    ])
      expect(() => inspectMinecraftPlayerStatistics(Buffer.from(JSON.stringify(value)))).toThrow();
    expect(inspectMinecraftPlayerStatistics(Buffer.from('{"stats":{}}'))).toEqual([]);
  });
  it('keeps malformed declared equipment unknown rather than displaying empty armor', () => {
    for (const equipment of [
      { type: 'string' as const, value: 'future' },
      { type: 'compound' as const, value: { head: { type: 'string' as const, value: 'future' } } },
    ]) {
      const result = inspectMinecraftPlayerData(
        saved({ Inventory: { type: 'list', value: { type: 'compound', value: [] } }, equipment }),
      );
      expect(result.inventory).toBeNull();
    }
  });
  it('rejects command fragments, nonfinite coordinates, overbroad reset and missing consent', () => {
    for (const input of [
      { action: 'gamemode', mode: 'creative @a' },
      { action: 'teleport', x: Infinity, y: 0, z: 0 },
      { action: 'reset', scopes: ['world'], revision: 'a'.repeat(64), confirm: true },
      { action: 'reset', scopes: ['playerdata'], revision: 'a'.repeat(64) },
      { action: 'heal', command: 'op Nobody' },
    ])
      expect(minecraftPlayerDetailActionSchema.safeParse(input).success).toBe(false);
  });
});
