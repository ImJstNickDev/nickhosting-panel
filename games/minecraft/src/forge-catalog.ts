import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import type { FabricCatalogStatus } from './fabric-catalog.js';
import { forgeEnhancedSupportedRelease, forgeJavaMajor } from './forge-policy.js';
import type { RuntimeMetadataClient } from './runtime.js';

export const forgeCatalogUrls = {
  versions: 'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json',
  promotions: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
} as const;
export const forgeCatalogUrl = forgeCatalogUrls.versions;
export const forgePromotionsUrl = forgeCatalogUrls.promotions;
const maxBytes = 4 * 1024 * 1024;
const versionId = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
const metadataSchema = z.record(versionId, z.array(versionId).max(20_000));
const promotionsSchema = z.object({ promos: z.record(versionId, versionId) });
const documentSchema = z.object({
  json: z.string().max(maxBytes),
  evidence: z.object({
    url: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    retrievedAt: z.iso.datetime({ offset: true }),
  }),
});
const catalogVersionSchema = z.object({
  minecraftVersion: versionId,
  javaMajor: z.number().int().min(8).max(100),
  loaders: z
    .array(
      z.object({
        version: versionId,
        coordinate: versionId,
        recommended: z.boolean(),
        latest: z.boolean(),
      }),
    )
    .min(1)
    .max(20_000),
});
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function invalid(): never {
  throw new DomainError('integration_unavailable', 503, { reason: 'forge_metadata_invalid' });
}
function parse<T>(document: { json: string } | undefined, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(document?.json ?? ''));
  } catch {
    return invalid();
  }
}
function newest(left: string, right: string): number {
  return right.localeCompare(left, 'en', { numeric: true });
}
function deriveVersions(documents: Record<string, z.infer<typeof documentSchema>>) {
  const metadata = parse(documents[forgeCatalogUrls.versions], metadataSchema);
  const { promos } = parse(documents[forgeCatalogUrls.promotions], promotionsSchema);
  if (!Object.keys(metadata).length || Object.keys(metadata).length > 2_000) invalid();
  let total = 0;
  return Object.entries(metadata)
    .filter(([release]) => forgeEnhancedSupportedRelease(release))
    .sort(([left], [right]) => newest(left, right))
    .flatMap(([minecraftVersion, coordinates]) => {
      if (new Set(coordinates).size !== coordinates.length) invalid();
      total += coordinates.length;
      if (total > 100_000) invalid();
      const loaders = coordinates
        .map((coordinate) => {
          const prefix = `${minecraftVersion}-`;
          if (!coordinate.startsWith(prefix)) invalid();
          const version = coordinate.slice(prefix.length);
          if (!versionId.safeParse(version).success) invalid();
          const promoted = (kind: 'recommended' | 'latest') => {
            const value = promos[`${minecraftVersion}-${kind}`];
            // Legacy official Maven coordinates sometimes repeat Minecraft at the
            // end. Preserve that suffix instead of inventing a shorter artifact URL.
            return (
              value !== undefined &&
              (version === value || version === `${value}-${minecraftVersion}`)
            );
          };
          return {
            version,
            coordinate,
            recommended: promoted('recommended'),
            latest: promoted('latest'),
          };
        })
        .sort((a, b) => newest(a.version, b.version));
      return loaders.length
        ? [{ minecraftVersion, javaMajor: forgeJavaMajor(minecraftVersion), loaders }]
        : [];
    });
}
/** Retain only two aggregate responses, never a build×Minecraft request matrix. */
export const forgeCatalogSnapshotSchema = z
  .object({
    versions: z.array(catalogVersionSchema).min(1).max(2_000),
    documents: z.record(z.string(), documentSchema),
  })
  .superRefine((snapshot, context) => {
    try {
      if (Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes) invalid();
      const urls = Object.values(forgeCatalogUrls);
      if (Object.keys(snapshot.documents).length !== urls.length) invalid();
      for (const url of urls) {
        const document = snapshot.documents[url];
        if (
          !document ||
          document.evidence.url !== url ||
          digest(document.json) !== document.evidence.sha256
        )
          invalid();
      }
      if (JSON.stringify(snapshot.versions) !== JSON.stringify(deriveVersions(snapshot.documents)))
        invalid();
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid Forge snapshot' });
    }
  });
export type ForgeCatalogSnapshot = z.infer<typeof forgeCatalogSnapshotSchema>;
export interface ForgeCatalogResponse {
  versions: ForgeCatalogSnapshot['versions'];
  status: FabricCatalogStatus;
  synced: boolean;
}
export interface FetchForgeCatalogOptions {
  onProgress?: () => void | Promise<void>;
  previous?: ForgeCatalogSnapshot;
}
export async function fetchForgeCatalog(
  client: RuntimeMetadataClient,
  options: FetchForgeCatalogOptions = {},
): Promise<ForgeCatalogSnapshot> {
  const old = forgeCatalogSnapshotSchema.safeParse(options.previous);
  const previous = old.success ? old.data : undefined;
  await options.onProgress?.();
  const results = await Promise.allSettled(
    Object.values(forgeCatalogUrls).map(async (url) => {
      const response = await client.read(url);
      if (response.bytes.byteLength > maxBytes) invalid();
      let json: string;
      try {
        json = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes);
      } catch {
        return invalid();
      }
      const document = documentSchema.parse({ json, evidence: response.evidence });
      if (document.evidence.url !== url || digest(response.bytes) !== document.evidence.sha256)
        invalid();
      const cached = previous?.documents[url];
      return [
        url,
        cached?.evidence.sha256 === document.evidence.sha256 ? cached : document,
      ] as const;
    }),
  );
  await options.onProgress?.();
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  const documents = Object.fromEntries(
    results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
  );
  const result = forgeCatalogSnapshotSchema.safeParse({
    versions: deriveVersions(documents),
    documents,
  });
  if (!result.success) invalid();
  return result.data;
}
/** Resolve the selected exact build against the stored catalog. Its installer
 * checksum and Mojang metadata still use the normal trusted metadata transport. */
export function forgeCatalogMetadataClient(
  snapshot: ForgeCatalogSnapshot,
  fallback: RuntimeMetadataClient,
): RuntimeMetadataClient {
  const result = forgeCatalogSnapshotSchema.safeParse(snapshot);
  if (!result.success) invalid();
  const documents = result.data.documents;
  return {
    async read(url) {
      const cached = documents[url];
      if (cached)
        return { bytes: new TextEncoder().encode(cached.json), evidence: { ...cached.evidence } };
      return fallback.read(url);
    },
  };
}
