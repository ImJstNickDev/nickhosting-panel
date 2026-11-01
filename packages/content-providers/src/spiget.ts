import { z } from 'zod';
import { type ContentHttp, type ContentLimits, type ContentTarget, fail } from './contracts.js';
import {
  type ModCatalogDetails,
  type ModCatalogProjects,
  modCatalogDetailsSchema,
  modCatalogProjectsSchema,
} from './mod-catalog.js';
import { catalogImage, normalizeModTags } from './mod-metadata.js';
import type { ModCatalogSearchInput, ModCatalogVersionsInput } from './mod-resolution.js';
import { pluginCompatibility } from './plugin-metadata.js';
import {
  numericPluginId,
  PluginProviderBase,
  type PluginVersionRecord,
  pluginPage,
} from './plugin-provider-base.js';

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const projectSchema = z.object({
  id: positive,
  name: z.string(),
  tag: z.string().default(''),
  downloads: z.number().nonnegative().default(0),
  testedVersions: z.array(z.string()).default([]),
  external: z.boolean().default(true),
  premium: z.boolean().default(false),
  category: z.object({ id: positive }).optional(),
  file: z
    .object({
      type: z.string(),
      size: z.number().nonnegative().default(0),
      sizeUnit: z.string().default(''),
    })
    .optional(),
  description: z
    .string()
    .max(3 * 1024 * 1024)
    .default(''),
  icon: z.object({ url: z.string().optional() }).optional(),
  version: z.object({ id: positive }).optional(),
  versions: z.array(z.object({ id: positive })).default([]),
});
type Project = z.infer<typeof projectSchema>;
const versionSchema = z.object({
  id: positive,
  resource: positive.optional(),
  name: z.string(),
  releaseDate: z.number().nonnegative(),
});
type Version = z.infer<typeof versionSchema>;
// SpigotMC category IDs are upstream catalog identifiers, not deployment configuration.
// Bungee-Spigot children 5..9 run on Spigot; Bungee-Proxy children 10..13 do not.
const spigotCategories = new Set([2, 4, 5, 6, 7, 8, 9, 14, 15, 16, 17, 18, 21, 22, 23, 24, 26, 28]);
function spigotLoaders(project: Project): string[] {
  return spigotCategories.has(project.category?.id ?? -1) ? ['spigot'] : [];
}
const environment = { kind: 'server', source: 'spiget', original: ['SpigotMC'] } as const;

