import { describe, expect, it } from 'vitest';
import { matchesMinecraftMod, matchesMinecraftPlugin, minecraftViewers } from './index.js';

const source = (path: string) => ({
  path,
  name: path.split('/').at(-1) ?? path,
  size: 100,
  gameId: 'minecraft',
});

describe('Minecraft JAR viewer suggestions', () => {
  it('suggests Plugscope only inside the plugin directory, including disabled and pending files', () => {
    for (const path of [
      'plugins/example.jar',
      '/plugins/example.jar.disabled',
      'plugins/update/example.jar.pending',
    ]) {
      expect(matchesMinecraftPlugin(source(path))).toBe(true);
      expect(matchesMinecraftMod(source(path))).toBe(false);
    }
    for (const path of [
      'mods/example.jar',
      'server.jar',
      'plugins/example.yml',
      'old-plugins/example.jar',
      'plugins/cache.jar.zip',
    ])
      expect(matchesMinecraftPlugin(source(path))).toBe(false);
    expect(matchesMinecraftPlugin({ ...source('plugins/example.jar'), gameId: 'other-game' })).toBe(
      false,
    );
  });

  it('preserves Modscope suggestions and leaves nested JAR selection to Open With', () => {
    expect(matchesMinecraftMod(source('mods/example.jar.disabled'))).toBe(true);
    for (const extra of [{ entry: 'inner.jar' }, { archives: ['inner.zip'] }]) {
      expect(matchesMinecraftMod({ ...source('mods/example.jar'), ...extra })).toBe(false);
      expect(matchesMinecraftPlugin({ ...source('plugins/example.jar'), ...extra })).toBe(false);
    }
  });

  it('registers both read-only viewers in the integration with separate lazy entry points', () => {
    const descriptors = minecraftViewers.map((viewer) => viewer.descriptor);
    expect(descriptors.map((viewer) => viewer.id)).toEqual([
      'minecraft:modscope',
      'minecraft:plugscope',
    ]);
    for (const viewer of descriptors) {
      expect(viewer.gameId).toBe('minecraft');
      expect(viewer.readOnly).toBe(true);
      expect(viewer.extensions).toEqual(['jar', 'jar.disabled', 'jar.pending']);
    }
  });
});
