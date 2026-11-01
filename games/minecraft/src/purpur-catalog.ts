import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import type { FabricCatalogStatus } from './fabric-catalog.js';
import { purpurJavaMajor } from './purpur-policy.js';
import type { RuntimeMetadataClient } from './runtime.js';

export const purpurCatalogUrl = 'https://api.purpurmc.org/v2/purpur';
const maxVersions = 2_000;
const maxBytes = 16 * 1024 * 1024;
const versionId = z
  .string()
  .max(96)
  .regex(/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/);
const buildId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const buildString = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const projectSchema = z.object({
  project: z.literal('purpur'),
  versions: z.array(versionId).min(1).max(maxVersions),
});
export const purpurVersionSchema = z
  .object({
    project: z.literal('purpur'),
    version: versionId,
    builds: z.object({
      latest: buildString,
      all: z
        .array(buildString)
        .min(1)
        .max(100_000)
        .refine((items) => new Set(items).size === items.length),
    }),
  })
  .refine((value) => value.builds.all.includes(value.builds.latest));
export const purpurBuildSchema = z.object({
  project: z.literal('purpur'),
  version: versionId,
  build: buildString,
  result: z.literal('SUCCESS'),
  timestamp: z.number().int().nonnegative().max(8_640_000_000_000_000),
  md5: z.string().regex(/^[a-f0-9]{32}$/i),
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
  buildTime: z.iso.datetime({ offset: true }),
});
const versionUrl = (version: string) => `${purpurCatalogUrl}/${version}`;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function invalid(): never {
  throw new DomainError('integration_unavailable', 503, { reason: 'purpur_metadata_invalid' });
}
function budgetExceeded(): never {
  throw new DomainError('integration_unavailable', 503, {
    reason: 'purpur_metadata_budget_exceeded',
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
  const versions = project.versions;
  if (!versions.length || new Set(versions).size !== versions.length) invalid();
  if (versions.length > maxVersions) budgetExceeded();
  return versions;
}
/** Raw documents retain the actual response bytes/hash, including provider fields
 * not needed by discovery. They are the immutable resolution inputs at creation. */
export const purpurCatalogSnapshotSchema = z
  .object({
    versions: z.array(catalogVersion).min(1).max(maxVersions),
    documents: z.record(z.string(), documentSchema),
  })
  .superRefine((snapshot, context) => {
    try {
      if (Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes) invalid();
      const versions = projectVersions(
        parseDocument(snapshot.documents[purpurCatalogUrl], projectSchema),
      );
      const expectedUrls = new Set([purpurCatalogUrl]);
      if (versions.length !== snapshot.versions.length) invalid();
      for (const [index, selected] of snapshot.versions.entries()) {
        if (selected.version !== versions[index]) invalid();
        const url = versionUrl(selected.version);
        const metadata = parseDocument(snapshot.documents[url], purpurVersionSchema);
        const buildUrl = `${url}/${selected.buildId}`;
        const build = parseDocument(snapshot.documents[buildUrl], purpurBuildSchema);
        if (
          metadata.version !== selected.version ||
          Number(metadata.builds.latest) !== selected.buildId ||
          Number(build.build) !== selected.buildId ||
          build.version !== selected.version ||
          new Date(build.timestamp).toISOString() !== selected.buildTime ||
          selected.javaMajor !== purpurJavaMajor(selected.version)
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
      context.addIssue({ code: 'custom', message: 'Invalid Purpur snapshot' });
    }
  });
export type PurpurCatalogSnapshot = z.infer<typeof purpurCatalogSnapshotSchema>;
export interface PurpurCatalogResponse {
  versions: PurpurCatalogSnapshot['versions'];
  status: FabricCatalogStatus;
  synced: boolean;
}
export interface FetchPurpurCatalogOptions {
  onProgress?: () => void | Promise<void>;
  previous?: PurpurCatalogSnapshot;
}

/** Select the provider's exact latest build only after successful-build validation.
 * Failed latest builds fail the refresh; existing last-good snapshots are retained.
 * At most two provider requests run together. */
export async function fetchPurpurCatalog(
  client: RuntimeMetadataClient,
  options: FetchPurpurCatalogOptions = {},
): Promise<PurpurCatalogSnapshot> {
  const old = purpurCatalogSnapshotSchema.safeParse(options.previous);
  const previous = old.success ? old.data : undefined;
  const documents: PurpurCatalogSnapshot['documents'] = {};
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
  const project = await read(purpurCatalogUrl, projectSchema);
  await options.onProgress?.();
  const versions = projectVersions(project);
  const selected: PurpurCatalogSnapshot['versions'] = [];
  for (let offset = 0; offset < versions.length; offset += 2) {
    await options.onProgress?.();
    const results = await Promise.allSettled(
      versions.slice(offset, offset + 2).map(async (version) => {
        const url = versionUrl(version);
        const metadata = await read(url, purpurVersionSchema);
        if (metadata.version !== version) invalid();
        const id = Number(metadata.builds.latest);
        const build = await read(`${url}/${id}`, purpurBuildSchema, true);
        if (Number(build.build) !== id || build.version !== version) invalid();
        return {
          version,
          buildId: id,
          javaMajor: purpurJavaMajor(version),
          buildTime: new Date(build.timestamp).toISOString(),
        };
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    for (const result of results) if (result.status === 'fulfilled') selected.push(result.value);
    await options.onProgress?.();
  }
  const parsed = purpurCatalogSnapshotSchema.safeParse({
    versions: selected,
    documents: Object.fromEntries(
      Object.entries(documents).sort(([left], [right]) => left.localeCompare(right)),
    ),
  });
  if (!parsed.success) invalid();
  return parsed.data;
}

/** Freeze the selected Purpur documents while delegating Mojang metadata to the
 * existing client. Missing Purpur entries fail closed, never selecting a newer build. */
export function purpurCatalogMetadataClient(
  snapshot: PurpurCatalogSnapshot,
  fallback: RuntimeMetadataClient,
): RuntimeMetadataClient {
  const parsed = purpurCatalogSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) invalid();
  const documents = parsed.data.documents;
  return {
    async read(url) {
      const cached = documents[url];
      if (cached)
        return { bytes: new TextEncoder().encode(cached.json), evidence: { ...cached.evidence } };
      if (url === purpurCatalogUrl || url.startsWith(`${purpurCatalogUrl}/`)) return invalid();
      return fallback.read(url);
    },
  };
}
