import { z } from 'zod';

const batchSchema = z.object({
  items: z
    .array(
      z.object({
        version: z.string(),
        releaseType: z.string(),
        id: z.string().optional(),
        status: z.string(),
        reason: z.string().optional(),
      }),
    )
    .max(20),
  nextCursor: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative().max(20_000),
});
export type CatalogBatch = z.infer<typeof batchSchema>;

/** Sequential, bounded discovery. Publish only completed pages so retries resume
 * from the last acknowledged cursor. An interrupted page may be safely replayed
 * by the server's idempotent combination registration. */
export async function syncCatalogPages(options: {
  signal: AbortSignal;
  previous?: CatalogBatch;
  request: (cursor: number, signal: AbortSignal) => Promise<unknown>;
  progress: (result: CatalogBatch) => void;
}): Promise<CatalogBatch> {
  let result = options.previous?.nextCursor != null ? options.previous : undefined;
  let cursor = result?.nextCursor ?? 0;
  for (let page = 0; page < 1000; page++) {
    options.signal.throwIfAborted();
    const batch = batchSchema.parse(await options.request(cursor, options.signal));
    options.signal.throwIfAborted();
    if (
      batch.nextCursor !== null &&
      (batch.nextCursor <= cursor || batch.nextCursor > batch.total)
    ) {
      throw new Error('invalid_catalog_cursor');
    }
    const items = new Map(result?.items.map((item) => [item.version, item]));
    for (const item of batch.items) items.set(item.version, item);
    result = { ...batch, items: [...items.values()] };
    options.progress(result);
    if (batch.nextCursor === null) return result;
    cursor = batch.nextCursor;
  }
  throw new Error('catalog_page_limit');
}
