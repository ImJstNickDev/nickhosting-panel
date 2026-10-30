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
export interface CatalogMeasurement {
  completed: number;
  total: number;
  /** Unknown until at least two completed requests in this run. No countdown. */
  remainingSeconds: number | null;
}

/** Sequential, bounded discovery. Publish only completed pages so retries resume
 * from the last acknowledged cursor. An interrupted page may be safely replayed
 * by the server's idempotent combination registration. */
export async function syncCatalogPages(options: {
  signal: AbortSignal;
  previous?: CatalogBatch;
  request: (cursor: number, signal: AbortSignal) => Promise<unknown>;
  progress: (result: CatalogBatch, measurement: CatalogMeasurement) => void;
  now?: () => number;
}): Promise<CatalogBatch> {
  let result = options.previous?.nextCursor != null ? options.previous : undefined;
  let cursor = result?.nextCursor ?? 0;
  const now = options.now ?? (() => performance.now());
  const started = now();
  const initialCursor = cursor;
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
    const completed = batch.nextCursor ?? batch.total;
    const measured = completed - initialCursor;
    const elapsed = Math.max(0, now() - started);
    options.progress(result, {
      completed,
      total: batch.total,
      remainingSeconds:
        page >= 1 && measured > 0 && elapsed > 0 && batch.nextCursor !== null
          ? Math.ceil(((batch.total - completed) * elapsed) / measured / 1000)
          : null,
    });
    if (batch.nextCursor === null) return result;
    cursor = batch.nextCursor;
  }
  throw new Error('catalog_page_limit');
}
