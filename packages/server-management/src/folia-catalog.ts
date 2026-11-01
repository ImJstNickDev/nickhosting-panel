import type { Database } from '@nickhosting/database';
import {
  type FoliaCatalogResponse,
  type FoliaCatalogSnapshot,
  fetchFoliaCatalog,
  foliaCatalogSnapshotSchema,
} from '@nickhosting/minecraft';
import type { Kysely } from 'kysely';
import {
  type ProviderCatalogRefreshOptions,
  providerCatalogStatus,
  readProviderCatalog,
  refreshProviderCatalog,
  requestProviderCatalogRefresh,
} from './provider-catalog.js';

type DB = Kysely<Database>;
function parseSnapshot(value: unknown) {
  const parsed = foliaCatalogSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Local-only; download metadata is kept private for exact-build provisioning. */
export async function getFoliaCatalog(db: DB, now = new Date()): Promise<FoliaCatalogResponse> {
  const row = await readProviderCatalog(db, 'folia');
  const snapshot = row?.last_success_at ? parseSnapshot(row.manifest_json) : undefined;
  return {
    versions: snapshot?.versions ?? [],
    synced: Boolean(snapshot),
    status: providerCatalogStatus(row, Boolean(snapshot), now),
  };
}

/** Reuses the same last-good snapshot as discovery; never performs foreground provider requests. */
export async function getFoliaCatalogSnapshot(db: DB): Promise<FoliaCatalogSnapshot | null> {
  const row = await readProviderCatalog(db, 'folia');
  return (row?.last_success_at ? parseSnapshot(row.manifest_json) : undefined) ?? null;
}

export async function requestFoliaCatalogRefresh(db: DB, now = new Date()) {
  await requestProviderCatalogRefresh(db, 'folia', now);
  return getFoliaCatalog(db, now);
}

export function refreshFoliaCatalog(db: DB, options: ProviderCatalogRefreshOptions) {
  return refreshProviderCatalog(
    db,
    'folia',
    {
      parse: parseSnapshot,
      fetch: fetchFoliaCatalog,
      count: (snapshot) => snapshot.versions.length,
    },
    options,
  );
}
