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
const maxRunBytes = 8 * 1024 * 1024;
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
  /** Called around each settled request batch to maintain the publication lease. */
  onProgress?: () => void | Promise<void>;
}
/** Retained for consumers of historical association snapshots, not used during sync. */
export function fabricGameLoadersUrl(gameVersion: string): string {
  return `${fabricCatalogUrls.loaders}/${encodeURIComponent(gameEntry.shape.version.parse(gameVersion))}`;
}
function invalidMetadata(): never {
  throw new DomainError('integration_unavailable', 503, { reason: 'fabric_metadata_invalid' });
}
function exceededBudget(): never {
  throw new DomainError('integration_unavailable', 503, {
    reason: 'fabric_metadata_budget_exceeded',
  });
}
/** Independent version lists: exactly three reads, no per-game or per-pair discovery.
 * Choosing a Loader is not a claim that every pair has been tested. */
export async function fetchFabricCatalog(
  client: RuntimeMetadataClient,
  options: FetchFabricCatalogOptions = {},
): Promise<FabricCatalogSnapshot> {
  let bytesRead = 0;
  let requests = 0;
  async function read<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    if (++requests > 3) exceededBudget();
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
  return snapshot;
}
