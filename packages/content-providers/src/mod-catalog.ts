import { z } from 'zod';

/** Browser-safe catalog contract. Provider secrets and artifact URLs never enter this module. */
export const modProviderSchema = z.enum(['modrinth', 'curseforge']);
export type ModProvider = z.infer<typeof modProviderSchema>;
const identifier = z.string().min(1).max(128);
export const modEnvironmentSchema = z
  .object({
    kind: z.enum(['server', 'client', 'both', 'unknown']),
    detail: z
      .enum([
        'dedicated-server',
        'singleplayer',
        'client-optional',
        'server-optional',
        'either',
        'prefers-both',
      ])
      .optional(),
    source: z.enum(['modrinth', 'curseforge', 'archive', 'unknown']),
    original: z.array(z.string().max(128)).max(32),
  })
  .strict();
export type ModEnvironment = z.infer<typeof modEnvironmentSchema>;
export const modTagSchema = z
  .object({
    id: identifier,
    label: z.string().min(1).max(128),
    source: modProviderSchema,
    original: z.string().max(128),
  })
  .strict();
export type ModTag = z.infer<typeof modTagSchema>;
export const modCatalogProjectSchema = z
  .object({
    provider: modProviderSchema,
    id: identifier,
    name: z.string().min(1).max(512),
    summary: z.string().max(4096),
    websiteUrl: z.string().url().max(2048),
    imageUrl: z.string().url().max(2048).optional(),
    authors: z.array(z.string().max(256)).max(100),
    downloads: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tags: z.array(modTagSchema).max(100),
    environment: modEnvironmentSchema,
  })
  .strict();
export type ModCatalogProject = z.infer<typeof modCatalogProjectSchema>;
export const modCatalogDetailsSchema = modCatalogProjectSchema.extend({
  description: z.string().max(2 * 1024 * 1024),
  descriptionFormat: z.enum(['markdown', 'html']),
});
export type ModCatalogDetails = z.infer<typeof modCatalogDetailsSchema>;
export const modCompatibilityIssueSchema = z.enum([
  'minecraft-version',
  'loader',
  'client-only',
  'singleplayer-only',
]);
export type ModCompatibilityIssue = z.infer<typeof modCompatibilityIssueSchema>;
export const modCatalogVersionSchema = z
  .object({
    provider: modProviderSchema,
    id: identifier,
    projectId: identifier,
    name: z.string().min(1).max(512),
    version: z.string().min(1).max(512),
    filename: z.string().min(1).max(512),
    gameVersions: z.array(z.string().max(80)).max(10000),
    loaders: z.array(z.string().max(80)).max(100),
    publishedAt: z.iso.datetime({ offset: true }),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    channel: z.enum(['release', 'beta', 'alpha']),
    available: z.boolean(),
    unavailableReason: z.enum(['distribution', 'artifact']).optional(),
    compatibility: z.array(modCompatibilityIssueSchema).max(4),
    environment: modEnvironmentSchema,
  })
  .strict();
export type ModCatalogVersion = z.infer<typeof modCatalogVersionSchema>;
const pagination = {
  offset: z.number().int().min(0).max(9980),
  limit: z.literal(20),
  total: z.number().int().nonnegative(),
};
export const modCatalogProjectsSchema = z
  .object({ items: z.array(modCatalogProjectSchema).max(20), ...pagination })
  .strict();
export type ModCatalogProjects = z.infer<typeof modCatalogProjectsSchema>;
export const modCatalogVersionsSchema = z
  .object({
    items: z.array(modCatalogVersionSchema).max(20),
    ...pagination,
    recommendedId: identifier.optional(),
  })
  .strict();
export type ModCatalogVersions = z.infer<typeof modCatalogVersionsSchema>;
export const modSelectionSchema = z
  .object({
    projectId: identifier,
    versionId: identifier.optional(),
    forceIncompatible: z.boolean().default(false),
    optionalProjectIds: z.array(identifier).max(512).default([]),
  })
  .strict();
export type ModSelection = z.infer<typeof modSelectionSchema>;
const refSchema = z
  .object({ provider: modProviderSchema, projectId: identifier, versionId: identifier.optional() })
  .strict();
export const modResolutionItemSchema = z
  .object({
    project: modCatalogProjectSchema,
    version: modCatalogVersionSchema,
    requiredBy: z.array(identifier).max(512),
    root: z.boolean(),
    forced: z.boolean(),
    dependencies: z.array(refSchema).max(512),
    conflicts: z.array(refSchema).max(512),
  })
  .strict();
export type ModResolutionItem = z.infer<typeof modResolutionItemSchema>;
const noticeSchema = refSchema.extend({ name: z.string().max(512), requiredBy: identifier });
export const modResolutionSchema = z
  .object({
    items: z.array(modResolutionItemSchema).max(512),
    optional: z.array(noticeSchema).max(512),
    embedded: z.array(noticeSchema).max(512),
    blocked: z
      .array(
        noticeSchema.extend({
          reason: z.enum([
            'unavailable',
            'unresolved',
            'incompatible-version',
            'version-conflict',
            'conflict',
          ]),
        }),
      )
      .max(512),
  })
  .strict();
export type ModResolution = z.infer<typeof modResolutionSchema>;
