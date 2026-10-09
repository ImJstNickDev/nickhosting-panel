import type { Database } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';

/** Caller holds the shared resource lock. Until filesystem identities are proven
 * independently, charge every unresolved claim, even across configured roots or
 * hosts. This may over-reserve; it must never assume two paths are separate disks. */
export async function unresolvedTransferBytes(db: Kysely<Database>): Promise<bigint> {
  const result = await sql<{ bytes: string }>`
    select coalesce(sum(bytes), 0)::text as bytes from (
      select reserved_bytes as bytes from upload_ingestion_claims
      union all select reserved_bytes from minecraft_sources where state <> 'released'
      union all select reserved_bytes from minecraft_staging_claims where state = 'reserved'
    ) claims
  `.execute(db);
  return BigInt(result.rows[0]?.bytes ?? '0');
}
