import type { ContentTarget } from './contracts.js';
import type {
  ModpackCatalogCategories,
  ModpackCatalogDetails,
  ModpackCatalogPageInput,
  ModpackCatalogProjects,
  ModpackCatalogSearchInput,
  ModpackCatalogVersion,
  ModpackCatalogVersions,
  ModpackProvider,
  ModpackUnavailableReason,
} from './modpack-catalog.js';

/** Backend-only provider download. Unknown size/hash is explicit; staging must bound and seal it. */
export interface ModpackDownload {
  filename: string;
  urls: string[];
  size?: number;
  hashes: { md5?: string; sha1?: string; sha256?: string; sha512?: string };
}
export interface ModpackRecipeFile {
  path: string;
  download: ModpackDownload;
  serverSide: 'required' | 'optional' | 'unknown';
  optional?: boolean;
}
interface ModpackRecipeIdentity {
  provider: ModpackProvider;
  project: ModpackCatalogDetails;
  version: ModpackCatalogVersion;
}
export type ModpackRecipe = ModpackRecipeIdentity &
  (
    | {
        kind: 'archive';
        format: 'modrinth-index' | 'curseforge-manifest' | 'server-archive';
        download: ModpackDownload;
        target?: ContentTarget;
        /** Publisher declares this configuration archive already relative to the server root. */
        preserveRoot?: true;
        /** Exact server-side files declared alongside a configuration archive. */
        files?: ModpackRecipeFile[];
        /** Exact companion client archive supplies requirements, never client files. */
        targetManifest?: { format: 'curseforge-manifest'; download: ModpackDownload };
      }
    | {
        kind: 'files';
        target: ContentTarget;
        files: ModpackRecipeFile[];
        warnings: string[];
        javaVersion?: string;
        memoryMiB?: number;
      }
    | { kind: 'unavailable'; reason: ModpackUnavailableReason }
  );
export interface ModpackCatalog {
  readonly provider: ModpackProvider;
  categories?(signal?: AbortSignal): Promise<ModpackCatalogCategories>;
  search(input?: ModpackCatalogSearchInput, signal?: AbortSignal): Promise<ModpackCatalogProjects>;
  details(projectId: string, signal?: AbortSignal): Promise<ModpackCatalogDetails>;
  versions(
    projectId: string,
    input?: ModpackCatalogPageInput,
    signal?: AbortSignal,
  ): Promise<ModpackCatalogVersions>;
  resolve(projectId: string, versionId: string, signal?: AbortSignal): Promise<ModpackRecipe>;
}
