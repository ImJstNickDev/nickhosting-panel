/** Isolated test fixture only; no provider/server state is read or changed. */
import { gzipSync } from 'node:zlib';
import { type NBT, writeUncompressed } from 'prismarine-nbt';
export function minecraftPlayerDataFixture(modern = false): Buffer {
  const item = (slot: number, id: string, count = 1): NBT['value'] => ({
    Slot: { type: 'byte', value: slot },
    id: { type: 'string', value: id },
    ...(modern
      ? { count: { type: 'int' as const, value: count } }
      : { Count: { type: 'byte' as const, value: count } }),
  });
  return gzipSync(
    writeUncompressed(
      {
        type: 'compound',
        name: '',
        value: {
          DataVersion: { type: 'int', value: modern ? 5009 : 3465 },
          Health: { type: 'float', value: 13 },
          foodLevel: { type: 'int', value: 16 },
          foodSaturationLevel: { type: 'float', value: 4 },
          XpLevel: { type: 'int', value: 27 },
          XpTotal: { type: 'int', value: 1100 },
          XpP: { type: 'float', value: 0.42 },
          playerGameType: { type: 'int', value: 0 },
          SelectedItemSlot: { type: 'int', value: 0 },
          Dimension: { type: 'string', value: 'minecraft:overworld' },
          Pos: { type: 'list', value: { type: 'double', value: [125.5, 68, -321.25] } },
          Inventory: {
            type: 'list',
            value: {
              type: 'compound',
              value: [
                item(0, 'minecraft:diamond_pickaxe'),
                item(1, 'minecraft:diamond_sword'),
                item(2, 'minecraft:torch', 64),
                item(3, 'minecraft:cooked_beef', 24),
                item(9, 'minecraft:oak_log', 32),
                item(10, 'minecraft:iron_ingot', 18),
              ],
            },
          },
          EnderItems: {
            type: 'list',
            value: {
              type: 'compound',
              value: [item(0, 'minecraft:diamond', 12), item(1, 'minecraft:ender_pearl', 8)],
            },
          },
        },
      },
      'big',
    ),
  );
}
