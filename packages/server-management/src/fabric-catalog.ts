import type { Database } from '@nickhosting/database';
import {
  type FabricCatalogResponse,
  fabricCatalogSnapshotSchema,
  fetchFabricCatalog,
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
export async function getFabricCatalog(db: DB, now = new Date()): Promise<FabricCatalogResponse> {
  const row = await readProviderCatalog(db, 'fabric');
  const parsed = fabricCatalogSnapshotSchema.safeParse(row?.manifest_json);
  const snapshot = parsed.success && row?.last_success_at ? parsed.data : undefined;
  return {
    ...(snapshot ?? { games: [], loaders: [], installers: [] }),
    latestInstallerVersion: snapshot?.installers[0]?.version ?? null,
    synced: Boolean(snapshot),
    status: providerCatalogStatus(row, Boolean(snapshot), now),
  };
}
export async function requestFabricCatalogRefresh(db: DB, now = new Date()) {
  await requestProviderCatalogRefresh(db, 'fabric', now);
  return getFabricCatalog(db, now);
}
/** Worker-only. Requests survive process loss; only a live lease holder can publish or clear them. */
export function refreshFabricCatalog(db: DB, options: ProviderCatalogRefreshOptions) {
  return refreshProviderCatalog(
    db,
    'fabric',
    {
      parse(input) {
        const parsed = fabricCatalogSnapshotSchema.safeParse(input);
        return parsed.success ? parsed.data : undefined;
      },
      fetch: fetchFabricCatalog,
      count: (snapshot) =>
        snapshot.games.length + snapshot.loaders.length + snapshot.installers.length,
    },
    options,
  );
}
