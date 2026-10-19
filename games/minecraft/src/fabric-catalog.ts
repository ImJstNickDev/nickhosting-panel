import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import type { RuntimeMetadataClient } from './runtime.js';

export const fabricCatalogUrls = {
  games: 'https://meta.fabricmc.net/v2/versions/game',
  loaders: 'https://meta.fabricmc.net/v2/versions/loader',
  installers: 'https://meta.fabricmc.net/v2/versions/installer',
} as const;
const entry = z.object({
  version: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/),
  stable: z.boolean(),
});
const gameEntry = entry.extend({
  // Fabric retains Mojang's historical display IDs, including spaces in pre-releases.
  version: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._+-]*$/),
});
const boundedEntries = (schema: typeof entry) =>
  z
    .array(schema)
    .min(1)
    .max(20_000)
    .refine((items) => new Set(items.map((item) => item.version)).size === items.length);
const entries = boundedEntries(entry);
const games = boundedEntries(gameEntry);
const maxGames = 2_000;
const maxSnapshotBytes = 8 * 1024 * 1024;
const maxRunBytes = 512 * 1024 * 1024;
const relationsSchema = z.object({
  checkedAt: z.iso.datetime(),
  loaderSets: z.array(z.array(entry.shape.version).max(20_000)).max(maxGames),
  gameLoaderSets: z.record(
    gameEntry.shape.version,
    z
      .number()
      .int()
      .min(0)
      .max(maxGames - 1),
  ),
});
export const fabricCatalogSnapshotSchema = z
  .object({
    games,
    loaders: entries,
    installers: entries,
    // Older cache documents remain readable, but do not assert any game/loader association.
    relations: relationsSchema.optional(),
  })
  .superRefine((snapshot, context) => {
    const invalid = () => context.addIssue({ code: 'custom', message: 'Invalid Fabric relations' });
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > maxSnapshotBytes) invalid();
    const relations = snapshot.relations;
    if (!relations) return;
    const gameVersions = new Set(snapshot.games.map((item) => item.version));
    const loaderVersions = new Set(snapshot.loaders.map((item) => item.version));
    const mappings = Object.entries(relations.gameLoaderSets);
    if (gameVersions.size > maxGames || mappings.length !== gameVersions.size) invalid();
    const usedSets = new Set<number>();
    for (const [game, index] of mappings) {
      if (!gameVersions.has(game) || index >= relations.loaderSets.length) invalid();
      usedSets.add(index);
    }
    if (usedSets.size !== relations.loaderSets.length) invalid();
    const distinctSets = new Set<string>();
    for (const versions of relations.loaderSets) {
      if (
        new Set(versions).size !== versions.length ||
        versions.some((version) => !loaderVersions.has(version))
      )
        invalid();
      const key = JSON.stringify([...versions].sort());
      if (distinctSets.has(key)) invalid();
      distinctSets.add(key);
    }
  });
export type FabricCatalogSnapshot = z.infer<typeof fabricCatalogSnapshotSchema>;
export interface FabricCatalogStatus {
  syncState: 'idle' | 'queued' | 'refreshing';
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  nextCheckAt: string | null;
  lastError: string | null;
  stale: boolean;
}
export interface FabricCatalogResponse extends FabricCatalogSnapshot {
  latestInstallerVersion: string | null;
  status: FabricCatalogStatus;
  synced: boolean;
}
export interface FetchFabricCatalogOptions {
  previous?: FabricCatalogSnapshot;
  /** Periodically recheck existing associations even when the global lists are unchanged. */
  forceRelationsRefresh?: boolean;
  /** Called before and after each successful batch of at most two requests; may renew a lease. */
  onProgress?: () => void | Promise<void>;
  now?: () => Date;
}
export function fabricGameLoadersUrl(gameVersion: string): string {
  return `${fabricCatalogUrls.loaders}/${encodeURIComponent(gameEntry.shape.version.parse(gameVersion))}`;
}
const pairEntries = z
  .array(
    z.object({
      loader: z.object({ version: entry.shape.version }),
    }),
  )
  .max(20_000);
