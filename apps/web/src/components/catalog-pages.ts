/** Consume bounded authenticated pages without silently truncating an integration catalog. */
export async function loadCatalogPages<T extends { id: string }>(
  read: (after: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  signal?: AbortSignal,
): Promise<T[]> {
  const items = new Map<string, T>();
  const cursors = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 200; page++) {
    signal?.throwIfAborted();
    const result = await read(after);
    signal?.throwIfAborted();
    for (const item of result.items) items.set(item.id, item);
    if (result.nextCursor === null) return [...items.values()];
    if (!result.items.length || cursors.has(result.nextCursor))
      throw new Error('invalid_catalog_cursor');
    cursors.add(result.nextCursor);
    after = result.nextCursor;
  }
  throw new Error('catalog_page_limit');
}
