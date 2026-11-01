import { describe, expect, it } from 'vitest';
import type { ModpackCatalogVersion } from '../../../../../packages/content-providers/src/modpack-catalog.js';
import { modpackIdentity, modpackQueryKey, recommendedPackVersion } from './modpacks-model.js';

const version = (
  id: string,
  channel: ModpackCatalogVersion['channel'],
  available = true,
  publishedAt?: string,
): ModpackCatalogVersion => ({
  id,
  projectId: 'pack',
  name: id,
  version: id,
  minecraftVersions: ['1.21.1'],
  loaders: ['fabric'],
  channel,
  available,
  source: 'modrinth-index',
  publishedAt,
});
describe('Modpack selection model', () => {
  it('prefers an available release over a newer beta', () => {
    expect(
      recommendedPackVersion([
        version('beta', 'beta', true, '2026-10-20T00:00:00Z'),
        version('stable', 'release', true, '2026-10-01T00:00:00Z'),
      ])?.id,
    ).toBe('stable');
  });
  it('selects newest available release and falls back to the catalog order', () => {
    expect(
      recommendedPackVersion([
        version('old', 'release', true, '2026-10-01T00:00:00Z'),
        version('new', 'release', true, '2026-10-20T00:00:00Z'),
      ])?.id,
    ).toBe('new');
    expect(
      recommendedPackVersion([version('first', 'release'), version('second', 'release')])?.id,
    ).toBe('first');
  });
  it('does not recommend blocked versions; permits beta-only catalogs', () => {
    expect(
      recommendedPackVersion([version('stable', 'release', false), version('beta', 'beta')])?.id,
    ).toBe('beta');
    expect(recommendedPackVersion([version('blocked', 'release', false)])).toBeUndefined();
  });
  it('isolates providers, servers and resource caches', () => {
    expect(modpackIdentity({ provider: 'ftb', id: '42' })).not.toBe(
      modpackIdentity({ provider: 'technic', id: '42' }),
    );
    expect(modpackQueryKey('a', 'search')).not.toEqual(modpackQueryKey('b', 'search'));
    expect(modpackQueryKey('a')).not.toEqual(modpackQueryKey('a', 'search'));
  });
});
