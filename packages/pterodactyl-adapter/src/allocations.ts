import { z } from 'zod';
import { numericId, PterodactylError, type Transport } from './transport.js';
import { allocationSchema } from './types.js';

/** Complete node inventory; never combine unordered OFFSET pages for collision checks. */
export async function allocationInventory(transport: Transport, nodeId: number) {
  // Panel 1.x does not order its allocation query or support sort=id here. Different
  // OFFSET query plans can omit rows while duplicating others, even with no writes.
  // One bounded response avoids that ambiguity. Larger/truncated inventories fail
  // closed instead of silently allowing a listener to collide with a missing row.
  const limit = 10000;
  const result = await transport.json(
    'application',
    `nodes/${numericId(nodeId)}/allocations?per_page=${limit}&page=1`,
    z.object({
      object: z.literal('list'),
      data: z.array(z.object({ attributes: allocationSchema })).max(limit),
      meta: z.object({
        pagination: z.object({
          total: z.number().int().nonnegative().max(limit),
          count: z.number().int().nonnegative().max(limit),
          per_page: z.number().int().positive(),
          current_page: z.literal(1),
          total_pages: z.number().int().min(0).max(1),
        }),
      }),
    }),
  );
  const rows = result.data.map(({ attributes }) => attributes);
  const page = result.meta.pagination;
  if (
    page.total !== rows.length ||
    page.count !== rows.length ||
    page.per_page < rows.length ||
    (rows.length > 0 && page.total_pages !== 1) ||
    new Set(rows.map(({ id }) => id)).size !== rows.length
  ) {
    throw new PterodactylError('invalid_response', 'application', 'rejected');
  }
  return rows;
}
