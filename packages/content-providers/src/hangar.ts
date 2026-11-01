import { z } from 'zod';
import {
  type ContentHttp,
  type ContentLimits,
  type ContentTarget,
  fail,
  safeContentPath,
} from './contracts.js';
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
  description: z.string().default(''),
  namespace: z.object({ owner: z.string(), slug: z.string() }),
  stats: z.object({ downloads: z.number().nonnegative() }),
  category: z.string().default(''),
  mainPageContent: z
    .string()
    .nullish()
    .transform((value) => value ?? ''),
  memberNames: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []),
  avatarUrl: z.string().nullable().optional(),
  settings: z
    .object({ tags: z.array(z.string()).default([]), keywords: z.array(z.string()).default([]) })
    .default({ tags: [], keywords: [] }),
  supportedPlatforms: z.record(z.string(), z.array(z.string())).default({}),
});
type Project = z.infer<typeof projectSchema>;
const downloadSchema = z.object({
  downloadUrl: z.string().nullable().optional(),
  externalUrl: z.string().nullable().optional(),
  fileInfo: z
    .object({ name: z.string(), sizeBytes: z.number().int().nonnegative(), sha256Hash: z.string() })
    .nullable()
    .optional(),
});
const versionSchema = z.object({
  id: positive,
  projectId: positive,
  name: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  channel: z.object({ name: z.string() }),
  downloads: z.record(z.string(), downloadSchema),
  platformDependencies: z.record(z.string(), z.array(z.string())).default({}),
  pluginDependencies: z
    .record(
      z.string(),
      z.array(
        z.object({
          name: z.string(),
          required: z.boolean(),
          projectId: positive.nullable().optional(),
          externalUrl: z.string().nullable().optional(),
        }),
      ),
    )
    .default({}),
});
type Version = z.infer<typeof versionSchema>;
const pageSchema = <T extends z.ZodType>(schema: T) =>
  z.object({
    pagination: z.object({
      count: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
    }),
    result: z.array(schema).max(20),
  });
const environment = { kind: 'server', source: 'hangar', original: ['PAPER'] } as const;

