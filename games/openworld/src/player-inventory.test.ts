import { describe, expect, it } from 'vitest';
import { inventoryItem } from './player-inventory.js';
import { openworldTelemetrySchemas } from './telemetry.js';

const newest = 'a1.2.9';
describe('dedicated inventory catalog', () => {
  it('resolves the server block code, including historical tile changes and release additions', () => {
    expect(inventoryItem({ code: 0x01000001 }, newest)).toMatchObject({
      name: 'Stone',
      kind: 'block',
      tile: expect.any(Number),
      wear: null,
    });
    const older = inventoryItem({ code: 0x01000022 }, 'a1.0.11');
    const newer = inventoryItem({ code: 0x01000022 }, newest);
    expect(older.name).toBe('Ore coal');
    expect(older.tile).not.toBe(newer.tile);
    expect(inventoryItem({ code: 0x010001b2 }, 'a1.1.3').name).toBeNull();
    expect(inventoryItem({ code: 0x010001b2 }, newest).name).toBe('Liana');
  });
  it('decodes material and condition independently for tools and armor', () => {
    for (const version of [newest, 'a1.2.4', 'pre-a1.2.0-1', 'a1.1.0', 'a1.0.12']) {
      expect(inventoryItem({ code: 0x03280000 }, version)).toMatchObject({
        name: 'Iron pickaxe',
        kind: 'pickaxe',
        wear: 50,
        tile: null,
      });
      expect(inventoryItem({ code: 0x0b2fffff }, version)).toMatchObject({
        name: 'Iron chestplate',
        kind: 'chestplate',
        wear: 100,
      });
    }
    expect(inventoryItem({ code: 0x0e000003 }, newest)).toMatchObject({
      name: 'Iron ingot',
      kind: 'resource',
      wear: null,
    });
    expect(inventoryItem({ code: 0x068000a4 }, newest)).toMatchObject({
      kind: 'weapon',
      name: null,
    });
  });
  it('respects explicit live identities and never reuses IDs from another or unknown release', () => {
    expect(inventoryItem({ code: 16777217 }, 'a1.2.10')).toMatchObject({
      name: null,
      kind: 'unknown',
      tile: null,
    });
    expect(
      inventoryItem(
        {
          code: 16777217,
          name: 'My custom item',
          kind: 'relic',
          icon: 'https://example.invalid/icon',
          wearPct: -1,
        },
        newest,
      ),
    ).toMatchObject({ name: 'My custom item', kind: 'relic', tile: null, wear: null });
    expect(inventoryItem({ kind: 'block', icon: '/pack/ow_stone.png' }, newest).tile).toBe(
      inventoryItem({ code: 16777217 }, newest).tile,
    );
    expect(
      inventoryItem({ kind: 'block', icon: '/pack/ow_unpublished.png' }, newest).tile,
    ).toBeNull();
    expect(inventoryItem({ code: 0x1d000000 }, 'a1.0.11').kind).toBe('unknown');
    expect(inventoryItem({ code: 0x1d000000 }, newest).kind).toBe('satellite');
    expect(inventoryItem({ code: 0x03280000, wearPct: 20 }, newest).wear).toBe(20);
    expect(inventoryItem({ code: -1 }, newest).code).toBeNull();
  });
  it('keeps official icon keys and codes while dropping unrelated paths at the API boundary', () => {
    const read = (icon: string) =>
      openworldTelemetrySchemas.player.parse({
        id: 1,
        name: 'Player',
        inventory: {
          hotbar: [{ code: 16777217, kind: 'block', name: 'stone', icon, count: 12 }],
          bag: [],
          selected: 0,
        },
      }).inventory?.hotbar[0];
    expect(read('/pack/ow_stone.png')).toMatchObject({
      code: 16777217,
      icon: '/pack/ow_stone.png',
    });
    for (const icon of [
      'https://external.test/pack/ow_stone.png',
      '/pack/../foo',
      '/pack/ow_stone.png?token=x',
      '//cdn/pack/ow_stone.png',
    ])
      expect(read(icon)).toMatchObject({ code: 16777217, icon: undefined });
  });
});
