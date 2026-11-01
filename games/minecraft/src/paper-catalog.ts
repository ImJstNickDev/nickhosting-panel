import type { z } from 'zod';
import type { FabricCatalogStatus } from './fabric-catalog.js';
import { createFillCatalog } from './fill-catalog.js';
import { paperJavaMajor } from './paper-policy.js';

const catalog = createFillCatalog('paper', paperJavaMajor);
export const paperCatalogUrl = catalog.catalogUrl;
export const paperCatalogSnapshotSchema = catalog.catalogSnapshotSchema;
export const fetchPaperCatalog = catalog.fetchCatalog;
export const paperCatalogMetadataClient = catalog.catalogMetadataClient;
export type PaperCatalogSnapshot = z.infer<typeof paperCatalogSnapshotSchema>;
export type FetchPaperCatalogOptions = NonNullable<Parameters<typeof fetchPaperCatalog>[1]>;
export interface PaperCatalogResponse {
  versions: PaperCatalogSnapshot['versions'];
  status: FabricCatalogStatus;
  synced: boolean;
}
