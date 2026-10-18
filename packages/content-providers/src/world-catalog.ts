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
