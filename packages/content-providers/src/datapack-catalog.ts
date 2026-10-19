import { z } from 'zod';
import { worldCatalogFileSchema, worldCatalogFilesSchema } from './world-catalog.js';

/** Catalog receipts never contain credentials or signed download URLs. */
export const datapackCatalogFileSchema = worldCatalogFileSchema.extend({
  unavailableReason: z.enum(['dependencies', 'distribution', 'archive']).optional(),
});
export const datapackCatalogFilesSchema = worldCatalogFilesSchema.extend({
  items: z.array(datapackCatalogFileSchema).max(20),
});
export type DatapackCatalogFiles = z.infer<typeof datapackCatalogFilesSchema>;