function invalidMetadata(): never {
  throw new DomainError('integration_unavailable', 503, { reason: 'fabric_metadata_invalid' });
}
function exceededBudget(): never {
  throw new DomainError('integration_unavailable', 503, {
    reason: 'fabric_metadata_budget_exceeded',
  });
}
/** Associations come from Fabric's per-game endpoint, never the Cartesian product of root lists.
 * Batches bound concurrency and settle fully before failure escapes or further work starts. */
export async function fetchFabricCatalog(
  client: RuntimeMetadataClient,
  options: FetchFabricCatalogOptions = {},
): Promise<FabricCatalogSnapshot> {
  let bytesRead = 0;
  let requests = 0;
  async function read<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    if (++requests > maxGames + 3) exceededBudget();
    const document = await client.read(url);
    bytesRead += document.bytes.byteLength;
    if (bytesRead > maxRunBytes) exceededBudget();
    try {
      return schema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(document.bytes)),
      );
    } catch {
      return invalidMetadata();
    }
  }
  async function batches<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
    for (let offset = 0; offset < items.length; offset += 2) {
      await options.onProgress?.();
      const results = await Promise.allSettled(items.slice(offset, offset + 2).map(run));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      await options.onProgress?.();
    }
  }
  const catalogs: Partial<FabricCatalogSnapshot> = {};
  await batches(['games', 'loaders', 'installers'] as const, async (kind) => {
    catalogs[kind] = await read(fabricCatalogUrls[kind], kind === 'games' ? games : entries);
  });
  const parsed = fabricCatalogSnapshotSchema.safeParse(catalogs);
  if (!parsed.success) return invalidMetadata();
  const snapshot = parsed.data;
  if (snapshot.games.length > maxGames) exceededBudget();
  const previous = fabricCatalogSnapshotSchema.safeParse(options.previous);
  const reusable =
    !options.forceRelationsRefresh &&
    previous.success &&
    previous.data.relations &&
    JSON.stringify(previous.data.loaders) === JSON.stringify(snapshot.loaders)
      ? previous.data.relations
      : undefined;
  const knownLoaders = new Set(snapshot.loaders.map((item) => item.version));
  const byGame = new Map<string, string[]>();
  const pending: string[] = [];
  for (const { version } of snapshot.games) {
    const priorIndex = reusable?.gameLoaderSets[version];
    const priorSet = priorIndex === undefined ? undefined : reusable?.loaderSets[priorIndex];
    if (priorSet) byGame.set(version, priorSet);
    else pending.push(version);
  }
  await batches(pending, async (game) => {
    const pairs = await read(fabricGameLoadersUrl(game), pairEntries);
    const versions = pairs.map((pair) => pair.loader.version);
    if (
      new Set(versions).size !== versions.length ||
      versions.some((version) => !knownLoaders.has(version))
    )
      invalidMetadata();
    byGame.set(game, versions);
  });
  const loaderSets: string[][] = [];
  const setIndexes = new Map<string, number>();
  const mappings: [string, number][] = [];
  let relationBytes = 0;
  for (const { version: game } of snapshot.games) {
    const versions = byGame.get(game);
    if (!versions) return invalidMetadata();
    // Canonical global order deduplicates equal sets even if upstream pair order differs.
    const members = new Set(versions);
    const canonical = snapshot.loaders
      .filter((item) => members.has(item.version))
      .map((item) => item.version);
    const key = JSON.stringify(canonical);
    let index = setIndexes.get(key);
    if (index === undefined) {
      index = loaderSets.length;
      setIndexes.set(key, index);
      loaderSets.push(canonical);
      relationBytes += new TextEncoder().encode(key).byteLength;
      if (relationBytes > maxSnapshotBytes) exceededBudget();
    }
    mappings.push([game, index]);
  }
  const complete = fabricCatalogSnapshotSchema.safeParse({
    ...snapshot,
    relations: {
      checkedAt: reusable?.checkedAt ?? (options.now?.() ?? new Date()).toISOString(),
      loaderSets,
      gameLoaderSets: Object.fromEntries(mappings),
    },
  });
  if (!complete.success) return invalidMetadata();
  return complete.data;
}
