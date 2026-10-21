import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import type { FabricCatalogStatus } from './fabric-catalog.js';
import { paperJavaMajor } from './paper-policy.js';
import { type RuntimeMetadataClient, trustedMinecraftArtifactUrl } from './runtime.js';

export const paperCatalogUrl = 'https://fill.papermc.io/v3/projects/paper';
const maxVersions = 2_000;
const maxBytes = 16 * 1024 * 1024;
const versionId = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/);
const buildId = z.number().int().nonnegative();
const javaMinimum = z.number().int().min(6).max(100);
const channel = z.enum(['STABLE', 'RECOMMENDED', 'EXPERIMENTAL', 'ALPHA', 'BETA']);
const projectSchema = z.object({
  project: z.object({ id: z.literal('paper') }),
  versions: z.record(versionId, z.array(versionId).max(maxVersions)),
});
const versionSchema = z.object({
  version: z.object({
    id: versionId,
    java: z.object({ version: z.object({ minimum: javaMinimum }) }),
  }),
  builds: z
    .array(buildId)
    .min(1)
    .max(100_000)
    .refine((items) => new Set(items).size === items.length),
});
const buildSchema = z.object({
  id: buildId,
  time: z.iso.datetime({ offset: true }),
  channel,
  downloads: z.object({
    'server:default': z.object({
      url: z.string().refine((value) => {
        try {
          return (
            new URL(trustedMinecraftArtifactUrl(value)).origin === 'https://fill-data.papermc.io'
          );
        } catch {
          return false;
        }
      }),
      checksums: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/i) }),
      size: z.number().int().positive(),
    }),
  }),
});
const documentSchema = z.object({
  json: z.string().max(maxBytes),
  evidence: z.object({
    url: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    retrievedAt: z.iso.datetime({ offset: true }),
  }),
});
const catalogVersion = z.object({
  version: versionId,
  buildId,
  javaMajor: z.number().int().min(8).max(100),
  channel,
  buildTime: z.iso.datetime({ offset: true }),
});
const versionUrl = (version: string) => `${paperCatalogUrl}/versions/${version}`;
const newestBuild = (builds: readonly number[]) =>
  builds.reduce((latest, id) => Math.max(latest, id), 0);
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function invalid(): never {
  throw new DomainError('integration_unavailable', 503, { reason: 'paper_metadata_invalid' });
}
function budgetExceeded(): never {
  throw new DomainError('integration_unavailable', 503, {
    reason: 'paper_metadata_budget_exceeded',
  });
}
function parseDocument<T>(document: { json: string } | undefined, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(document?.json ?? ''));
  } catch {
    return invalid();
  }
}
function projectVersions(project: z.infer<typeof projectSchema>) {
  const versions = Object.values(project.versions).flat();
  if (!versions.length || new Set(versions).size !== versions.length) invalid();
  if (versions.length > maxVersions) budgetExceeded();
  return versions;
}
/** Raw documents retain the actual response bytes/hash, including provider fields
 * not needed by discovery. They are the immutable resolution inputs at creation. */
