import { describe, expect, it } from 'vitest';
import { compareCatalogItems } from './catalog-browser.js';

const entries = [
  { id: 'r', label: '26.1', releaseTime: '2026-03-01T00:00:00Z' },
  { id: 's', label: '26.2-snapshot-1', releaseTime: '2026-04-01T00:00:00Z' },
  { id: 'o', label: '1.21.11', releaseTime: '2025-12-01T00:00:00Z' },
  { id: 'u', label: '99.0', releaseTime: null },
];
describe('integration catalog ordering', () => {
  it('mixes snapshots and releases by actual date, with unknown dates last in either direction', () => {
    expect(
      [...entries].sort((a, b) => compareCatalogItems(a, b, 'newest')).map((x) => x.id),
    ).toEqual(['s', 'r', 'o', 'u']);
    expect(
      [...entries].sort((a, b) => compareCatalogItems(a, b, 'oldest')).map((x) => x.id),
    ).toEqual(['o', 'r', 's', 'u']);
  });
  it('supports natural version names independently of dates and deterministic ties', () => {
    expect(
      [...entries].sort((a, b) => compareCatalogItems(a, b, 'name-asc')).map((x) => x.id),
    ).toEqual(['o', 'r', 's', 'u']);
    expect(
      compareCatalogItems({ id: 'a', label: '1.9' }, { id: 'b', label: '1.10' }, 'name-asc'),
    ).toBeLessThan(0);
    expect(
      compareCatalogItems({ id: 'a', label: 'same' }, { id: 'b', label: 'same' }, 'newest'),
    ).toBeLessThan(0);
  });
});
