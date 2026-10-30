import { describe, expect, it } from 'vitest';
import { PendingCatalogSearch } from './minecraft-admin-navigation.js';

describe('Minecraft catalog field navigation', () => {
  it('preserves later filters when an earlier replacement commits before sorting', () => {
    const navigation = new PendingCatalogSearch('initial', 'runtime=vanilla');
    const search = navigation.patch({ catalogSearch: '26' }, true).toString();
    navigation.patch({ 'catalog-releaseType': 'release' }, true);
    navigation.reconcile('search-committed', search, 'REPLACE');
    const result = navigation.patch({ catalogOrder: 'oldest' }, true);
    expect(Object.fromEntries(result)).toEqual({
      runtime: 'vanilla',
      catalogPage: '1',
      catalogSearch: '26',
      'catalog-releaseType': 'release',
      catalogOrder: 'oldest',
    });
  });

  it('keeps search and type cleared through intermediate commits', () => {
    const navigation = new PendingCatalogSearch(
      'initial',
      'catalogSearch=26&catalog-releaseType=release',
    );
    const clearedSearch = navigation.patch({ catalogSearch: '' }, true).toString();
    navigation.patch({ 'catalog-releaseType': '' }, true);
    navigation.reconcile('cleared-search', clearedSearch, 'REPLACE');
    const final = navigation.patch({ catalogOrder: 'oldest' }, true);
    expect(final.has('catalogSearch')).toBe(false);
    expect(final.has('catalog-releaseType')).toBe(false);
    navigation.reconcile('final', final.toString(), 'REPLACE');
    expect(navigation.current().toString()).toBe(final.toString());
  });

  it('accepts Back navigation even when its URL matches a pending replacement', () => {
    const navigation = new PendingCatalogSearch('initial', 'runtime=vanilla');
    const previous = navigation.patch({ catalogSearch: '26' }, true).toString();
    navigation.patch({ catalogSearch: '26.2' }, true);
    navigation.reconcile('back', previous, 'POP');
    expect(navigation.current().get('catalogSearch')).toBe('26');
    expect(navigation.patch({ catalogOrder: 'oldest' }, true).get('catalogSearch')).toBe('26');
  });

  it('accepts unrelated links and replacements, and resets page/detail for filters', () => {
    const navigation = new PendingCatalogSearch('initial', 'runtime=vanilla');
    navigation.patch({ catalogSearch: '26' }, true);
    navigation.reconcile('link', 'runtime=paper&catalogPage=3&combination=selected', 'PUSH');
    const result = navigation.patch({ 'catalog-availability': 'disabled' }, true);
    expect(result.get('runtime')).toBe('paper');
    expect(result.get('catalogPage')).toBe('1');
    expect(result.has('combination')).toBe(false);
    navigation.reconcile('external-replace', 'runtime=fabric', 'REPLACE');
    expect(navigation.current().toString()).toBe('runtime=fabric');
  });
});
