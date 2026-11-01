import type { Database } from '@nickhosting/database';
import {
  fetchPurpurCatalog,
  type PurpurCatalogResponse,
  type PurpurCatalogSnapshot,
  purpurCatalogSnapshotSchema,
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
  const parsed = purpurCatalogSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Local-only; download metadata is kept private for exact-build provisioning. */
export async function getPurpurCatalog(db: DB, now = new Date()): Promise<PurpurCatalogResponse> {
  const row = await readProviderCatalog(db, 'purpur');
  const snapshot = row?.last_success_at ? parseSnapshot(row.manifest_json) : undefined;
  return {
    versions: snapshot?.versions ?? [],
    synced: Boolean(snapshot),
    status: providerCatalogStatus(row, Boolean(snapshot), now),
  };
}

/** Reuses the same last-good snapshot as discovery; never performs foreground provider requests. */
export async function getPurpurCatalogSnapshot(db: DB): Promise<PurpurCatalogSnapshot | null> {
  const row = await readProviderCatalog(db, 'purpur');
  return (row?.last_success_at ? parseSnapshot(row.manifest_json) : undefined) ?? null;
}

export async function requestPurpurCatalogRefresh(db: DB, now = new Date()) {
  await requestProviderCatalogRefresh(db, 'purpur', now);
  return getPurpurCatalog(db, now);
}

export function refreshPurpurCatalog(db: DB, options: ProviderCatalogRefreshOptions) {
  return refreshProviderCatalog(
    db,
    'purpur',
    {
      parse: parseSnapshot,
      fetch: fetchPurpurCatalog,
      count: (snapshot) => snapshot.versions.length,
    },
    options,
  );
}
