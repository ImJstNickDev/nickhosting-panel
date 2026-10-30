import type { Database } from '@nickhosting/database';
import {
  type ForgeCatalogResponse,
  type ForgeCatalogSnapshot,
  fetchForgeCatalog,
  forgeCatalogSnapshotSchema,
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
  const parsed = forgeCatalogSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Local-only; provider metadata is kept private for exact-loader provisioning. */
export async function getForgeCatalog(db: DB, now = new Date()): Promise<ForgeCatalogResponse> {
  const row = await readProviderCatalog(db, 'forge');
  const snapshot = row?.last_success_at ? parseSnapshot(row.manifest_json) : undefined;
  return {
    versions: snapshot?.versions ?? [],
    synced: Boolean(snapshot),
    status: providerCatalogStatus(row, Boolean(snapshot), now),
  };
}

/** Reuses the same last-good snapshot as discovery; never performs foreground provider requests. */
export async function getForgeCatalogSnapshot(db: DB): Promise<ForgeCatalogSnapshot | null> {
  const row = await readProviderCatalog(db, 'forge');
  return (row?.last_success_at ? parseSnapshot(row.manifest_json) : undefined) ?? null;
}

export async function requestForgeCatalogRefresh(db: DB, now = new Date()) {
  await requestProviderCatalogRefresh(db, 'forge', now);
  return getForgeCatalog(db, now);
}

export function refreshForgeCatalog(db: DB, options: ProviderCatalogRefreshOptions) {
  return refreshProviderCatalog(
    db,
    'forge',
    {
      parse: parseSnapshot,
      fetch: fetchForgeCatalog,
      count: (snapshot) => snapshot.versions.length,
    },
    options,
  );
}
