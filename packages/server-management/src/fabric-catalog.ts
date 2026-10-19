import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@nickhosting/database';
import {
  createRuntimeMetadataClient,
  type FabricCatalogResponse,
  fabricCatalogSnapshotSchema,
  fetchFabricCatalog,
  type RuntimeMetadataClient,
} from '@nickhosting/minecraft';
import type { Kysely } from 'kysely';
import { minecraftMetadataRefreshMs } from './minecraft-metadata.js';

type DB = Kysely<Database>;
const leaseMs = 60_000;
/** Local-only, including a truthful empty response before the first successful sync. */
export async function getFabricCatalog(db: DB, now = new Date()): Promise<FabricCatalogResponse> {
  const row = await db
    .selectFrom('minecraft_metadata_sync')
    .selectAll()
    .where('id', '=', 'fabric')
    .executeTakeFirst();
  const parsed = fabricCatalogSnapshotSchema.safeParse(row?.manifest_json);
  const snapshot = parsed.success && row?.last_success_at ? parsed.data : undefined;
  return {
    ...(snapshot ?? { games: [], loaders: [], installers: [] }),
    latestInstallerVersion: snapshot?.installers[0]?.version ?? null,
    synced: Boolean(snapshot),
    status: {
      lastCheckedAt: row?.last_checked_at?.toISOString() ?? null,
      lastSuccessAt: row?.last_success_at?.toISOString() ?? null,
      nextCheckAt: row?.next_check_at?.toISOString() ?? null,
      lastError: row?.last_error ?? null,
      stale:
        !snapshot ||
        !row?.last_success_at ||
        now.getTime() - row.last_success_at.getTime() >= minecraftMetadataRefreshMs,
    },
  };
}
/** Shared by scheduled and Owner refresh. A due-time plus durable lease bounds
 * repeat clicks across processes; all three lists commit atomically, last-good survives. */
export async function refreshFabricCatalog(
  db: DB,
  options: {
    client?: RuntimeMetadataClient;
    userAgent?: string;
    now?: () => Date;
  },
) {
  const now = options.now ?? (() => new Date());
  const started = now();
  const leaseId = randomUUID();
  // Migration seeds this row. Missing row means not deployed yet, safely skip.
  const claim = await db
    .updateTable('minecraft_metadata_sync')
    .set({ lease_id: leaseId, lease_until: new Date(started.getTime() + leaseMs) })
    .where('id', '=', 'fabric')
    .where('next_check_at', '<=', started)
    .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', started)]))
    .returning('manifest_hash')
    .executeTakeFirst();
  if (!claim) return { state: 'skipped' as const, changed: 0 };
  try {
    const snapshot = await fetchFabricCatalog(
      options.client ??
        createRuntimeMetadataClient({ userAgent: options.userAgent ?? '', timeoutMs: 10_000 }),
    );
    const document = JSON.stringify(snapshot);
    const hash = createHash('sha256').update(document).digest('hex');
    const finished = now();
    const changed = claim.manifest_hash !== hash;
    const committed = await db
      .updateTable('minecraft_metadata_sync')
      .set({
        ...(changed ? { manifest_json: document, manifest_hash: hash } : {}),
        last_checked_at: finished,
        last_success_at: finished,
        next_check_at: new Date(finished.getTime() + minecraftMetadataRefreshMs),
        last_error: null,
        lease_id: null,
        lease_until: null,
      })
      .where('id', '=', 'fabric')
      .where('lease_id', '=', leaseId)
      .where('lease_until', '>', finished)
      .returning('id')
      .executeTakeFirst();
    if (!committed) return { state: 'skipped' as const, changed: 0 };
    return {
      state: changed ? ('updated' as const) : ('unchanged' as const),
      changed: changed
        ? snapshot.games.length + snapshot.loaders.length + snapshot.installers.length
        : 0,
    };
  } catch {
    const finished = now();
    await db
      .updateTable('minecraft_metadata_sync')
      .set({
        last_checked_at: finished,
        next_check_at: new Date(finished.getTime() + 60_000),
        last_error: 'fabric_metadata_refresh_failed',
        lease_id: null,
        lease_until: null,
      })
      .where('id', '=', 'fabric')
      .where('lease_id', '=', leaseId)
      .execute();
    return { state: 'failed' as const, changed: 0 };
  }
}
