import { z } from 'zod';
import { type ContentHttp, fail } from './contracts.js';
import {
  type ModpackCatalogDetails,
  type ModpackCatalogPageInput,
  type ModpackCatalogSearchInput,
  type ModpackCatalogVersion,
  modpackCatalogDetailsSchema,
  modpackCatalogProjectsSchema,
  modpackCatalogVersionsSchema,
} from './modpack-catalog.js';
import {
  download,
  identifier,
  ModpackMetadataClient,
  pageInput,
  providerChannel,
  publicUrl,
  published,
  queryInput,
  slicePage,
  str,
  strings,
} from './modpack-catalog-common.js';
import type { ModpackCatalog, ModpackRecipe } from './modpack-recipes.js';

const projectSchema = z.object({
  id: str,
  slug: str,
  title: str,
  description: str,
  body: str.default(''),
  project_type: z.literal('modpack'),
  icon_url: str.nullable().optional(),
  downloads: z.number().nonnegative(),
  client_side: str.optional(),
  server_side: str.optional(),
  team: str.optional(),
});
const versionSchema = z.object({
  id: str,
  project_id: str,
  name: str,
  version_number: str,
  game_versions: strings,
  loaders: strings,
  date_published: str,
  version_type: str,
  files: z
    .array(
      z.object({
        url: str,
        filename: str,
        size: z.number().int().nonnegative(),
        primary: z.boolean(),
        hashes: z
          .object({ sha1: str.optional(), sha512: str.optional() })
          .refine((h) => !!h.sha1 || !!h.sha512),
      }),
    )
    .max(100),
});
type Version = z.infer<typeof versionSchema>;
function archive(version: Version) {
  const files = version.files.filter((f) => /\.mrpack$/i.test(f.filename));
  const selected = files.filter((f) => f.primary);
  const file = selected.length === 1 ? selected[0] : files.length === 1 ? files[0] : undefined;
  return file
    ? download({ filename: file.filename, urls: [file.url], size: file.size, hashes: file.hashes })
    : undefined;
}
function versionItem(version: Version, clientOnly: boolean): ModpackCatalogVersion {
  const file = archive(version);
  return {
    id: version.id,
    projectId: version.project_id,
    name: version.name,
    version: version.version_number,
    minecraftVersions: version.game_versions,
    loaders: version.loaders,
    channel: providerChannel(version.version_type),
    publishedAt: published(version.date_published),
    bytes: file?.size,
    available: !!file && !clientOnly,
    ...(!file
      ? { unavailableReason: 'distribution' as const }
      : clientOnly
        ? { unavailableReason: 'client-only' as const }
        : {}),
    source: 'modrinth-index',
  };
}
export class ModrinthModpackCatalog implements ModpackCatalog {
  readonly provider = 'modrinth' as const;
  private readonly client: ModpackMetadataClient;
  constructor(http: ContentHttp) {
    this.client = new ModpackMetadataClient(http);
  }
  private project(id: string, signal?: AbortSignal) {
    return this.client
      .json(`https://api.modrinth.com/v2/project/${identifier(id)}`, signal)
      .then(projectSchema.parse);
  }
  async search(input: ModpackCatalogSearchInput = {}, signal?: AbortSignal) {
    const { offset, limit } = pageInput(input);
    const params = new URLSearchParams({
      query: queryInput(input.query),
      offset: String(offset),
      limit: String(limit),
      facets: JSON.stringify([['project_type:modpack']]),
    });
    const result = z
      .object({
        hits: z
          .array(
            z.object({
              project_id: str,
              slug: str,
              title: str,
              description: str,
              author: str,
              icon_url: str.nullable().optional(),
              downloads: z.number().nonnegative(),
            }),
          )
          .max(50),
        total_hits: z.number().int().nonnegative(),
      })
      .parse(await this.client.json(`https://api.modrinth.com/v2/search?${params}`, signal));
    return modpackCatalogProjectsSchema.parse({
      offset,
      limit,
      total: result.total_hits,
      items: result.hits.map((p) => ({
        id: p.project_id,
        provider: this.provider,
        name: p.title,
        summary: p.description,
        websiteUrl: `https://modrinth.com/modpack/${encodeURIComponent(p.slug)}`,
        imageUrl: publicUrl(p.icon_url),
        authors: [p.author],
        downloads: p.downloads,
      })),
    });
  }
  async details(id: string, signal?: AbortSignal): Promise<ModpackCatalogDetails> {
    const p = await this.project(id, signal);
    return modpackCatalogDetailsSchema.parse({
      id: p.id,
      provider: this.provider,
      name: p.title,
      summary: p.description,
      websiteUrl: `https://modrinth.com/modpack/${encodeURIComponent(p.slug)}`,
      imageUrl: publicUrl(p.icon_url),
      authors: [],
      downloads: p.downloads,
      description: p.body,
      descriptionFormat: 'markdown',
    });
  }
  async versions(id: string, input: ModpackCatalogPageInput = {}, signal?: AbortSignal) {
    const [p, raw] = await Promise.all([
      this.project(id, signal),
      this.client.json(`https://api.modrinth.com/v2/project/${identifier(id)}/version`, signal),
    ]);
    const list = z.array(versionSchema).max(10000).parse(raw);
    if (list.some((v) => v.project_id !== p.id)) fail('modpack_identity');
    return modpackCatalogVersionsSchema.parse(
      slicePage(
        list.map((v) => versionItem(v, p.server_side === 'unsupported')),
        input,
      ),
    );
  }
  async resolve(id: string, versionId: string, signal?: AbortSignal): Promise<ModpackRecipe> {
    const [project, raw, p] = await Promise.all([
      this.details(id, signal),
      this.client.json(`https://api.modrinth.com/v2/version/${identifier(versionId)}`, signal),
      this.project(id, signal),
    ]);
    const selected = versionSchema.parse(raw);
    if (selected.project_id !== project.id || selected.id !== versionId) fail('modpack_identity');
    const version = versionItem(selected, p.server_side === 'unsupported');
    const source = archive(selected);
    if (!source || !version.available)
      return {
        provider: this.provider,
        project,
        version,
        kind: 'unavailable',
        reason: version.unavailableReason ?? 'distribution',
      };
    return {
      provider: this.provider,
      project,
      version,
      kind: 'archive',
      format: 'modrinth-index',
      download: source,
    };
  }
}