/** Public Hangar v1 API. External downloads are displayed but never fetched implicitly. */
export class HangarProvider extends PluginProviderBase<Project> {
  private readonly base: string;
  constructor(
    http: ContentHttp,
    options: { apiBase?: string; limits?: Partial<ContentLimits> } = {},
  ) {
    super(http, 'hangar', options.limits);
    this.base = options.apiBase ?? 'https://hangar.papermc.io/api/v1';
  }
  private read(path: string, signal?: AbortSignal) {
    return this.http.json(`${this.base}${path}`, { signal });
  }
  protected async project(pid: string, signal?: AbortSignal) {
    const project = projectSchema.parse(
      await this.read(`/projects/${numericPluginId(pid)}`, signal),
    );
    if (String(project.id) !== pid || !project.supportedPlatforms.PAPER) fail('content_kind');
    return project;
  }
  protected publicProject(project: Project): ModCatalogDetails {
    const imageUrl = catalogImage(project.avatarUrl, ['hangarcdn.papermc.io']);
    return modCatalogDetailsSchema.parse({
      provider: 'hangar',
      id: String(project.id),
      name: project.name,
      summary: project.description,
      websiteUrl: `https://hangar.papermc.io/${encodeURIComponent(project.namespace.owner)}/${encodeURIComponent(project.namespace.slug)}`,
      ...(imageUrl ? { imageUrl } : {}),
      authors: project.memberNames.length ? project.memberNames : [project.namespace.owner],
      downloads: project.stats.downloads,
      tags: normalizeModTags(
        'hangar',
        [project.category, ...project.settings.keywords, ...project.settings.tags]
          .filter(Boolean)
          .map((slug) => ({ slug })),
      ),
      environment: { ...environment, original: [...environment.original] },
      description: project.mainPageContent,
      descriptionFormat: 'markdown',
    });
  }
  async searchPlugins(input: ModCatalogSearchInput): Promise<ModCatalogProjects> {
    const offset = pluginPage(input.offset);
    if (input.query.length > 256) fail('search');
    const params = new URLSearchParams({
      query: input.query,
      limit: '20',
      offset: String(offset),
      platform: 'PAPER',
      sort: '-downloads',
    });
    if (!input.includeIncompatible) {
      params.set('version', input.target.minecraftVersion);
      if (input.target.loader === 'folia') params.set('tag', 'SUPPORTS_FOLIA');
    }
    const page = pageSchema(projectSchema).parse(
      await this.read(`/projects?${params}`, input.signal),
    );
    if (page.pagination.offset !== offset) fail('hangar_pagination');
    return modCatalogProjectsSchema.parse({
      offset,
      limit: 20,
      total: page.pagination.count,
      items: page.result.map((project) => {
        const { description, descriptionFormat, ...item } = this.publicProject(project);
        return item;
      }),
    });
  }
  private record(project: Project, raw: Version, target: ContentTarget): PluginVersionRecord {
    if (raw.projectId !== project.id) fail('dependency_identity');
    const download = raw.downloads.PAPER;
    const file = download?.fileInfo;
    let artifact: PluginVersionRecord['artifact'];
    if (
      file &&
      download?.downloadUrl &&
      !download.externalUrl &&
      /^[a-f0-9]{64}$/i.test(file.sha256Hash)
    ) {
      try {
        const url = new URL(download.downloadUrl);
        const path = safeContentPath(`plugins/${file.name}`);
        if (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.hash &&
          url.hostname === 'hangarcdn.papermc.io'
        ) {
          artifact = {
            path,
            urls: [url.href],
            size: file.sizeBytes,
            hashes: { sha256: file.sha256Hash.toLowerCase() },
            projectId: String(project.id),
            versionId: String(raw.id),
            kind: 'plugin',
            serverSide: 'required',
          };
        }
      } catch {
        /* Invalid provider artifact is unavailable in the catalog. */
      }
    }
    const loaders = [
      'paper',
      ...(project.settings.tags.includes('SUPPORTS_FOLIA') ? ['folia'] : []),
    ];
    const gameVersions = raw.platformDependencies.PAPER ?? [];
    const env = { ...environment, original: [...environment.original] };
    const channel = /alpha|snapshot|nightly|dev/i.test(raw.channel.name)
      ? 'alpha'
      : /beta|preview|candidate|\brc\b/i.test(raw.channel.name)
        ? 'beta'
        : 'release';
    return {
      version: {
        provider: 'hangar',
        id: String(raw.id),
        projectId: String(project.id),
        name: raw.name,
        version: raw.name,
        filename: file?.name ?? `${project.namespace.slug}-${raw.id}.jar`,
        gameVersions,
        loaders,
        publishedAt: raw.createdAt,
        bytes: file?.sizeBytes ?? 0,
        channel,
        available: Boolean(artifact),
        ...(!artifact
          ? {
              unavailableReason: download?.externalUrl
                ? ('distribution' as const)
                : ('artifact' as const),
            }
          : {}),
        compatibility: pluginCompatibility(gameVersions, loaders, env, target),
        environment: env,
      },
      artifact,
      dependencies: (raw.pluginDependencies.PAPER ?? []).map((dependency) => ({
        name: dependency.name,
        ...(dependency.projectId && !dependency.externalUrl
          ? { projectId: String(dependency.projectId) }
          : {}),
        relation: dependency.required ? 'required' : 'optional',
      })),
    };
  }
  protected async versions(project: Project, input: ModCatalogVersionsInput) {
    const offset = pluginPage(input.offset);
    const params = new URLSearchParams({
      limit: '20',
      offset: String(offset),
      platform: 'PAPER',
      includeHiddenChannels: 'true',
    });
    if (!input.includeIncompatible) params.set('platformVersion', input.target.minecraftVersion);
    const page = pageSchema(versionSchema).parse(
      await this.read(`/projects/${project.id}/versions?${params}`, input.signal),
    );
    if (page.pagination.offset !== offset) fail('hangar_pagination');
    return {
      total: page.pagination.count,
      items: page.result
        .map((version) => this.record(project, version, input.target))
        .sort((a, b) => b.version.publishedAt.localeCompare(a.version.publishedAt)),
    };
  }
  protected async version(
    project: Project,
    vid: string,
    target: ContentTarget,
    signal?: AbortSignal,
  ) {
    const raw = versionSchema.parse(
      await this.read(`/projects/${project.id}/versions/${numericPluginId(vid)}`, signal),
    );
    if (String(raw.id) !== vid) fail('dependency_identity');
    return this.record(project, raw, target);
  }
}
