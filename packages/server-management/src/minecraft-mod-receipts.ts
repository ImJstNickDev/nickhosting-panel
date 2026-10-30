import type { Database } from '@nickhosting/database';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { minecraftModSchemaAvailable } from './minecraft-mod-schema.js';

const receipt = z.object({
  size: z.number(),
  sha256: z.string(),
  metadata: z
    .object({ provider: z.string(), projectId: z.string(), versionId: z.string() })
    .nullable(),
  aliases: z
    .array(z.object({ provider: z.string(), projectId: z.string(), versionId: z.string() }))
    .default([]),
  conflicts: z
    .array(
      z.object({ provider: z.string(), projectId: z.string(), versionId: z.string().optional() }),
    )
    .default([]),
});
/** Local catalog provenance only. Callers corroborate the actual path/bytes with their shared Fileman scope. */
export async function minecraftModContentReceipts(
  db: Kysely<Database>,
  serverId: string,
  schemaExecutor: Kysely<Database> = db,
) {
  const [legacy, modern] = await Promise.all([
    db
      .selectFrom('minecraft_content_items')
      .select(['path', 'artifact'])
      .where('server_id', '=', serverId)
      .execute(),
    minecraftModSchemaAvailable(schemaExecutor).then((ready) =>
      ready
        ? db
            .selectFrom('minecraft_mod_receipts')
            .selectAll()
            .where('server_id', '=', serverId)
            .execute()
        : [],
    ),
  ]);
  const current = modern.flatMap((row) => {
    const parsed = receipt.safeParse(row.receipt);
    if (!parsed.success || !parsed.data.metadata) return [];
    const value = parsed.data;
    return [value.metadata, ...value.aliases].map((identity) => ({
      path: row.path,
      artifact: {
        ...identity,
        size: value.size,
        sha256: value.sha256,
        incompatible: value.conflicts,
      },
    }));
  });
  const paths = new Set(current.map((row) => row.path));
  return [...legacy.filter((row) => !paths.has(row.path)), ...current];
}
