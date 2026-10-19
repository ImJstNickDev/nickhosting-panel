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
export const fabricCatalogSnapshotSchema = z.object({
  games,
  loaders: entries,
  installers: entries,
});
export type FabricCatalogSnapshot = z.infer<typeof fabricCatalogSnapshotSchema>;
export interface FabricCatalogStatus {
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
/** Three independent upstream lists. Their presence is discovery, never an assertion
 * that every Cartesian combination installs or has a verified NickHosting binding. */
export async function fetchFabricCatalog(
  client: RuntimeMetadataClient,
): Promise<FabricCatalogSnapshot> {
  const kinds = ['games', 'loaders', 'installers'] as const;
  const results = await Promise.all(
    kinds.map(async (kind) => {
      const document = await client.read(fabricCatalogUrls[kind]);
      try {
        return [
          kind,
          (kind === 'games' ? games : entries).parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(document.bytes)),
          ),
        ] as const;
      } catch {
        throw new DomainError('integration_unavailable', 503, {
          reason: 'fabric_metadata_invalid',
        });
      }
    }),
  );
  return fabricCatalogSnapshotSchema.parse(Object.fromEntries(results));
}
