import type { Database } from '@nickhosting/database';
import {
  fetchPaperCatalog,
  type PaperCatalogResponse,
  type PaperCatalogSnapshot,
  paperCatalogSnapshotSchema,
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
  const parsed = paperCatalogSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Local-only; download metadata is kept private for exact-build provisioning. */
export async function getPaperCatalog(db: DB, now = new Date()): Promise<PaperCatalogResponse> {
  const row = await readProviderCatalog(db, 'paper');
  const snapshot = row?.last_success_at ? parseSnapshot(row.manifest_json) : undefined;
  return {
    versions: snapshot?.versions ?? [],
    synced: Boolean(snapshot),
    status: providerCatalogStatus(row, Boolean(snapshot), now),
  };
}

/** Reuses the same last-good snapshot as discovery; never performs foreground provider requests. */
export async function getPaperCatalogSnapshot(db: DB): Promise<PaperCatalogSnapshot | null> {
  const row = await readProviderCatalog(db, 'paper');
  return (row?.last_success_at ? parseSnapshot(row.manifest_json) : undefined) ?? null;
}

export async function requestPaperCatalogRefresh(db: DB, now = new Date()) {
  await requestProviderCatalogRefresh(db, 'paper', now);
  return getPaperCatalog(db, now);
}

export function refreshPaperCatalog(db: DB, options: ProviderCatalogRefreshOptions) {
  return refreshProviderCatalog(
    db,
    'paper',
    {
      parse: parseSnapshot,
      fetch: fetchPaperCatalog,
      count: (snapshot) => snapshot.versions.length,
    },
    options,
  );
}
