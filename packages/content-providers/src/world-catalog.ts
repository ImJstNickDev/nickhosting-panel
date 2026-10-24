import { z } from 'zod';

/** Public catalog metadata only: provider credentials and download URLs stay on the server. */
export const worldCatalogProjectSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(512),
    summary: z.string().max(4096),
    websiteUrl: z.string().url().max(2048),
    imageUrl: z.string().url().max(2048).optional(),
    authors: z.array(z.string().max(256)).max(100),
    downloads: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type WorldCatalogProject = z.infer<typeof worldCatalogProjectSchema>;

export const worldCatalogFileSchema = z
  .object({
    id: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    name: z.string().min(1).max(512),
    filename: z.string().min(1).max(512),
    gameVersions: z.array(z.string().min(1).max(80)).max(256),
    publishedAt: z.iso.datetime({ offset: true }),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    available: z.boolean(),
  })
  .strict();
export type WorldCatalogFile = z.infer<typeof worldCatalogFileSchema>;

const pagination = {
  offset: z.number().int().min(0).max(9980),
  limit: z.literal(20),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
export const worldCatalogProjectsSchema = z
  .object({ items: z.array(worldCatalogProjectSchema).max(20), ...pagination })
  .strict();
export type WorldCatalogProjects = z.infer<typeof worldCatalogProjectsSchema>;
export const worldCatalogFilesSchema = z
  .object({ items: z.array(worldCatalogFileSchema).max(20), ...pagination })
  .strict();
export type WorldCatalogFiles = z.infer<typeof worldCatalogFilesSchema>;

/** Datapacks share catalog metadata, with explicit per-file installation limits. */
export const datapackCatalogFileSchema = worldCatalogFileSchema.extend({
  unavailableReason: z.enum(['dependencies', 'distribution', 'archive']).optional(),
});
export const datapackCatalogFilesSchema = worldCatalogFilesSchema.extend({
  items: z.array(datapackCatalogFileSchema).max(20),
});
export type DatapackCatalogFiles = z.infer<typeof datapackCatalogFilesSchema>;

const datapackDependencyRefSchema = z
  .object({
    projectId: z.string().min(1).max(128),
    versionId: z.string().min(1).max(128).optional(),
  })
  .strict();
const datapackDependencyNoticeSchema = datapackDependencyRefSchema.extend({
  name: z.string().min(1).max(512),
  requiredBy: z.string().min(1).max(128),
});
export const datapackDependencyPlanSchema = z
  .object({
    provider: z.enum(['modrinth', 'curseforge']),
    root: datapackDependencyRefSchema.extend({ versionId: z.string().min(1).max(128) }),
    gameVersion: z.string().min(1).max(80),
    items: z
      .array(
        datapackDependencyRefSchema.extend({
          versionId: z.string().min(1).max(128),
          name: z.string().min(1).max(512),
          filename: z.string().min(1).max(512),
          required: z.array(datapackDependencyRefSchema).max(512),
          conflicts: z.array(datapackDependencyRefSchema).max(512),
        }),
      )
      .max(512),
    optional: z.array(datapackDependencyNoticeSchema).max(512),
    embedded: z.array(datapackDependencyNoticeSchema).max(512),
    blocked: z
      .array(
        datapackDependencyNoticeSchema.extend({
          reason: z.enum([
            'mod',
            'incompatible-version',
            'unavailable',
            'unresolved',
            'version-conflict',
            'conflict',
          ]),
        }),
      )
      .max(512),
  })
  .strict();
export type DatapackDependencyPlan = z.infer<typeof datapackDependencyPlanSchema>;