export const paperCatalogSnapshotSchema = z
  .object({
    versions: z.array(catalogVersion).min(1).max(maxVersions),
    documents: z.record(z.string(), documentSchema),
  })
  .superRefine((snapshot, context) => {
    try {
      if (Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes) invalid();
      const versions = projectVersions(
        parseDocument(snapshot.documents[paperCatalogUrl], projectSchema),
      );
      const expectedUrls = new Set([paperCatalogUrl]);
      if (versions.length !== snapshot.versions.length) invalid();
      for (const [index, selected] of snapshot.versions.entries()) {
        if (selected.version !== versions[index]) invalid();
        const url = versionUrl(selected.version);
        const metadata = parseDocument(snapshot.documents[url], versionSchema);
        const buildUrl = `${url}/builds/${selected.buildId}`;
        const build = parseDocument(snapshot.documents[buildUrl], buildSchema);
        if (
          metadata.version.id !== selected.version ||
          newestBuild(metadata.builds) !== selected.buildId ||
          build.id !== selected.buildId ||
          build.channel !== selected.channel ||
          build.time !== selected.buildTime ||
          selected.javaMajor !==
            paperJavaMajor(selected.version, metadata.version.java.version.minimum)
        )
          invalid();
        expectedUrls.add(url);
        expectedUrls.add(buildUrl);
      }
      if (Object.keys(snapshot.documents).length !== expectedUrls.size) invalid();
      for (const [url, document] of Object.entries(snapshot.documents)) {
        if (
          !expectedUrls.has(url) ||
          document.evidence.url !== url ||
          digest(document.json) !== document.evidence.sha256
        )
          invalid();
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid Paper snapshot' });
    }
  });
export type PaperCatalogSnapshot = z.infer<typeof paperCatalogSnapshotSchema>;
export interface PaperCatalogResponse {
  versions: PaperCatalogSnapshot['versions'];
  status: FabricCatalogStatus;
  synced: boolean;
}
export interface FetchPaperCatalogOptions {
  onProgress?: () => void | Promise<void>;
  previous?: PaperCatalogSnapshot;
}

/** All channels are eligible. Select each version's largest exact build number,
 * keeping existing servers unchanged. At most two provider requests run together. */
export async function fetchPaperCatalog(
  client: RuntimeMetadataClient,
  options: FetchPaperCatalogOptions = {},
): Promise<PaperCatalogSnapshot> {
  const old = paperCatalogSnapshotSchema.safeParse(options.previous);
  const previous = old.success ? old.data : undefined;
  const documents: PaperCatalogSnapshot['documents'] = {};
  let bytesRead = 0;
  let requests = 0;
  async function read<T>(url: string, schema: z.ZodType<T>, reuse = false): Promise<T> {
    const cached = previous?.documents[url];
    if (reuse && cached) {
      documents[url] = cached;
      return parseDocument(cached, schema);
    }
    if (++requests > 1 + maxVersions * 2) budgetExceeded();
    const response = await client.read(url);
    bytesRead += response.bytes.byteLength;
    if (bytesRead > maxBytes) budgetExceeded();
    let raw: string;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes);
    } catch {
      return invalid();
    }
    const parsed = documentSchema.safeParse({ json: raw, evidence: response.evidence });
    if (
      !parsed.success ||
      parsed.data.evidence.url !== url ||
      digest(response.bytes) !== parsed.data.evidence.sha256
    )
      invalid();
    // A repeated response retains its original true observation, so an unchanged
    // refresh doesn't rewrite the entire snapshot merely to advance timestamps.
    const document = cached?.evidence.sha256 === parsed.data.evidence.sha256 ? cached : parsed.data;
    documents[url] = document;
    return parseDocument(document, schema);
  }
  await options.onProgress?.();
  const project = await read(paperCatalogUrl, projectSchema);
  await options.onProgress?.();
  const versions = projectVersions(project);
  const selected: PaperCatalogSnapshot['versions'] = [];
  for (let offset = 0; offset < versions.length; offset += 2) {
    await options.onProgress?.();
    const results = await Promise.allSettled(
      versions.slice(offset, offset + 2).map(async (version) => {
        const url = versionUrl(version);
        const metadata = await read(url, versionSchema);
        if (metadata.version.id !== version) invalid();
        const id = newestBuild(metadata.builds);
        const build = await read(`${url}/builds/${id}`, buildSchema, true);
        if (build.id !== id) invalid();
        return {
          version,
          buildId: id,
          javaMajor: paperJavaMajor(version, metadata.version.java.version.minimum),
          channel: build.channel,
          buildTime: build.time,
        };
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    for (const result of results) if (result.status === 'fulfilled') selected.push(result.value);
    await options.onProgress?.();
  }
  const parsed = paperCatalogSnapshotSchema.safeParse({
    versions: selected,
    documents: Object.fromEntries(
      Object.entries(documents).sort(([left], [right]) => left.localeCompare(right)),
    ),
  });
  if (!parsed.success) invalid();
  return parsed.data;
}

/** Freeze the selected Fill documents while delegating Mojang metadata to the
 * existing client. Missing Paper entries fail closed, never selecting a newer build. */
export function paperCatalogMetadataClient(
  snapshot: PaperCatalogSnapshot,
  fallback: RuntimeMetadataClient,
): RuntimeMetadataClient {
  const parsed = paperCatalogSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) invalid();
  const documents = parsed.data.documents;
  return {
    async read(url) {
      const cached = documents[url];
      if (cached)
        return { bytes: new TextEncoder().encode(cached.json), evidence: { ...cached.evidence } };
      if (url === paperCatalogUrl || url.startsWith(`${paperCatalogUrl}/`)) return invalid();
      return fallback.read(url);
    },
  };
}
