import { DomainError } from '@nickhosting/core';
import { z } from 'zod';

export const contentTargetSchema = z
  .object({
    minecraftVersion: z.string().min(1).max(64),
    loader: z.enum(['vanilla', 'paper', 'folia', 'fabric', 'forge', 'neoforge', 'quilt']),
    loaderVersion: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ContentTarget = z.infer<typeof contentTargetSchema>;
const artifactHashesSchema = z
  .object({
    sha512: z
      .string()
      .regex(/^[a-f0-9]{128}$/)
      .optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    sha1: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  })
  .strict();
export const hashesSchema = artifactHashesSchema.refine((h) => Object.keys(h).length > 0);
export type ContentHashes = z.infer<typeof hashesSchema>;
export const artifactSchema = z
  .object({
    path: z.string(),
    urls: z.array(z.string().url()).min(1).max(8),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    hashes: artifactHashesSchema,
    /** SpiGet publishes no digests/exact sizes: size is a bounded ceiling, staging seals SHA256. */
    integrity: z.literal('spiget-tls').optional(),
    projectId: z.string().optional(),
    versionId: z.string().optional(),
    kind: z.enum(['mod', 'plugin', 'override']),
    // unknown requires independently inspected embedded JAR metadata before staging succeeds.
    serverSide: z.enum(['required', 'optional', 'unknown']),
    // Explicit per-version Mods consent; cannot relax download, integrity or path policy.
    allowClientOnly: z.literal(true).optional(),
    compatibilityOverride: z
      .array(z.enum(['minecraft-version', 'loader', 'client-only', 'singleplayer-only']))
      .min(1)
      .max(4)
      .optional(),
  })
  .strict()
  .refine((artifact) => {
    if (artifact.integrity !== 'spiget-tls') return Object.keys(artifact.hashes).length > 0;
    if (
      artifact.kind !== 'plugin' ||
      Object.keys(artifact.hashes).length ||
      artifact.urls.length !== 1 ||
      !/^[1-9][0-9]*$/.test(artifact.projectId ?? '') ||
      !/^[1-9][0-9]*$/.test(artifact.versionId ?? '')
    )
      return false;
    return (
      artifact.urls[0] ===
      `https://api.spiget.org/v2/resources/${artifact.projectId}/versions/${artifact.versionId}/download/proxy`
    );
  });
export type ContentArtifact = z.infer<typeof artifactSchema>;
export const incompatibleContentSchema = z
  .object({
    provider: z.enum(['modrinth', 'curseforge', 'hangar', 'spiget']),
    projectId: z.string().min(1).max(128),
    versionId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type IncompatibleContent = z.infer<typeof incompatibleContentSchema>;
export const contentPlanSchema = z
  .object({
    format: z.enum(['modrinth', 'curseforge', 'individual']),
    target: contentTargetSchema,
    artifacts: z.array(artifactSchema).max(10000),
    overrides: z
      .array(
        z
          .object({
            archivePath: z.string(),
            path: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            size: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(10000),
    projects: z
      .array(
        z
          .object({
            provider: z.enum(['modrinth', 'curseforge', 'hangar', 'spiget']),
            projectId: z.string(),
            versionId: z.string(),
            dependencies: z.array(z.string()),
            incompatible: z.array(incompatibleContentSchema).max(10000).optional(),
          })
          .strict(),
      )
      .max(10000),
    warnings: z.array(z.string()).max(10000),
  })
  .strict();
export type ContentPlan = z.infer<typeof contentPlanSchema>;
export interface ContentLimits {
  maxEntries: number;
  /** Central-directory records scanned without extracting opaque JAR resources. */
  maxJarEntries: number;
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxFileBytes: number;
  maxCompressionRatio: number;
  maxMetadataBytes: number;
  maxDependencies: number;
}
export const defaultContentLimits: ContentLimits = {
  maxEntries: 20000,
  maxJarEntries: 250000,
  maxArchiveBytes: 8 * 1024 ** 3,
  maxExpandedBytes: 16 * 1024 ** 3,
  maxFileBytes: 8 * 1024 ** 3,
  maxCompressionRatio: 500,
  maxMetadataBytes: 8 * 1024 ** 2,
  maxDependencies: 512,
};
export function contentLimits(overrides: Partial<ContentLimits> = {}): ContentLimits {
  const value = { ...defaultContentLimits, ...overrides };
  if (Object.values(value).some((n) => !Number.isSafeInteger(n) || n < 1)) fail('limits');
  return value;
}
export function fail(reason: string): never {
  throw new DomainError('validation_failed', 400, { contentReason: reason });
}
export function unavailable(reason: string): never {
  throw new DomainError('integration_unavailable', 503, { contentReason: reason });
}
/** No normalization: reject aliases before they can collide on another filesystem. */
export function safeArchivePath(input: string): string {
  if (
    !input ||
    input.length > 1024 ||
    /[\\:]/.test(input) ||
    [...input].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    input.startsWith('/') ||
    input.normalize('NFC') !== input
  )
    fail('archive_path');
  const parts = input.replace(/\/$/, '').split('/');
  if (
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p),
    )
  )
    fail('archive_path');
  return input;
}
export function safeContentPath(input: string): string {
  safeArchivePath(input);
  if (
    input.endsWith('/') ||
    !/^(mods|plugins|config|defaultconfigs)\//.test(input) ||
    input.split('/').some((s) => s.startsWith('.')) ||
    /\.(sh|bat|cmd|ps1|exe|dll|so|dylib|class|js|mjs|cjs|py|lua)$/i.test(input)
  )
    fail('protected_content_path');
  if (/^(mods|plugins)\//.test(input) && !/^(mods|plugins)\/[^/]+\.jar$/.test(input))
    fail('executable_path');
  if (/\.jar$/i.test(input) && !/^(mods|plugins)\//.test(input)) fail('executable_path');
  return input;
}
export function validateContentPlan(input: unknown): ContentPlan {
  const parsed = contentPlanSchema.safeParse(input);
  if (!parsed.success) fail('plan');
  const plan = parsed.data;
  const paths = new Set<string>();
  for (const item of [...plan.artifacts, ...plan.overrides]) {
    safeContentPath(item.path);
    const key = item.path.toLowerCase();
    if (paths.has(key)) fail('file_conflict');
    paths.add(key);
  }
  return plan;
}
export interface ContentHttp {
  /** Read-only metadata bulk queries (e.g. CurseForge pinned file IDs), never mutations. */
  jsonPost?(
    url: string,
    body: unknown,
    options?: { headers?: Readonly<Record<string, string>>; signal?: AbortSignal },
  ): Promise<unknown>;
  text?(
    url: string,
    options?: { headers?: Readonly<Record<string, string>>; signal?: AbortSignal },
  ): Promise<string>;
  downloadModpack?(
    artifact: import('./modpack-recipes.js').ModpackDownload,
    destination: string,
    options?: {
      signal?: AbortSignal;
      maxBytes?: number;
      /** Awaited before writing; validated Content-Length or the bounded fallback maximum. */
      onSize?: (bytes: number) => Promise<void>;
    },
  ): Promise<{ sha256: string; size: number }>;
  json(
    url: string,
    options?: { headers?: Readonly<Record<string, string>>; signal?: AbortSignal },
  ): Promise<unknown>;
  download(
    artifact: ContentArtifact,
    destination: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ sha256: string; size: number }>;
}
export interface StagedContentFile {
  path: string;
  size: number;
  sha256: string;
  source: 'download' | 'override';
  environment?: 'server' | 'client' | 'both';
}
export interface StagedContent {
  directory: string;
  planDigest: string;
  manifest: StagedContentFile[];
}
