import { z } from 'zod';
import { type ContentHttp, fail } from './contracts.js';
import {
  type ModpackCatalogPageInput,
  type ModpackCatalogSearchInput,
  modpackCatalogDetailsSchema,
  modpackCatalogProjectsSchema,
  modpackCatalogVersionsSchema,
} from './modpack-catalog.js';
import {
  identifier,
  ModpackMetadataClient,
  publicUrl,
  published,
  queryInput,
  slicePage,
  str,
} from './modpack-catalog-common.js';
import type { ModpackCatalog, ModpackRecipe } from './modpack-recipes.js';

const versionSchema = z.object({
  version: str,
  minecraft: str.optional(),
  minecraftVersion: str.optional(),
  published: z.number().optional(),
  recommended: z.boolean().optional(),
});
const projectSchema = z.object({
  id: z.number().int().positive(),
  name: str,
  safeName: str,
  description: str.default(''),
  type: str.default('public'),
  websiteURL: str.nullable().optional(),
  versions: z.array(versionSchema).max(10000).default([]),
  authors: z.array(str).default([]),
  image: str.optional(),
});
export class AtLauncherModpackCatalog implements ModpackCatalog {
  readonly provider = 'atlauncher' as const;
  private readonly client: ModpackMetadataClient;
  constructor(http: ContentHttp) {
    this.client = new ModpackMetadataClient(http);
  }
  private async data(path: string, signal?: AbortSignal) {
    const result = z
      .object({ error: z.boolean(), data: z.unknown() })
      .parse(await this.client.json(`https://api.atlauncher.com/v1${path}`, signal));
    if (result.error) fail('modpack_metadata');
    return result.data;
  }
  private publicProject(p: z.infer<typeof projectSchema>) {
    return {
      id: p.safeName,
      provider: this.provider,
      name: p.name,
      summary: p.description.slice(0, 4096),
      websiteUrl: `https://atlauncher.com/pack/${encodeURIComponent(p.safeName)}`,
      authors: p.authors,
      imageUrl: publicUrl(p.image),
    };
  }
  private async project(id: string, signal?: AbortSignal) {
    identifier(id);
    // The full public catalog includes descriptions omitted by the single-pack endpoint.
    // Reuse that cached snapshot for details and version lists, without per-card HTTP calls.
    const packs = z
      .array(projectSchema)
      .max(5000)
      .parse(await this.data('/packs/full/public', signal));
    const p = packs.find((p) => p.safeName === id && p.type === 'public');
    if (!p) fail('modpack_identity');
    return p;
  }
  async search(input: ModpackCatalogSearchInput = {}, signal?: AbortSignal) {
    const query = queryInput(input.query).toLocaleLowerCase();
    const packs = z
      .array(projectSchema)
      .max(5000)
      .parse(await this.data('/packs/full/public', signal));
    return modpackCatalogProjectsSchema.parse(
      slicePage(
        packs
          .filter(
            (p) =>
              p.type === 'public' &&
              `${p.name} ${p.description}`.toLocaleLowerCase().includes(query),
          )
          .map((p) => this.publicProject(p)),
        input,
      ),
    );
  }
  async details(id: string, signal?: AbortSignal) {
    const p = await this.project(id, signal);
    return modpackCatalogDetailsSchema.parse({
      ...this.publicProject(p),
      description: p.description,
      descriptionFormat: 'html',
    });
  }
  async versions(id: string, input: ModpackCatalogPageInput = {}, signal?: AbortSignal) {
    const p = await this.project(id, signal);
    return modpackCatalogVersionsSchema.parse(
      slicePage(
        [...p.versions]
          .sort((a, b) => (b.published ?? 0) - (a.published ?? 0))
          .map((v) => ({
            id: v.version,
            projectId: id,
            name: v.version,
            version: v.version,
            minecraftVersions:
              (v.minecraft ?? v.minecraftVersion) ? [v.minecraft ?? v.minecraftVersion] : [],
            loaders: [],
            channel: v.recommended ? 'release' : 'unknown',
            publishedAt: published(v.published),
            available: false,
            unavailableReason: 'permission',
            source: 'atlauncher-recipe',
          })),
        input,
      ),
    );
  }
  async resolve(id: string, versionId: string, signal?: AbortSignal): Promise<ModpackRecipe> {
    const [project, p] = await Promise.all([this.details(id, signal), this.project(id, signal)]);
    const index = [...p.versions]
      .sort((a, b) => (b.published ?? 0) - (a.published ?? 0))
      .findIndex((v) => v.version === versionId);
    if (index < 0) fail('modpack_identity');
    const version = (await this.versions(id, { offset: index, limit: 1 }, signal)).items[0];
    if (!version) fail('modpack_identity');
    // Public metadata permission does not authorize reuse of the launcher CDN.
    // Deliberately never fetch Configs.json/archives until that permission is resolved.
    return { provider: this.provider, project, version, kind: 'unavailable', reason: 'permission' };
  }
}
