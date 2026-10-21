import { z } from 'zod';

/** Browser-safe metadata. Download locations, credentials and provider recipes stay on the server. */
export const modpackProviderSchema = z.enum([
  'modrinth',
  'curseforge',
  'ftb',
  'technic',
  'voidswrath',
  'atlauncher',
]);
export type ModpackProvider = z.infer<typeof modpackProviderSchema>;
const identity = z.string().min(1).max(256);
export const modpackTargetSchema = z
  .object({
    minecraftVersion: z.string().min(1).max(64),
    loader: z.enum(['vanilla', 'paper', 'folia', 'fabric', 'forge', 'neoforge', 'quilt']),
    loaderVersion: z.string().min(1).max(128).optional(),
  })
  .strict();
export const modpackUnavailableReasonSchema = z.enum([
  'client-only',
  'distribution',
  'runtime',
  'permission',
  'unresolved',
  'server-pack',
]);
export type ModpackUnavailableReason = z.infer<typeof modpackUnavailableReasonSchema>;
export const modpackSourceSchema = z.enum([
  'modrinth-index',
  'curseforge-manifest',
  'server-archive',
  'ftb-manifest',
  'technic-solder',
  'atlauncher-recipe',
]);
export const modpackCatalogProjectSchema = z
  .object({
    id: identity,
    provider: modpackProviderSchema,
    name: z.string().min(1).max(512),
    summary: z.string().max(4096),
    websiteUrl: z.string().url().max(2048),
    imageUrl: z.string().url().max(2048).optional(),
    authors: z.array(z.string().max(256)).max(100),
    downloads: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export type ModpackCatalogProject = z.infer<typeof modpackCatalogProjectSchema>;
export const modpackCatalogDetailsSchema = modpackCatalogProjectSchema.extend({
  description: z.string().max(512 * 1024),
  descriptionFormat: z.enum(['markdown', 'html', 'text']),
});
export type ModpackCatalogDetails = z.infer<typeof modpackCatalogDetailsSchema>;
export const modpackCatalogVersionSchema = z
  .object({
    id: identity,
    projectId: identity,
    name: z.string().min(1).max(512),
    version: z.string().min(1).max(256),
    minecraftVersions: z.array(z.string().min(1).max(64)).max(256),
    loaders: z.array(z.string().min(1).max(64)).max(16),
    channel: z.enum(['release', 'beta', 'alpha', 'unknown']),
    publishedAt: z.iso.datetime({ offset: true }).optional(),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    available: z.boolean(),
    unavailableReason: modpackUnavailableReasonSchema.optional(),
    source: modpackSourceSchema,
    target: modpackTargetSchema.optional(),
  })
  .strict();
export type ModpackCatalogVersion = z.infer<typeof modpackCatalogVersionSchema>;
const page = {
  offset: z.number().int().min(0).max(9980),
  limit: z.number().int().min(1).max(50),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
export const modpackCatalogProjectsSchema = z
  .object({
    items: z.array(modpackCatalogProjectSchema).max(50),
    ...page,
  })
  .strict();
export type ModpackCatalogProjects = z.infer<typeof modpackCatalogProjectsSchema>;
export const modpackCatalogVersionsSchema = z
  .object({
    items: z.array(modpackCatalogVersionSchema).max(50),
    ...page,
  })
  .strict();
export type ModpackCatalogVersions = z.infer<typeof modpackCatalogVersionsSchema>;

export const modpackCategoryIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const modpackCatalogCategoriesSchema = z
  .object({
    items: z
      .array(z.object({ id: modpackCategoryIdSchema, name: z.string().min(1).max(256) }).strict())
      .max(1000),
  })
  .strict();
export type ModpackCatalogCategories = z.infer<typeof modpackCatalogCategoriesSchema>;

export interface ModpackCatalogSearchInput {
  category?: string;
  query?: string;
  offset?: number;
  limit?: number;
}
export interface ModpackCatalogPageInput {
  offset?: number;
  limit?: number;
}
