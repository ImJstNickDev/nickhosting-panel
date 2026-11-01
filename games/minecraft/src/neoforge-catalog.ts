import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import type { FabricCatalogStatus } from './fabric-catalog.js';
import { neoforgeJavaMajor, neoforgeMinecraftVersion } from './neoforge-policy.js';
import type { RuntimeMetadataClient } from './runtime.js';

export const neoforgeCatalogUrls = {
  legacy: 'https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml',
  versions: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
} as const;
export const neoforgeCatalogUrl = neoforgeCatalogUrls.versions;
const maxBytes = 4 * 1024 * 1024;
const versionId = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
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
  throw new DomainError('integration_unavailable', 503, { reason: 'neoforge_metadata_invalid' });
}
/** Strict parser for the small Maven metadata grammar: no entity expansion,
 * attributes, DTDs or arbitrary XML extensions. */
export function parseNeoForgeVersions(xml: string, artifact: 'forge' | 'neoforge'): string[] {
  if (Buffer.byteLength(xml) > maxBytes || /[&\0]/.test(xml)) invalid();
  const source = xml.replace(/^\s*<\?xml version="1\.0" encoding="UTF-8"\?>/, '').trim();
  const match =
    /^<metadata>\s*<groupId>net\.neoforged<\/groupId>\s*<artifactId>(forge|neoforge)<\/artifactId>\s*<versioning>([\s\S]*)<\/versioning>\s*<\/metadata>$/.exec(
      source,
    );
  if (!match || match[1] !== artifact) invalid();
  const versioning = match[2] ?? '';
  const body =
    /^(?:\s*<(latest|release)>[A-Za-z0-9._+-]+<\/\1>)*\s*<versions>([\s\S]*?)<\/versions>(?:\s*<lastUpdated>\d+<\/lastUpdated>)?\s*$/.exec(
      versioning,
    )?.[2];
  if (body === undefined) invalid();
  const versions = [...body.matchAll(/<version>([A-Za-z0-9._+-]{1,96})<\/version>/g)].map(
    (match) => match[1] ?? '',
  );
  if (
    body.replace(/<version>[A-Za-z0-9._+-]{1,96}<\/version>/g, '').trim() ||
    !versions.length ||
    versions.length > 100_000 ||
    new Set(versions).size !== versions.length
  )
    invalid();
  return versions;
}
function newest(left: string, right: string): number {
  return right.localeCompare(left, 'en', { numeric: true });
}
function deriveVersions(documents: Record<string, z.infer<typeof documentSchema>>) {
  const grouped = new Map<string, string[]>();
  for (const [artifact, url] of [
    ['forge', neoforgeCatalogUrls.legacy],
    ['neoforge', neoforgeCatalogUrls.versions],
  ] as const) {
    for (const version of parseNeoForgeVersions(documents[url]?.json ?? '', artifact)) {
      const release = neoforgeMinecraftVersion(version);
      if (!release || (artifact === 'forge') !== (release === '1.20.1')) continue;
      const loaders = grouped.get(release) ?? [];
      loaders.push(version);
      grouped.set(release, loaders);
    }
  }
  return [...grouped]
    .sort(([a], [b]) => newest(a, b))
    .map(([minecraftVersion, versions]) => ({
      minecraftVersion,
      javaMajor: neoforgeJavaMajor(minecraftVersion),
      loaders: versions.sort(newest).map((version, index) => ({
        version,
        coordinate: version,
        recommended: false,
        latest: index === 0,
      })),
    }));
}
/** Retain only two aggregate XML responses, never a build×Minecraft request matrix. */
export const neoforgeCatalogSnapshotSchema = z
  .object({
    versions: z.array(catalogVersionSchema).min(1).max(2_000),
    documents: z.record(z.string(), documentSchema),
  })
  .superRefine((snapshot, context) => {
    try {
      if (Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes) invalid();
      const urls = Object.values(neoforgeCatalogUrls);
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
      context.addIssue({ code: 'custom', message: 'Invalid NeoForge snapshot' });
    }
  });
export type NeoForgeCatalogSnapshot = z.infer<typeof neoforgeCatalogSnapshotSchema>;
export interface NeoForgeCatalogResponse {
  versions: NeoForgeCatalogSnapshot['versions'];
  status: FabricCatalogStatus;
  synced: boolean;
}
export interface FetchNeoForgeCatalogOptions {
  onProgress?: () => void | Promise<void>;
  previous?: NeoForgeCatalogSnapshot;
}
export async function fetchNeoForgeCatalog(
  client: RuntimeMetadataClient,
  options: FetchNeoForgeCatalogOptions = {},
): Promise<NeoForgeCatalogSnapshot> {
  const old = neoforgeCatalogSnapshotSchema.safeParse(options.previous);
  const previous = old.success ? old.data : undefined;
  await options.onProgress?.();
  const results = await Promise.allSettled(
    Object.values(neoforgeCatalogUrls).map(async (url) => {
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
  const result = neoforgeCatalogSnapshotSchema.safeParse({
    versions: deriveVersions(documents),
    documents,
  });
  if (!result.success) invalid();
  return result.data;
}
/** Resolve the selected exact build against the stored catalog. Its installer
 * checksum and Mojang metadata still use the normal trusted metadata transport. */
export function neoforgeCatalogMetadataClient(
  snapshot: NeoForgeCatalogSnapshot,
  fallback: RuntimeMetadataClient,
): RuntimeMetadataClient {
  const result = neoforgeCatalogSnapshotSchema.safeParse(snapshot);
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
