import { describe, expect, it } from 'vitest';
import { defaultMinecraftProtocolSource } from './releases.js';
import catalog from './world-data-versions.json' with { type: 'json' };
import { minecraftWorldDataVersion } from './world-version.js';

describe('bundled Minecraft world-format metadata', () => {
  it.each([
    ['15w32a', 100],
    ['1.9', 169],
    ['1.16.5', 2586],
    ['1.20.4', 3700],
    ['26.1', 4786],
    ['26.1.1', 4788],
    ['26.2', 4903],
    ['26.3', 5023],
    ['26.4-snapshot-2', 5120],
  ])('resolves exact release %s independently of server evidence', (release, expected) => {
    expect(minecraftWorldDataVersion(release)).toBe(expected);
  });

  it.each(['1.5.2', '1.8.9', '15w31c', '26.999', '26.1-custom', 'toString', '__proto__'])(
    'does not invent world-format compatibility for %s',
    (release) => {
      expect(minecraftWorldDataVersion(release)).toBeUndefined();
    },
  );

  it('retains reviewed provenance and only native DataVersion entries', () => {
    expect(catalog.source.url).toContain(defaultMinecraftProtocolSource.commit);
    expect(catalog.source.sha256).toBe(defaultMinecraftProtocolSource.sha256);
    for (const value of Object.values(catalog.versions)) {
      expect(Number.isSafeInteger(value) && value >= 100 && value <= 2147483647).toBe(true);
    }
  });
});
