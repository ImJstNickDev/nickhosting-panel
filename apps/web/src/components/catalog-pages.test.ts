import { expect, it } from 'vitest';
import { loadCatalogPages } from './catalog-pages.js';

it('loads more than the legacy 1000 items through bounded pages', async () => {
  const records = Array.from({ length: 1001 }, (_, i) => ({ id: String(i) }));
  const result = await loadCatalogPages(async (after) => {
    const from = after ? Number(after) + 1 : 0;
    const items = records.slice(from, from + 100);
    return { items, nextCursor: from + 100 < records.length ? (items.at(-1)?.id ?? null) : null };
  });
  expect(result).toEqual(records);
});
it('rejects repeated cursors instead of silently returning incomplete results', async () => {
  await expect(
    loadCatalogPages(async () => ({ items: [{ id: 'a' }], nextCursor: 'a' })),
  ).rejects.toThrow('invalid_catalog_cursor');
});
