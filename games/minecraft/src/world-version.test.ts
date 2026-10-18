import { describe, expect, it } from 'vitest';
import { defaultMinecraftProtocolSource } from './releases.js';
import catalog from './world-data-versions.json' with { type: 'json' };
import {
  assessMinecraftWorldCompatibility,
  identifyMinecraftWorldRelease,
  minecraftWorldDataVersion,
} from './world-version.js';

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

describe('world identity and target compatibility', () => {
  it('identifies only a unique catalog value or a corroborated observed name', () => {
    expect(identifyMinecraftWorldRelease(4786)).toBe('26.1');
    expect(identifyMinecraftWorldRelease(4786, undefined, 'custom-series')).toBeUndefined();
    expect(identifyMinecraftWorldRelease(4786, undefined, 'main')).toBe('26.1');
    expect(identifyMinecraftWorldRelease(4786, '26.1', 'custom-series')).toBe('26.1');
    expect(identifyMinecraftWorldRelease(111)).toBeUndefined();
    expect(identifyMinecraftWorldRelease(111, '15w33a')).toBe('15w33a');
    expect(identifyMinecraftWorldRelease(111, '15w33b')).toBe('15w33b');
    expect(identifyMinecraftWorldRelease(4764, '26.1 Snapshot 1')).toBe('26.1-snapshot-1');
    expect(identifyMinecraftWorldRelease(4786, 'unrecognized writer')).toBeUndefined();
    expect(identifyMinecraftWorldRelease(4786, '26.2')).toBeUndefined();
    expect(identifyMinecraftWorldRelease(99999)).toBeUndefined();
    expect(identifyMinecraftWorldRelease()).toBeUndefined();
  });

  it('does not guess compatibility from shared DataVersion values or unfamiliar display names', () => {
    expect(
      assessMinecraftWorldCompatibility(
        { dataVersion: 111 },
        {
          release: '15w33a',
          expectedDataVersion: 111,
        },
      ),
    ).toBe('unknown');
    expect(
      assessMinecraftWorldCompatibility(
        { dataVersion: 111, versionName: '15w33b' },
        {
          release: '15w33a',
          expectedDataVersion: 111,
        },
      ),
    ).toBe('incompatible');
    expect(
      assessMinecraftWorldCompatibility(
        { dataVersion: 4786, versionName: 'Unknown custom name' },
        {
          release: '26.1',
          expectedDataVersion: 4786,
        },
      ),
    ).toBe('unknown');
    expect(
      assessMinecraftWorldCompatibility(
        { dataVersion: 4764, versionName: '26.1 Snapshot 1' },
        {
          release: '26.1-snapshot-1',
          expectedDataVersion: 4764,
        },
      ),
    ).toBe('verified');
  });

  it('reports known mismatches but does not assume experimental target lineage', () => {
    const observed = { dataVersion: 4786, versionName: '26.1', versionSeries: 'custom-series' };
    const target = { release: '26.1', expectedDataVersion: 4786 };
    expect(assessMinecraftWorldCompatibility(observed, target)).toBe('unknown');
    expect(assessMinecraftWorldCompatibility(observed, { ...target, expectedSeries: 'main' })).toBe(
      'incompatible',
    );
    expect(
      assessMinecraftWorldCompatibility(observed, { ...target, expectedSeries: 'custom-series' }),
    ).toBe('verified');
    expect(
      assessMinecraftWorldCompatibility(
        { dataVersion: 4786, versionName: '26.1' },
        { ...target, expectedSeries: 'custom-series' },
      ),
    ).toBe('unknown');
    expect(
      assessMinecraftWorldCompatibility({ dataVersion: 4903, versionName: '26.2' }, target),
    ).toBe('incompatible');
    expect(assessMinecraftWorldCompatibility({}, target)).toBe('unknown');
    expect(
      assessMinecraftWorldCompatibility(
        { dataVersion: 169, versionName: '1.9' },
        { release: 'future-unknown' },
      ),
    ).toBe('unknown');
  });
});
