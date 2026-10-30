import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type ContentHttp, type ContentTarget, fail } from './contracts.js';
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
  downloadUrl,
  identifier,
  ModpackMetadataClient,
  pageInput,
  publicUrl,
  queryInput,
  slicePage,
  str,
  strings,
} from './modpack-catalog-common.js';
import type { ModpackCatalog, ModpackRecipe } from './modpack-recipes.js';

const projectSchema = z.object({
  id: z.number().int().positive(),
  name: str,
  displayName: str,
  user: str,
  platformUrl: str,
  description: str.default(''),
  minecraft: str,
  version: str,
  installs: z.number().nonnegative().optional(),
  solder: str.nullable().optional(),
  serverPackUrl: str.nullable().optional(),
  icon: z.object({ url: str }).nullable().optional(),
});
const solderSchema = z.object({ name: str, recommended: str, latest: str, builds: strings });
function matchesBuild(url: string | null | undefined, build: string): boolean {
  if (!url) return false;
  const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
  return new RegExp(
    `(?:^|[^A-Za-z0-9.])${build.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^A-Za-z0-9.]|\\.zip$|$)`,
    'i',
  ).test(name);
}
export class TechnicModpackCatalog implements ModpackCatalog {
  readonly provider = 'technic' as const;
  private readonly client: ModpackMetadataClient;
  constructor(http: ContentHttp) {
    this.client = new ModpackMetadataClient(http);
  }
  private async build(signal?: AbortSignal) {
    const result = z
      .object({ build: z.union([z.number().int().positive(), str]) })
      .parse(
        await this.client.json('https://api.technicpack.net/launcher/version/stable4', signal),
      );
    return String(result.build);
  }
  private async project(id: string, signal?: AbortSignal) {
    const p = projectSchema.parse(
      await this.client.json(
        `https://api.technicpack.net/modpack/${identifier(id)}?build=${encodeURIComponent(await this.build(signal))}`,
        signal,
      ),
    );
    if (p.name !== id) fail('modpack_identity');
    return p;
  }
  private solderBase(p: z.infer<typeof projectSchema>) {
    if (!p.solder) return undefined;
    // SafeContentHttp additionally enforces the configured exact origin and public DNS.
    return `${downloadUrl(p.solder).replace(/\/$/, '')}/modpack/${identifier(p.name)}`;
  }
  private publicProject(p: z.infer<typeof projectSchema>) {
    return {
      id: p.name,
      provider: this.provider,
      name: p.displayName,
      summary: p.description.slice(0, 4096),
      websiteUrl: publicUrl(p.platformUrl),
      imageUrl: publicUrl(p.icon?.url),
      authors: [p.user],
      downloads: p.installs,
    };
  }
  async search(input: ModpackCatalogSearchInput = {}, signal?: AbortSignal) {
    const query = queryInput(input.query);
    if (!query) {
      // The official launcher discovers featured packs from its public Solder
      // catalogue; the Platform search endpoint requires a nonempty query.
      const raw = z
        .object({ modpacks: z.record(str, z.object({ name: str })) })
        .parse(
          await this.client.json('https://solder.technicpack.net/api/modpack?include=full', signal),
        );
      const ids = Object.entries(raw.modpacks).map(([id, pack]) => {
        if (id !== pack.name) fail('modpack_identity');
        return id;
      });
      if (ids.length > 1000) fail('modpack_metadata_limit');
      const { offset, limit } = pageInput(input);
      const page = ids.slice(offset, offset + limit);
      const items = [];
      for (let index = 0; index < page.length; index += 4) {
        signal?.throwIfAborted();
        items.push(
          ...(await Promise.all(
            page
              .slice(index, index + 4)
              .map(async (id) => this.publicProject(await this.project(id, signal))),
          )),
        );
      }
      return modpackCatalogProjectsSchema.parse({ items, offset, limit, total: ids.length });
    }
    const params = new URLSearchParams({
      q: query,
      build: await this.build(signal),
    });
    const result = z
      .object({
        modpacks: z
          .array(
            z.object({
              id: str,
              name: str,
              slug: str,
              url: str,
              iconUrl: str.nullable().optional(),
            }),
          )
          .max(1000),
      })
      .parse(await this.client.json(`https://api.technicpack.net/search?${params}`, signal));
    return modpackCatalogProjectsSchema.parse(
      slicePage(
        result.modpacks.map((p) => ({
          id: p.slug,
          provider: this.provider,
          name: p.name,
          summary: '',
          websiteUrl: publicUrl(p.url),
          imageUrl: publicUrl(p.iconUrl),
          authors: [],
        })),
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
  private async allVersions(id: string, signal?: AbortSignal): Promise<ModpackCatalogVersion[]> {
    const p = await this.project(id, signal);
    const base = this.solderBase(p);
    if (!base)
      return [
        {
          id: `${p.version}--${createHash('sha256')
            .update(p.serverPackUrl ?? '')
            .digest('hex')
            .slice(0, 16)}`,
          projectId: id,
          name: p.displayName,
          version: p.version,
          minecraftVersions: [p.minecraft],
          loaders: [],
          channel: 'unknown',
          source: 'server-archive',
          available: !!p.serverPackUrl,
          ...(!p.serverPackUrl ? { unavailableReason: 'server-pack' as const } : {}),
        },
      ];
    const solder = solderSchema.parse(await this.client.json(base, signal));
    if (solder.name !== id) fail('modpack_identity');
    const builds = [...solder.builds].sort((a, b) =>
      a === solder.recommended
        ? -1
        : b === solder.recommended
          ? 1
          : b.localeCompare(a, 'en', { numeric: true }),
    );
    return builds.map((build) => ({
      id: build,
      projectId: id,
      name: build,
      version: build,
      minecraftVersions: [],
      loaders: [],
      channel: build === solder.recommended ? 'release' : 'unknown',
      source: 'server-archive',
      available: matchesBuild(p.serverPackUrl, build),
      ...(!matchesBuild(p.serverPackUrl, build)
        ? { unavailableReason: 'server-pack' as const }
        : {}),
    }));
  }
  async versions(id: string, input: ModpackCatalogPageInput = {}, signal?: AbortSignal) {
    return modpackCatalogVersionsSchema.parse(slicePage(await this.allVersions(id, signal), input));
  }
  async resolve(id: string, versionId: string, signal?: AbortSignal): Promise<ModpackRecipe> {
    const [project, p, versions] = await Promise.all([
      this.details(id, signal),
      this.project(id, signal),
      this.allVersions(id, signal),
    ]);
    const version = versions.find((v) => v.id === versionId);
    if (!version) fail('modpack_identity');
    if (!version.available || !p.serverPackUrl)
      return {
        provider: this.provider,
        project,
        version,
        kind: 'unavailable',
        reason: 'server-pack',
      };
    let target: ContentTarget | undefined;
    const base = this.solderBase(p);
    if (base) {
      const manifest = z
        .object({ minecraft: str, forge: z.union([str, z.number()]).nullable().optional() })
        .parse(await this.client.json(`${base}/${identifier(versionId)}`, signal));
      // Platform Minecraft metadata can be stale; the selected Solder build is authoritative.
      if (manifest.forge)
        target = {
          minecraftVersion: manifest.minecraft,
          loader: 'forge',
          loaderVersion: String(manifest.forge),
        };
      version.minecraftVersions = [manifest.minecraft];
      if (target) {
        version.target = target;
        version.loaders = [target.loader];
      }
    }
    const url = downloadUrl(p.serverPackUrl);
    const filename = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
    if (!/\.zip$/i.test(filename)) fail('modpack_server_archive');
    return {
      provider: this.provider,
      project,
      version,
      kind: 'archive',
      format: 'server-archive',
      target,
      download: download({ filename, urls: [url], hashes: {} }),
    };
  }
}
