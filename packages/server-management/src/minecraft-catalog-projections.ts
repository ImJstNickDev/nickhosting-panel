import type { ContentTarget } from '@nickhosting/content-providers';
import type { Database } from '@nickhosting/database';
import {
  fabricCatalogSnapshotSchema,
  foliaCatalogSnapshotSchema,
  forgeCatalogSnapshotSchema,
  neoforgeCatalogSnapshotSchema,
  paperCatalogSnapshotSchema,
  purpurCatalogSnapshotSchema,
  quiltCatalogSnapshotSchema,
} from '@nickhosting/minecraft';
import { type Kysely, sql } from 'kysely';

type DB = Kysely<Database>;
type Runtime = Exclude<Database['minecraft_metadata_sync']['id'], 'mojang'>;
type LoaderRuntime = Extract<Runtime, 'fabric' | 'quilt' | 'forge' | 'neoforge'>;
type Game = Readonly<{ version: string; stable?: boolean }>;
interface CatalogProjection {
  games: readonly Game[];
  globalLoaders?: readonly string[];
  releaseLoaders?: ReadonlyMap<string, readonly string[]>;
}
const none: readonly never[] = Object.freeze([]);
const empty: CatalogProjection = { games: none };
function immutableGames(games: Game[]): readonly Game[] {
  for (const game of games) Object.freeze(game);
  return Object.freeze(games);
}
const caches = new WeakMap<DB, Map<Runtime, { revision: string; projection: CatalogProjection }>>();

// Keep the same complete document validation as the provider catalog, including
// source evidence, derivation and ordering. Only the small UI fields survive.
function project(runtime: Runtime, value: unknown): CatalogProjection {
  if (runtime === 'fabric' || runtime === 'quilt') {
    const snapshot = (
      runtime === 'fabric' ? fabricCatalogSnapshotSchema : quiltCatalogSnapshotSchema
    ).safeParse(value);
    if (!snapshot.success) return empty;
    const { games, loaders, installers } = snapshot.data;
    return {
      games: installers[0]?.version && loaders.length ? immutableGames(games) : none,
      globalLoaders: Object.freeze(loaders.map((loader) => loader.version)),
    };
  }
  if (runtime === 'forge' || runtime === 'neoforge') {
    const snapshot = (
      runtime === 'forge' ? forgeCatalogSnapshotSchema : neoforgeCatalogSnapshotSchema
    ).safeParse(value);
    if (!snapshot.success) return empty;
    const games: Game[] = [];
    const releaseLoaders = new Map<string, readonly string[]>();
    for (const game of snapshot.data.versions) {
      games.push({ version: game.minecraftVersion, stable: true });
      releaseLoaders.set(
        game.minecraftVersion,
        Object.freeze(game.loaders.map((loader) => loader.version)),
      );
    }
    return { games: immutableGames(games), releaseLoaders };
  }
  const schema =
    runtime === 'paper'
      ? paperCatalogSnapshotSchema
      : runtime === 'folia'
        ? foliaCatalogSnapshotSchema
        : purpurCatalogSnapshotSchema;
  const snapshot = schema.safeParse(value);
  return snapshot.success
    ? { games: immutableGames(snapshot.data.versions.map(({ version }) => ({ version }))) }
    : empty;
}
async function readProjection(db: DB, runtime: Runtime) {
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  const previous = cache.get(runtime);
  // A SQL snapshot decides whether the full JSONB must cross the wire. xmin
  // and ctid also change when an older writer updates the document without its
  // hash, including two updates inside one transaction.
  const revision = sql<string>`tableoid::text || ':' || xmin::text || ':' || ctid::text`;
  const row = await db
    .selectFrom('minecraft_metadata_sync')
    .select([
      revision.as('revision'),
      sql<unknown>`case when ${revision} is distinct from ${previous?.revision ?? null} then manifest_json end`.as(
        'document',
      ),
    ])
    .where('id', '=', runtime)
    .where('last_success_at', 'is not', null)
    .executeTakeFirst();
  if (!row) {
    cache.delete(runtime);
    return empty;
  }
  if (previous?.revision === row.revision) return previous.projection;
  const existing = cache.get(runtime);
  if (existing?.revision === row.revision) return existing.projection;
  const projection = project(runtime, row.document);
  if (existing === previous) cache.set(runtime, { revision: row.revision, projection });
  return projection;
}

export async function minecraftCatalogGames(db: DB, runtime: Runtime, target?: ContentTarget) {
  const projection = await readProjection(db, runtime);
  if (!target) return projection.games;
  if (
    runtime === 'forge' ||
    runtime === 'neoforge' ||
    runtime === 'fabric' ||
    runtime === 'quilt'
  ) {
    const loaders =
      projection.globalLoaders ?? projection.releaseLoaders?.get(target.minecraftVersion);
    if (!target.loaderVersion || !loaders?.includes(target.loaderVersion)) return none;
  } else if (target.loaderVersion) return none;
  return Object.freeze(projection.games.filter((game) => game.version === target.minecraftVersion));
}

export async function minecraftCatalogLoaders(db: DB, runtime: LoaderRuntime, version: string) {
  const projection = await readProjection(db, runtime);
  return projection.globalLoaders ?? projection.releaseLoaders?.get(version) ?? none;
}
