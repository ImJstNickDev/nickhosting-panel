import type { DatagridPage } from '@nickhosting/game-sdk/ui';
import { describe, expect, it } from 'vitest';
import { DatagridPageCache } from './sqlite-model.js';

const page = (revision = 'first', text = ''): DatagridPage => ({
  tables: ['data'],
  revision,
  consistency: 'unverified',
  table: 'data',
  rows: [[{ type: 'text', value: text, truncated: false }]],
});

describe('Datagrid private page cache', () => {
  it('never mixes source revisions, including after explicit refresh', () => {
    const cache = new DatagridPageCache();
    expect(cache.put('0', page())).toBe(true);
    expect(cache.put('100', page('new'))).toBe(false);
    expect(cache.get('100')).toBeUndefined();
    expect(cache.get('0')?.revision).toBe('first');
    cache.clear();
    expect(cache.get('0')).toBeUndefined();
    expect(cache.put('0', page('new'))).toBe(true);
  });
  it('retains recently visited pages and evicts old pages at the count budget', () => {
    const cache = new DatagridPageCache();
    for (let n = 0; n < 8; n++) cache.put(String(n), page());
    cache.get('0');
    cache.put('8', page());
    expect(cache.get('0')).toBeDefined();
    expect(cache.get('1')).toBeUndefined();
    expect(cache.get('8')).toBeDefined();
  });
  it('caps retained text memory and does not cache an oversized response', () => {
    const cache = new DatagridPageCache();
    cache.put('a', page('first', 'a'.repeat(800_000)));
    cache.put('b', page('first', 'b'.repeat(800_000)));
    cache.put('c', page('first', 'c'.repeat(800_000)));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
    cache.put('oversized', page('first', 'x'.repeat(3_000_000)));
    expect(cache.get('oversized')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });
});
