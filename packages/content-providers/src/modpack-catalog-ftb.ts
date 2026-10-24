import { z } from 'zod';
import { type ContentHttp, type ContentTarget, fail, safeArchivePath } from './contracts.js';
import {
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
  numericId,
  pageInput,
  providerChannel,
  publicUrl,
  published,
  queryInput,
  slicePage,
  str,
} from './modpack-catalog-common.js';
import type { ModpackCatalog, ModpackRecipe, ModpackRecipeFile } from './modpack-recipes.js';

const targets = z.array(z.object({ name: str, type: str, version: str })).max(32);
const versionSchema = z.object({
  id: numericId,
  name: str,
  type: str,
  private: z.boolean().default(false),
  released: z.number().optional(),
  updated: z.number().optional(),
  targets: targets.default([]),
  specs: z
    .object({ minimum: z.number().nonnegative(), recommended: z.number().nonnegative() })
    .optional(),
});
const projectSchema = z.object({
  id: numericId,
  name: str,
  synopsis: str.default(''),
  slug: str.optional(),
  description: str.default(''),
  private: z.boolean().default(false),
  installs: z.number().nonnegative().optional(),
  authors: z
    .array(z.object({ name: str }))
    .max(100)
    .default([]),
  art: z
    .array(z.object({ type: str, url: str }))
    .max(100)
    .default([]),
  versions: z.array(versionSchema).max(10000).default([]),
});
type Version = z.infer<typeof versionSchema>;
function targetOf(list: z.infer<typeof targets>): ContentTarget | undefined {
  const games = list.filter((t) => t.type === 'game' && t.name === 'minecraft');
  const loaders = list.filter((t) => t.type === 'modloader');
  if (games.length !== 1 || loaders.length > 1) return undefined;
  const game = games[0];
  const loader = loaders[0];
  if (!game) return undefined;
  if (!loader) return { minecraftVersion: game.version, loader: 'vanilla' };
  const name = loader.name.toLowerCase();
  if (!['fabric', 'forge', 'neoforge', 'quilt', 'paper', 'folia'].includes(name)) return undefined;
  return {
    minecraftVersion: game.version,
    loader: name as ContentTarget['loader'],
    loaderVersion: loader.version,
  };
}
function versionItem(projectId: string, version: Version): ModpackCatalogVersion {
  const target = targetOf(version.targets);
  return {
    id: String(version.id),
    projectId,
    name: version.name,
    version: version.name,
    minecraftVersions: target ? [target.minecraftVersion] : [],
    loaders: target ? [target.loader] : [],
    channel: providerChannel(version.type),
    publishedAt: published(version.released ?? version.updated),
    source: 'ftb-manifest',
    available: !version.private,
    ...(version.private ? { unavailableReason: 'permission' as const } : {}),
    ...(target ? { target } : {}),
  };
}
export class FtbModpackCatalog implements ModpackCatalog {
  readonly provider = 'ftb' as const;
  private readonly client: ModpackMetadataClient;
  private readonly base = 'https://api.feed-the-beast.com/v1/modpacks/modpack';
  constructor(http: ContentHttp) {
    this.client = new ModpackMetadataClient(http);
  }
  private async project(id: string, signal?: AbortSignal) {
    const p = projectSchema.parse(await this.client.json(`${this.base}/${identifier(id)}`, signal));
    if (String(p.id) !== id || p.private) fail('modpack_identity');
    return p;
  }
  private publicProject(p: z.infer<typeof projectSchema>) {
    return {
      id: String(p.id),
      provider: this.provider,
      name: p.name,
      summary: p.synopsis,
      websiteUrl: `https://www.feed-the-beast.com/modpacks/${p.id}${p.slug ? `-${encodeURIComponent(p.slug)}` : ''}`,
      authors: p.authors.map((a) => a.name),
      downloads: p.installs,
      imageUrl: publicUrl(p.art.find((a) => a.type === 'square')?.url),
    };
  }
  async search(input: ModpackCatalogSearchInput = {}, signal?: AbortSignal) {
    const { offset, limit } = pageInput(input);
    const query = queryInput(input.query);
    // FTB rejects an empty search term. Its app browses the public ID catalogue,
    // then reads only visible packs; these records are shared with details/versions.
    if (!query) {
      const raw = z
        .object({ packs: z.array(numericId).max(1000) })
        .parse(await this.client.json(`${this.base}/all`, signal));
      const ids = [...new Set(raw.packs)];
      const page = ids.slice(offset, offset + limit);
      const items = [];
      for (let index = 0; index < page.length; index += 4) {
        signal?.throwIfAborted();
        items.push(
          ...(await Promise.all(
            page
              .slice(index, index + 4)
              .map(async (id) => this.publicProject(await this.project(String(id), signal))),
          )),
        );
      }
      return modpackCatalogProjectsSchema.parse({ items, offset, limit, total: ids.length });
    }
    const raw = z
      .object({ packs: z.array(projectSchema).max(1000) })
      .parse(
        await this.client.json(
          `${this.base}/search/1000/detailed/?${new URLSearchParams({ term: query, platform: 'ftb' })}`,
          signal,
        ),
      );
    return modpackCatalogProjectsSchema.parse(
      slicePage(
        raw.packs.filter((p) => !p.private).map((p) => this.publicProject(p)),
        { offset, limit },
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
        p.versions
          .filter((v) => !v.private)
          .sort((a, b) => b.id - a.id)
          .map((v) => versionItem(id, v)),
        input,
      ),
    );
  }
  async resolve(id: string, versionId: string, signal?: AbortSignal): Promise<ModpackRecipe> {
    const [project, p] = await Promise.all([this.details(id, signal), this.project(id, signal)]);
    const known = p.versions.find((v) => String(v.id) === versionId && !v.private);
    if (!known) fail('modpack_identity');
    const manifest = versionSchema
      .extend({
        files: z
          .array(
            z.object({
              name: str,
              path: str,
              url: str,
              size: z.number().int().nonnegative(),
              sha1: str.optional(),
              hashes: z
                .object({ sha1: str.optional(), sha256: str.optional(), sha512: str.optional() })
                .optional(),
              clientonly: z.boolean(),
              serveronly: z.boolean().default(false),
              optional: z.boolean().default(false),
            }),
          )
          .max(20000),
      })
      .parse(
        await this.client.json(`${this.base}/${identifier(id)}/${identifier(versionId)}`, signal),
      );
    if (String(manifest.id) !== versionId || manifest.private) fail('modpack_identity');
    const target = targetOf(manifest.targets);
    const version = versionItem(id, manifest);
    if (!target)
      return { provider: this.provider, project, version, kind: 'unavailable', reason: 'runtime' };
    const files: ModpackRecipeFile[] = [];
    const paths = new Set<string>();
    for (const file of manifest.files) {
      if (file.clientonly) continue;
      // FTB intentionally uses ./ at the start; no other alias/traversal is accepted.
      const prefix = file.path.replace(/^\.\//, '');
      const path = safeArchivePath(
        `${prefix}${prefix && !prefix.endsWith('/') ? '/' : ''}${file.name}`,
      );
      if (paths.has(path.toLowerCase())) fail('modpack_file_conflict');
      paths.add(path.toLowerCase());
      const hashes = { ...(file.sha1 ? { sha1: file.sha1 } : {}), ...file.hashes };
      if (!Object.keys(hashes).length) fail('modpack_hash');
      files.push({
        path,
        download: download({ filename: file.name, urls: [file.url], size: file.size, hashes }),
        serverSide: file.optional ? 'optional' : 'required',
        ...(file.optional ? { optional: true } : {}),
      });
    }
    return {
      provider: this.provider,
      project,
      version,
      kind: 'files',
      target,
      files,
      warnings: [],
      javaVersion: manifest.targets.find((t) => t.type === 'runtime' && t.name === 'java')?.version,
      memoryMiB: manifest.specs?.recommended,
    };
  }
}
