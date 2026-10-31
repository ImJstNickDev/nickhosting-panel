import type { z } from 'zod';
import type { FabricCatalogStatus } from './fabric-catalog.js';
import { createFillCatalog } from './fill-catalog.js';
import { foliaJavaMajor } from './folia-policy.js';

const catalog = createFillCatalog('folia', foliaJavaMajor);
export const foliaCatalogUrl = catalog.catalogUrl;
export const foliaCatalogSnapshotSchema = catalog.catalogSnapshotSchema;
export const fetchFoliaCatalog = catalog.fetchCatalog;
export const foliaCatalogMetadataClient = catalog.catalogMetadataClient;
export type FoliaCatalogSnapshot = z.infer<typeof foliaCatalogSnapshotSchema>;
export type FetchFoliaCatalogOptions = NonNullable<Parameters<typeof fetchFoliaCatalog>[1]>;
export interface FoliaCatalogResponse {
  versions: FoliaCatalogSnapshot['versions'];
  status: FabricCatalogStatus;
  synced: boolean;
}
