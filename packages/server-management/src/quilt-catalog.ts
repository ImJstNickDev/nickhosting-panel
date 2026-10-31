import type { Database } from '@nickhosting/database';
import {
  fetchQuiltCatalog,
  type QuiltCatalogResponse,
  quiltCatalogSnapshotSchema,
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
/** Local-only, including a truthful empty response before the first successful sync. */
export async function getQuiltCatalog(db: DB, now = new Date()): Promise<QuiltCatalogResponse> {
  const row = await readProviderCatalog(db, 'quilt');
  const parsed = quiltCatalogSnapshotSchema.safeParse(row?.manifest_json);
  const snapshot = parsed.success && row?.last_success_at ? parsed.data : undefined;
  return {
    games: snapshot?.games ?? [],
    loaders: snapshot?.loaders ?? [],
    installers: snapshot?.installers ?? [],
    latestInstallerVersion: snapshot?.installers[0]?.version ?? null,
    synced: Boolean(snapshot),
    status: providerCatalogStatus(row, Boolean(snapshot), now),
  };
}
export async function requestQuiltCatalogRefresh(db: DB, now = new Date()) {
  await requestProviderCatalogRefresh(db, 'quilt', now);
  return getQuiltCatalog(db, now);
}
/** Worker-only. Requests survive process loss; only a live lease holder can publish or clear them. */
export function refreshQuiltCatalog(db: DB, options: ProviderCatalogRefreshOptions) {
  return refreshProviderCatalog(
    db,
    'quilt',
    {
      parse(input) {
        const parsed = quiltCatalogSnapshotSchema.safeParse(input);
        return parsed.success ? parsed.data : undefined;
      },
      fetch: fetchQuiltCatalog,
      count: (snapshot) =>
        snapshot.games.length + snapshot.loaders.length + snapshot.installers.length,
    },
    options,
  );
}

export async function getQuiltCatalogSnapshot(db: DB) {
  const row = await readProviderCatalog(db, 'quilt');
  const parsed = quiltCatalogSnapshotSchema.safeParse(row?.manifest_json);
  return parsed.success && row?.last_success_at ? parsed.data : null;
}
