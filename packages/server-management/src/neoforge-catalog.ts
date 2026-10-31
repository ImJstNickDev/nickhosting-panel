import type { Database } from '@nickhosting/database';
import {
  fetchNeoForgeCatalog,
  type NeoForgeCatalogResponse,
  type NeoForgeCatalogSnapshot,
  neoforgeCatalogSnapshotSchema,
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
  const parsed = neoforgeCatalogSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Local-only; provider metadata is kept private for exact-loader provisioning. */
export async function getNeoForgeCatalog(
  db: DB,
  now = new Date(),
): Promise<NeoForgeCatalogResponse> {
  const row = await readProviderCatalog(db, 'neoforge');
  const snapshot = row?.last_success_at ? parseSnapshot(row.manifest_json) : undefined;
  return {
    versions: snapshot?.versions ?? [],
    synced: Boolean(snapshot),
    status: providerCatalogStatus(row, Boolean(snapshot), now),
  };
}

/** Reuses the same last-good snapshot as discovery; never performs foreground provider requests. */
export async function getNeoForgeCatalogSnapshot(db: DB): Promise<NeoForgeCatalogSnapshot | null> {
  const row = await readProviderCatalog(db, 'neoforge');
  return (row?.last_success_at ? parseSnapshot(row.manifest_json) : undefined) ?? null;
}

export async function requestNeoForgeCatalogRefresh(db: DB, now = new Date()) {
  await requestProviderCatalogRefresh(db, 'neoforge', now);
  return getNeoForgeCatalog(db, now);
}

export function refreshNeoForgeCatalog(db: DB, options: ProviderCatalogRefreshOptions) {
  return refreshProviderCatalog(
    db,
    'neoforge',
    {
      parse: parseSnapshot,
      fetch: fetchNeoForgeCatalog,
      count: (snapshot) => snapshot.versions.length,
    },
    options,
  );
}
