import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client.js';
import { fetchInventoryTextures, inventoryTextureIds } from './player-inventory-assets.js';
import { stackGlyphFromXp } from './player-item-count.js';

vi.mock('../../api/client.js', () => ({ api: vi.fn() }));

beforeEach(() => vi.mocked(api).mockReset());

describe('Minecraft inventory artwork', () => {
  it('shares namespaced IDs across inventory and ender chest, with bounded cancellable batches', async () => {
    const ids = inventoryTextureIds(
      [{ id: 'solcarrot:food_book' }, { id: 'minecraft:stone' }, { id: '../invalid' }],
      [{ id: 'solcarrot:food_book' }],
    );
    expect(ids).toEqual(['minecraft:stone', 'solcarrot:food_book']);
    const png = 'data:image/png;base64,fixture';
    vi.mocked(api).mockResolvedValue({
      textures: { 'solcarrot:food_book': png, 'minecraft:stone': 'https://untrusted.example/icon' },
    });
    const signal = new AbortController().signal;
    expect(await fetchInventoryTextures('server-id', ids, signal)).toEqual({
      'solcarrot:food_book': png,
    });
    expect(api).toHaveBeenCalledOnce();
    expect(api).toHaveBeenCalledWith(
      '/v1/servers/server-id/minecraft/item-textures?ids=minecraft%3Astone%2Csolcarrot%3Afood_book',
      { signal },
    );
    vi.mocked(api).mockClear();
    await fetchInventoryTextures(
      'other-server',
      Array.from({ length: 65 }, (_, i) => `mod:item_${i}`),
      signal,
    );
    expect(api).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(api).mock.calls.every(([path]) => path.startsWith('/v1/servers/other-server/')),
    ).toBe(true);
  });

  it('extracts only bitmap font fill, excluding the XP outline and preserving pixel positions', () => {
    const pixels = new Uint8ClampedArray(7 * 9 * 4);
    pixels.set([0, 0, 0, 255], 0); // Existing XP outline must not become white.
    pixels.set([128, 255, 32, 255], (1 * 7 + 1) * 4);
    pixels.set([128, 255, 32, 255], (7 * 7 + 5) * 4);
    const mask = stackGlyphFromXp(pixels);
    expect(mask).toHaveLength(35);
    expect(mask[0]).toBe(255);
    expect(mask[34]).toBe(255);
    expect(mask.filter(Boolean)).toHaveLength(2);
  });
});
