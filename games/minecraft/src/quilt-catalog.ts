import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import type { FabricCatalogStatus } from './fabric-catalog.js';
import type { RuntimeMetadataClient } from './runtime.js';

export const quiltCatalogUrls = {
  games: 'https://meta.quiltmc.org/v3/versions/game',
  loaders: 'https://meta.quiltmc.org/v3/versions/loader',
  installers: 'https://meta.quiltmc.org/v3/versions/installer',
} as const;
const version = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const entry = z.object({ version, stable: z.boolean() });
const unique = <T extends z.ZodType<{ version: string }>>(schema: T, max = 20_000) =>
  z
    .array(schema)
    .min(1)
    .max(max)
    .refine((items) => new Set(items.map((item) => item.version)).size === items.length);
const gamesSchema = unique(entry, 2_000);
const loadersSchema = unique(
  z.object({
    version,
    maven: z.string(),
    hashes: z.object({ sha256 }),
    file_size: z.number().int().positive(),
  }),
);
export const quiltInstallerMetadataSchema = z
  .object({
    version,
    maven: z.string(),
    url: z.string(),
    hashes: z.object({ sha256 }),
    file_size: z.number().int().positive(),
  })
  .superRefine((item, context) => {
    if (
      item.maven !== `org.quiltmc:quilt-installer:${item.version}` ||
      item.url !==
        `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/${item.version}/quilt-installer-${item.version}.jar`
    )
      context.addIssue({ code: 'custom', message: 'Invalid Quilt installer identity' });
  });
export const quiltInstallerListSchema = unique(quiltInstallerMetadataSchema);
const installerEntry = entry.extend({ url: z.string(), sha256, size: z.number().int().positive() });
const maxBytes = 8 * 1024 * 1024;
const document = z.object({
  json: z.string().max(maxBytes),
  evidence: z.object({ url: z.string(), sha256, retrievedAt: z.iso.datetime({ offset: true }) }),
});
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function invalid(): never {
  throw new DomainError('integration_unavailable', 503, { reason: 'quilt_metadata_invalid' });
}
function normalize(raw: Record<keyof typeof quiltCatalogUrls, unknown>) {
  const games = gamesSchema.parse(raw.games);
  const loaders = loadersSchema.parse(raw.loaders).map((item) => {
    if (item.maven !== `org.quiltmc:quilt-loader:${item.version}`) invalid();
    return { version: item.version, stable: !item.version.includes('-') };
  });
  const installers = quiltInstallerListSchema.parse(raw.installers).map((item) => ({
    version: item.version,
    stable: !item.version.includes('-'),
    url: item.url,
    sha256: item.hashes.sha256.toLowerCase(),
    size: item.file_size,
  }));
  return { games, loaders, installers };
}
export const quiltCatalogSnapshotSchema = z
  .object({
    games: gamesSchema,
    loaders: unique(entry),
    installers: unique(installerEntry),
    documents: z.record(z.string(), document),
  })
  .superRefine((snapshot, context) => {
    const bad = () =>
      context.addIssue({ code: 'custom', message: 'Invalid Quilt catalog provenance' });
    try {
      if (
        Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes ||
        Object.keys(snapshot.documents).length !== 3
      )
        return bad();
      const raw = {} as Record<keyof typeof quiltCatalogUrls, unknown>;
      for (const [kind, url] of Object.entries(quiltCatalogUrls)) {
        const source = snapshot.documents[url];
        if (
          !source ||
          source.evidence.url !== url ||
          digest(source.json) !== source.evidence.sha256.toLowerCase()
        )
          return bad();
        raw[kind as keyof typeof quiltCatalogUrls] = JSON.parse(source.json);
      }
      const normalized = normalize(raw);
      for (const key of ['games', 'loaders', 'installers'] as const)
        if (JSON.stringify(normalized[key]) !== JSON.stringify(snapshot[key])) return bad();
    } catch {
      bad();
    }
  });
export type QuiltCatalogSnapshot = z.infer<typeof quiltCatalogSnapshotSchema>;
export interface QuiltCatalogResponse extends Omit<QuiltCatalogSnapshot, 'documents'> {
  latestInstallerVersion: string | null;
  status: FabricCatalogStatus;
  synced: boolean;
}
/** Three independent lists; metadata availability is not game/loader certification. */
export async function fetchQuiltCatalog(
  client: RuntimeMetadataClient,
  options: { onProgress?: () => void | Promise<void>; previous?: QuiltCatalogSnapshot } = {},
): Promise<QuiltCatalogSnapshot> {
  const old = quiltCatalogSnapshotSchema.safeParse(options.previous);
  const previous = old.success ? old.data : undefined;
  const documents: QuiltCatalogSnapshot['documents'] = {};
  const raw = {} as Record<keyof typeof quiltCatalogUrls, unknown>;
  let bytes = 0;
  for (const key of ['games', 'loaders', 'installers'] as const) {
    await options.onProgress?.();
    const url = quiltCatalogUrls[key];
    const source = await client.read(url);
    bytes += source.bytes.byteLength;
    if (bytes > maxBytes)
      throw new DomainError('integration_unavailable', 503, {
        reason: 'quilt_metadata_budget_exceeded',
      });
    try {
      const json = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes);
      if (
        source.evidence.url !== url ||
        digest(source.bytes) !== source.evidence.sha256.toLowerCase()
      )
        invalid();
      const cached = previous?.documents[url];
      documents[url] =
        cached?.evidence.sha256 === source.evidence.sha256
          ? cached
          : { json, evidence: source.evidence };
      raw[key] = JSON.parse(json);
    } catch {
      invalid();
    }
    await options.onProgress?.();
  }
  try {
    return quiltCatalogSnapshotSchema.parse({ ...normalize(raw), documents });
  } catch {
    return invalid();
  }
}
/** Freeze installer metadata already accepted by discovery; exact pair metadata remains live. */
export function quiltCatalogMetadataClient(
  snapshot: QuiltCatalogSnapshot,
  fallback: RuntimeMetadataClient,
): RuntimeMetadataClient {
  const parsed = quiltCatalogSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) invalid();
  return {
    async read(url) {
      const cached = parsed.data.documents[url];
      if (cached)
        return { bytes: new TextEncoder().encode(cached.json), evidence: { ...cached.evidence } };
      return fallback.read(url);
    },
  };
}