/** SpiGet resources are not guaranteed to expose dependencies or historic per-file compatibility. */
export class SpigetProvider extends PluginProviderBase<Project> {
  private readonly base: string;
  constructor(
    http: ContentHttp,
    options: { apiBase?: string; limits?: Partial<ContentLimits> } = {},
  ) {
    super(http, 'spiget', options.limits);
    this.base = options.apiBase ?? 'https://api.spiget.org/v2';
  }
  private read(path: string, signal?: AbortSignal) {
    return this.http.json(`${this.base}${path}`, { signal });
  }
  protected async project(pid: string, signal?: AbortSignal) {
    const project = projectSchema.parse(
      await this.read(`/resources/${numericPluginId(pid)}`, signal),
    );
    if (String(project.id) !== pid) fail('dependency_identity');
    return project;
  }
  protected publicProject(project: Project): ModCatalogDetails {
    let imageUrl: string | undefined;
    if (project.icon?.url) {
      try {
        imageUrl = catalogImage(new URL(project.icon.url, 'https://www.spigotmc.org/').href, [
          'www.spigotmc.org',
          'spigotmc.org',
          'cdn.spiget.org',
        ]);
      } catch {
        /* Optional icon. */
      }
    }
    return modCatalogDetailsSchema.parse({
      provider: 'spiget',
      id: String(project.id),
      name: project.name,
      summary: project.tag,
      websiteUrl: `https://www.spigotmc.org/resources/${project.id}/`,
      ...(imageUrl ? { imageUrl } : {}),
      authors: [],
      downloads: project.downloads,
      tags: normalizeModTags(
        'spiget',
        spigotLoaders(project).map((slug) => ({ slug, name: 'Spigot' })),
      ),
      environment: { ...environment, original: [...environment.original] },
      description: Buffer.from(project.description, 'base64').toString('utf8'),
      descriptionFormat: 'html',
    });
  }
  async searchPlugins(input: ModCatalogSearchInput): Promise<ModCatalogProjects> {
    const offset = pluginPage(input.offset);
    if (input.query.length > 256 || offset % 20) fail('search');
    const params = new URLSearchParams({
      size: '20',
      page: String(offset / 20 + 1),
      sort: '-downloads',
    });
    const path = input.query.trim()
      ? `/search/resources/${encodeURIComponent(input.query.trim())}?${params}&field=name`
      : `/resources/free?${params}`;
    const projects = z
      .array(projectSchema)
      .max(20)
      .parse(await this.read(path, input.signal));
    // SpiGet exposes page counts only in HTTP headers; retain forward pagination without an extra count request.
    return modCatalogProjectsSchema.parse({
      offset,
      limit: 20,
      total: offset + projects.length + (projects.length === 20 ? 1 : 0),
      items: projects.map((project) => {
        const { description, descriptionFormat, ...item } = this.publicProject(project);
        return item;
      }),
    });
  }
  private record(project: Project, raw: Version, target: ContentTarget): PluginVersionRecord {
    if (raw.resource !== undefined && raw.resource !== project.id) fail('dependency_identity');
    const latest = project.version?.id === raw.id;
    const available =
      !project.external && !project.premium && project.file?.type.toLowerCase() === '.jar';
    const unit =
      ({ KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as Record<string, number>)[
        project.file?.sizeUnit.toUpperCase() ?? ''
      ] ?? 1;
    const estimatedBytes = latest ? Math.ceil((project.file?.size ?? 0) * unit) : 0;
    const filename = `spigot-${project.id}-${raw.id}.jar`;
    // testedVersions is a project-level current declaration, never evidence for historical binaries.
    const gameVersions = latest ? project.testedVersions : [];
    const loaders = spigotLoaders(project);
    const env = { ...environment, original: [...environment.original] };
    return {
      version: {
        provider: 'spiget',
        id: String(raw.id),
        projectId: String(project.id),
        name: raw.name,
        version: raw.name,
        filename,
        gameVersions,
        loaders,
        publishedAt: new Date(raw.releaseDate * 1000).toISOString(),
        bytes: estimatedBytes,
        channel: /alpha|snapshot|nightly/i.test(raw.name)
          ? 'alpha'
          : /beta|preview|(?:^|[-. ])rc\d*/i.test(raw.name)
            ? 'beta'
            : 'release',
        available,
        ...(!available ? { unavailableReason: 'distribution' as const } : {}),
        compatibility: pluginCompatibility(gameVersions, loaders, env, target, true),
        environment: env,
      },
      ...(available
        ? {
            artifact: {
              path: `plugins/${filename}`,
              urls: [
                `https://api.spiget.org/v2/resources/${project.id}/versions/${raw.id}/download/proxy`,
              ],
              // Rounded provider sizes are display-only. This bounded ceiling is replaced by the measured size at staging.
              size: Math.min(
                this.limits.maxFileBytes,
                Math.max(256 * 1024 ** 2, estimatedBytes + unit),
              ),
              hashes: {},
              integrity: 'spiget-tls' as const,
              projectId: String(project.id),
              versionId: String(raw.id),
              kind: 'plugin' as const,
              serverSide: 'required' as const,
            },
          }
        : {}),
      dependencies: [],
    };
  }
  protected async versions(project: Project, input: ModCatalogVersionsInput) {
    const offset = pluginPage(input.offset);
    if (!input.includeIncompatible) {
      if (!project.version || offset > 0) return { items: [], total: project.version ? 1 : 0 };
      return {
        items: [
          await this.version(project, String(project.version.id), input.target, input.signal),
        ],
        total: 1,
      };
    }
    if (offset % 20) fail('search');
    const params = new URLSearchParams({
      size: '20',
      page: String(offset / 20 + 1),
      sort: '-releaseDate',
    });
    const versions = z
      .array(versionSchema)
      .max(20)
      .parse(await this.read(`/resources/${project.id}/versions?${params}`, input.signal));
    return {
      total: project.versions.length || offset + versions.length + (versions.length === 20 ? 1 : 0),
      items: versions.map((version) => this.record(project, version, input.target)),
    };
  }
  protected async version(
    project: Project,
    vid: string,
    target: ContentTarget,
    signal?: AbortSignal,
  ) {
    const raw = versionSchema.parse(
      await this.read(`/resources/${project.id}/versions/${numericPluginId(vid)}`, signal),
    );
    if (String(raw.id) !== vid) fail('dependency_identity');
    return this.record(project, raw, target);
  }
}
