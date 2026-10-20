import { z } from 'zod';
import {
  type ContentArtifact,
  type ContentLimits,
  type ContentTarget,
  fail,
  hashesSchema,
  safeContentPath,
} from './contracts.js';
import { dependencyMemo } from './datapack-resolution.js';
import {
  type ModCatalogDetails,
  type ModCatalogProject,
  type ModCatalogProjects,
  type ModCatalogVersion,
  type ModCatalogVersions,
  type ModSelection,
  modCatalogDetailsSchema,
  modCatalogProjectsSchema,
  modCatalogVersionsSchema,
} from './mod-catalog.js';
import {
  catalogImage,
  curseforgeEnvironment,
  curseforgeProjectEnvironment,
  modCompatibility,
  modrinthEnvironment,
  normalizeModTags,
  recommendedModVersion,
} from './mod-metadata.js';
import {
  type ModCandidate,
  type ModCatalogSearchInput,
  type ModCatalogVersionsInput,
  type ResolvedMods,
  type ResolveModsOptions,
  resolveModGraph,
} from './mod-resolution.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const numeric = z.number().int().positive();
const environment = z.union([z.string(), z.array(z.string()).max(32)]).optional();
const mrProject = z.object({
  id,
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  body: z.string().default(''),
  project_type: z.string(),
  loaders: z.array(z.string()).default([]),
  categories: z.array(z.string()).default([]),
  additional_categories: z.array(z.string()).default([]),
  downloads: z.number().nonnegative(),
  icon_url: z.string().nullable().optional(),
  environment,
  client_side: z.string().optional(),
  server_side: z.string().optional(),
});
const mrVersion = z.object({
  id,
  project_id: id,
  name: z.string(),
  version_number: z.string(),
  game_versions: z.array(z.string()),
  loaders: z.array(z.string()),
  date_published: z.iso.datetime({ offset: true }),
  version_type: z.enum(['release', 'beta', 'alpha']),
  environment: z.string().optional(),
  files: z
    .array(
      z.object({
        url: z.string().url(),
        filename: z.string(),
        size: z.number().int().nonnegative(),
        hashes: hashesSchema,
        primary: z.boolean().default(false),
        file_type: z.string().nullable().optional(),
      }),
    )
    .min(1),
  dependencies: z
    .array(
      z.object({
        version_id: id.nullable().optional(),
        project_id: id.nullable().optional(),
        dependency_type: z.enum(['required', 'optional', 'incompatible', 'embedded']),
      }),
    )
    .default([]),
});
type MRProject = z.infer<typeof mrProject>;
type MRVersion = z.infer<typeof mrVersion>;
const cfProject = z.object({
  id: numeric,
  gameId: numeric,
  classId: numeric,
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  downloadCount: z.number().nonnegative(),
  authors: z.array(z.object({ name: z.string() })),
  categories: z.array(z.object({ slug: z.string(), name: z.string() })).default([]),
  logo: z.object({ thumbnailUrl: z.string() }).nullable().optional(),
  isAvailable: z.boolean(),
  allowModDistribution: z.boolean().nullable().optional(),
  latestFiles: z.array(z.object({ gameVersions: z.array(z.string()).default([]) })).default([]),
});
const cfFile = z.object({
  id: numeric,
  modId: numeric,
  gameId: numeric,
  displayName: z.string(),
  fileName: z.string(),
  fileLength: z.number().int().nonnegative(),
  fileDate: z.iso.datetime({ offset: true }),
  releaseType: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  gameVersions: z.array(z.string()),
  isAvailable: z.boolean(),
  downloadUrl: z.string().url().nullable(),
  hashes: z.array(z.object({ algo: z.number().int(), value: z.string() })),
  dependencies: z.array(z.object({ modId: numeric, relationType: z.number().int() })).default([]),
});
type CFProject = z.infer<typeof cfProject>;
type CFFile = z.infer<typeof cfFile>;
const cfResponse = z.object({
  data: z.unknown(),
  pagination: z
    .object({
      index: z.number().int(),
      pageSize: z.number().int(),
      resultCount: z.number().int(),
      totalCount: z.number().int().nonnegative(),
    })
    .optional(),
});
const loaderNames: Record<string, string> = {
  Fabric: 'fabric',
  Forge: 'forge',
  NeoForge: 'neoforge',
  Quilt: 'quilt',
  LiteLoader: 'liteloader',
  Rift: 'rift',
};
const loaderIds: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
function offsetValue(offset = 0): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 9980) fail('search');
  return offset;
}
function cfId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    fail('curseforge_identity');
  return Number(value);
}
function validJar(filename: string, url: string | null | undefined): boolean {
  try {
    if (!/^[^/]+\.jar$/.test(filename)) return false;
    safeContentPath(`mods/${filename}`);
    const parsed = new URL(url ?? '');
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    return false;
  }
}
function mrPrimary(version: MRVersion) {
  const candidates = version.files.filter(
    (file) => !file.file_type || file.file_type === 'unknown',
  );
  const primary = candidates.filter((file) => file.primary);
  return primary.length === 1 ? primary[0] : primary.length === 0 ? candidates[0] : undefined;
}
function mrPublicProject(project: MRProject): ModCatalogProject {
  const imageUrl = catalogImage(project.icon_url, ['cdn.modrinth.com']);
  return {
    provider: 'modrinth',
    id: project.id,
    name: project.title,
    summary: project.description,
    websiteUrl: `https://modrinth.com/mod/${encodeURIComponent(project.slug)}`,
    ...(imageUrl ? { imageUrl } : {}),
    authors: [],
    downloads: project.downloads,
    tags: normalizeModTags(
      'modrinth',
      [...project.categories, ...project.additional_categories]
        .filter((tag) => !['fabric', 'forge', 'quilt', 'neoforge'].includes(tag))
        .map((slug) => ({ slug })),
    ),
    environment: modrinthEnvironment(project),
  };
}
function mrPublicVersion(
  version: MRVersion,
  project: MRProject,
  target: ContentTarget,
): ModCatalogVersion {
  const file = mrPrimary(version);
  const env =
    version.environment === undefined
      ? modrinthEnvironment(project)
      : modrinthEnvironment({ environment: version.environment });
  const available = Boolean(file && validJar(file.filename, file.url));
  return {
    provider: 'modrinth',
    id: version.id,
    projectId: project.id,
    name: version.name,
    version: version.version_number,
    filename: file?.filename ?? `${version.id}.jar`,
    gameVersions: version.game_versions,
    loaders: version.loaders,
    publishedAt: version.date_published,
    bytes: file?.size ?? 0,
    channel: version.version_type,
    available,
    ...(!available ? { unavailableReason: 'artifact' as const } : {}),
    compatibility: modCompatibility(version.game_versions, version.loaders, env, target),
    environment: env,
  };
}
function cfPublicProject(project: CFProject): ModCatalogProject {
  const imageUrl = catalogImage(project.logo?.thumbnailUrl, [
    'media.forgecdn.net',
    'mediafilez.forgecdn.net',
  ]);
  return {
    provider: 'curseforge',
    id: String(project.id),
    name: project.name,
    summary: project.summary,
    websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/${encodeURIComponent(project.slug)}`,
    ...(imageUrl ? { imageUrl } : {}),
    authors: project.authors.map((author) => author.name),
    downloads: project.downloadCount,
    tags: normalizeModTags('curseforge', project.categories),
    environment: curseforgeProjectEnvironment(project.latestFiles),
  };
}
function cfHash(file: CFFile): string | undefined {
  const value = file.hashes.find((hash) => hash.algo === 1)?.value.toLowerCase();
  return value && /^[a-f0-9]{40}$/.test(value) ? value : undefined;
}
function cfPublicVersion(
  file: CFFile,
  project: CFProject,
  target: ContentTarget,
): ModCatalogVersion {
  const loaders = file.gameVersions.flatMap((version) =>
    loaderNames[version] ? [loaderNames[version]] : [],
  );
  const gameVersions = file.gameVersions.filter(
    (version) =>
      !loaderNames[version] &&
      !['Client', 'Server', 'Java 8', 'Java 16', 'Java 17', 'Java 21', 'Java 25'].includes(version),
  );
  const permitted =
    project.isAvailable &&
    project.allowModDistribution !== false &&
    file.isAvailable &&
    Boolean(file.downloadUrl);
  const artifact = validJar(file.fileName, file.downloadUrl) && Boolean(cfHash(file));
  const env = curseforgeEnvironment(file.gameVersions);
  return {
    provider: 'curseforge',
    id: String(file.id),
    projectId: String(project.id),
    name: file.displayName,
    version: file.displayName,
    filename: file.fileName,
    gameVersions,
    loaders,
    publishedAt: file.fileDate,
    bytes: file.fileLength,
    channel: ({ 1: 'release', 2: 'beta', 3: 'alpha' } as const)[file.releaseType],
    available: permitted && artifact,
    ...(!permitted
      ? { unavailableReason: 'distribution' as const }
      : !artifact
        ? { unavailableReason: 'artifact' as const }
        : {}),
    compatibility: modCompatibility(gameVersions, loaders, env, target),
    environment: env,
  };
}

type Read = (path: string, signal?: AbortSignal) => Promise<unknown>;
/** Catalog methods share the adapters' existing transport, credentials and allowlisted download path. */
export class ModrinthModCatalog {
  constructor(
    private readonly read: Read,
    private readonly limits: ContentLimits,
  ) {}
  private async project(pid: string, signal?: AbortSignal): Promise<MRProject> {
    id.parse(pid);
    const project = mrProject.parse(await this.read(`/project/${encodeURIComponent(pid)}`, signal));
    if (
      project.id !== pid ||
      (project.project_type !== 'mod' &&
        !project.loaders.some((loader) =>
          ['fabric', 'forge', 'quilt', 'neoforge'].includes(loader),
        ))
    )
      fail('content_kind');
    return project;
  }
  private async versions(
    pid: string,
    target: ContentTarget,
    includeIncompatible: boolean,
    signal?: AbortSignal,
  ): Promise<MRVersion[]> {
    id.parse(pid);
    const params = new URLSearchParams({ include_changelog: 'false' });
    if (!includeIncompatible) {
      params.set('game_versions', JSON.stringify([target.minecraftVersion]));
      params.set('loaders', JSON.stringify([target.loader]));
    }
    const versions = z
      .array(mrVersion)
      .max(10000)
      .parse(await this.read(`/project/${encodeURIComponent(pid)}/version?${params}`, signal));
    if (versions.some((version) => version.project_id !== pid)) fail('dependency_identity');
    return versions.sort(
      (a, b) => b.date_published.localeCompare(a.date_published) || a.id.localeCompare(b.id),
    );
  }
  async search(input: ModCatalogSearchInput): Promise<ModCatalogProjects> {
    const offset = offsetValue(input.offset);
    if (input.query.length > 256) fail('search');
    const facets = [['all_project_types:mod']];
    if (!input.includeIncompatible)
      facets.push(
        [`versions:${input.target.minecraftVersion}`],
        [`categories:${input.target.loader}`],
      );
    const params = new URLSearchParams({
      query: input.query,
      facets: JSON.stringify(facets),
      offset: String(offset),
      limit: '20',
    });
    const result = z
      .object({
        hits: z
          .array(
            z.object({
              project_id: id,
              slug: z.string(),
              title: z.string(),
              description: z.string(),
              author: z.string(),
              downloads: z.number().nonnegative(),
              icon_url: z.string().nullable().optional(),
              categories: z.array(z.string()).default([]),
              display_categories: z.array(z.string()).default([]),
              environment,
              client_side: z.string().optional(),
              server_side: z.string().optional(),
            }),
          )
          .max(20),
        offset: z.number().int(),
        total_hits: z.number().int().nonnegative(),
      })
      .parse(await this.read(`/search?${params}`, input.signal));
    if (result.offset !== offset || result.total_hits < result.hits.length)
      fail('modrinth_pagination');
    return modCatalogProjectsSchema.parse({
      offset,
      limit: 20,
      total: result.total_hits,
      items: result.hits.map((hit) => ({
        ...mrPublicProject({
          ...hit,
          id: hit.project_id,
          project_type: 'mod',
          body: '',
          loaders: [],
          additional_categories: hit.display_categories,
        }),
        authors: [hit.author],
      })),
    });
  }
  async details(pid: string, signal?: AbortSignal): Promise<ModCatalogDetails> {
    const project = await this.project(pid, signal);
    return modCatalogDetailsSchema.parse({
      ...mrPublicProject(project),
      description: project.body,
      descriptionFormat: 'markdown',
    });
  }
  async listVersions(pid: string, input: ModCatalogVersionsInput): Promise<ModCatalogVersions> {
    const offset = offsetValue(input.offset);
    const [project, raw] = await Promise.all([
      this.project(pid, input.signal),
      this.versions(pid, input.target, input.includeIncompatible ?? false, input.signal),
    ]);
    const all = raw.map((version) => mrPublicVersion(version, project, input.target));
    const items = input.includeIncompatible
      ? all
      : all.filter((version) => version.compatibility.length === 0);
    return modCatalogVersionsSchema.parse({
      offset,
      limit: 20,
      total: items.length,
      items: items.slice(offset, offset + 20),
      recommendedId: recommendedModVersion(items, input.preferBeta)?.id,
    });
  }
  async resolve(
    roots: ModSelection[],
    target: ContentTarget,
    options: ResolveModsOptions = {},
  ): Promise<ResolvedMods> {
    const memo = dependencyMemo(this.limits.maxDependencies);
    const rootIds = new Set(roots.map((root) => root.projectId));
    const installedVersion = (pid: string) =>
      rootIds.has(pid) ? undefined : options.installedVersions?.get(pid);
    const project = (pid: string) =>
      memo(`project:${pid}`, () => this.project(pid, options.signal));
    const version = (vid: string) =>
      memo(`version:${vid}`, async () => {
        id.parse(vid);
        const result = mrVersion.parse(
          await this.read(`/version/${encodeURIComponent(vid)}`, options.signal),
        );
        if (result.id !== vid) fail('dependency_identity');
        return result;
      });
    return resolveModGraph({
      provider: 'modrinth',
      roots,
      target,
      limit: this.limits.maxDependencies,
      signal: options.signal,
      project: async (pid) => mrPublicProject(await project(pid)),
      load: (pid, vid) =>
        memo(`candidate:${pid ?? ''}:${vid ?? ''}`, async (): Promise<ModCandidate> => {
          const knownProject = pid ? project(pid) : undefined;
          const initialVersions =
            pid && !vid && !installedVersion(pid)
              ? memo(`versions:${pid}`, () => this.versions(pid, target, false, options.signal))
              : undefined;
          const [pinned, prefetchedProject, prefetchedVersions] = await Promise.all([
            vid ? version(vid) : undefined,
            knownProject,
            initialVersions,
          ]);
          if (pinned && pid && pinned.project_id !== pid) fail('dependency_identity');
          const actualId = pid ?? pinned?.project_id;
          if (!actualId) fail('dependency_identity');
          const rawProject = prefetchedProject ?? (await project(actualId));
          let selected = pinned;
          const installed = installedVersion(actualId);
          if (!selected && installed) {
            const current = await version(installed);
            if (current.project_id !== actualId) fail('dependency_identity');
            if (mrPublicVersion(current, rawProject, target).compatibility.length === 0)
              selected = current;
          }
          if (!selected) {
            const all = await (prefetchedVersions ??
              memo(`versions:${actualId}`, () =>
                this.versions(actualId, target, false, options.signal),
              ));
            const preferred = recommendedModVersion(
              all.map((raw) => mrPublicVersion(raw, rawProject, target)),
              options.preferBeta,
            );
            selected = all.find((raw) => raw.id === preferred?.id);
          }
          const publicProject = mrPublicProject(rawProject);
          if (!selected) return { project: publicProject, dependencies: [] };
          const publicVersion = mrPublicVersion(selected, rawProject, target);
          const file = mrPrimary(selected);
          const artifact: ContentArtifact | undefined =
            file && publicVersion.available
              ? {
                  path: `mods/${file.filename}`,
                  urls: [file.url],
                  size: file.size,
                  hashes: file.hashes,
                  projectId: actualId,
                  versionId: selected.id,
                  kind: 'mod',
                  serverSide: publicVersion.environment.kind === 'unknown' ? 'unknown' : 'required',
                }
              : undefined;
          return {
            project: publicProject,
            version: publicVersion,
            artifact,
            dependencies: selected.dependencies.map((dep) => ({
              projectId: dep.project_id ?? undefined,
              versionId: dep.version_id ?? undefined,
              relation: dep.dependency_type,
            })),
          };
        }),
    });
  }
}

export class CurseForgeModCatalog {
  constructor(
    private readonly read: Read,
    private readonly limits: ContentLimits,
  ) {}
  private async response(path: string, signal?: AbortSignal) {
    return cfResponse.parse(await this.read(path, signal));
  }
  private async project(pid: string, signal?: AbortSignal): Promise<CFProject> {
    const project = cfProject.parse((await this.response(`/mods/${cfId(pid)}`, signal)).data);
    if (String(project.id) !== pid || project.gameId !== 432 || project.classId !== 6)
      fail('content_kind');
    return project;
  }
  private async file(pid: string, vid: string, signal?: AbortSignal): Promise<CFFile> {
    const file = cfFile.parse(
      (await this.response(`/mods/${cfId(pid)}/files/${cfId(vid)}`, signal)).data,
    );
    if (String(file.modId) !== pid || String(file.id) !== vid || file.gameId !== 432)
      fail('dependency_identity');
    return file;
  }
  private async files(
    pid: string,
    target: ContentTarget,
    offset: number,
    includeIncompatible: boolean,
    signal?: AbortSignal,
    pageSize = 20,
  ) {
    const params = new URLSearchParams({ index: String(offset), pageSize: String(pageSize) });
    if (!includeIncompatible) {
      const loader = loaderIds[target.loader];
      if (!loader) fail('curseforge_loader');
      params.set('gameVersion', target.minecraftVersion);
      params.set('modLoaderType', String(loader));
    }
    const response = await this.response(`/mods/${cfId(pid)}/files?${params}`, signal);
    const files = z.array(cfFile).max(pageSize).parse(response.data);
    if (files.some((file) => String(file.modId) !== pid || file.gameId !== 432))
      fail('dependency_identity');
    if (
      !response.pagination ||
      response.pagination.index !== offset ||
      response.pagination.pageSize !== pageSize ||
      response.pagination.resultCount !== files.length ||
      response.pagination.totalCount < offset + files.length
    )
      fail('curseforge_pagination');
    return { files, total: response.pagination.totalCount };
  }
  async search(input: ModCatalogSearchInput): Promise<ModCatalogProjects> {
    const offset = offsetValue(input.offset);
    if (input.query.length > 256) fail('search');
    const params = new URLSearchParams({
      gameId: '432',
      classId: '6',
      searchFilter: input.query,
      index: String(offset),
      pageSize: '20',
      sortField: '6',
      sortOrder: 'desc',
    });
    if (!input.includeIncompatible) {
      const loader = loaderIds[input.target.loader];
      if (!loader) fail('curseforge_loader');
      params.set('gameVersion', input.target.minecraftVersion);
      params.set('modLoaderType', String(loader));
    }
    const response = await this.response(`/mods/search?${params}`, input.signal);
    const projects = z.array(cfProject).max(20).parse(response.data);
    if (projects.some((project) => project.gameId !== 432 || project.classId !== 6))
      fail('content_kind');
    if (
      !response.pagination ||
      response.pagination.index !== offset ||
      response.pagination.resultCount !== projects.length
    )
      fail('curseforge_pagination');
    return modCatalogProjectsSchema.parse({
      offset,
      limit: 20,
      total: response.pagination.totalCount,
      items: projects.map(cfPublicProject),
    });
  }
  async details(pid: string, signal?: AbortSignal): Promise<ModCatalogDetails> {
    const [project, description] = await Promise.all([
      this.project(pid, signal),
      this.response(`/mods/${cfId(pid)}/description`, signal),
    ]);
    return modCatalogDetailsSchema.parse({
      ...cfPublicProject(project),
      description: z.string().parse(description.data),
      descriptionFormat: 'html',
    });
  }
  async listVersions(pid: string, input: ModCatalogVersionsInput): Promise<ModCatalogVersions> {
    const offset = offsetValue(input.offset);
    const [project, page] = await Promise.all([
      this.project(pid, input.signal),
      this.files(pid, input.target, offset, input.includeIncompatible ?? false, input.signal),
    ]);
    const items = page.files.map((file) => cfPublicVersion(file, project, input.target));
    // This is a recommendation within the requested page; automatic selection walks lazily below.
    return modCatalogVersionsSchema.parse({
      offset,
      limit: 20,
      total: page.total,
      items,
      recommendedId: recommendedModVersion(items, input.preferBeta)?.id,
    });
  }
  async resolve(
    roots: ModSelection[],
    target: ContentTarget,
    options: ResolveModsOptions = {},
  ): Promise<ResolvedMods> {
    const memo = dependencyMemo(this.limits.maxDependencies);
    const rootIds = new Set(roots.map((root) => root.projectId));
    const installedVersion = (pid: string) =>
      rootIds.has(pid) ? undefined : options.installedVersions?.get(pid);
    const project = (pid: string) =>
      memo(`project:${pid}`, () => this.project(pid, options.signal));
    const file = (pid: string, vid: string) =>
      memo(`file:${pid}:${vid}`, () => this.file(pid, vid, options.signal));
    return resolveModGraph({
      provider: 'curseforge',
      roots,
      target,
      limit: this.limits.maxDependencies,
      signal: options.signal,
      project: async (pid) => cfPublicProject(await project(pid)),
      load: (pid, vid) =>
        memo(`candidate:${pid ?? ''}:${vid ?? ''}`, async (): Promise<ModCandidate> => {
          if (!pid) fail('dependency_identity');
          const initialPage =
            !vid && !installedVersion(pid)
              ? memo(`files:${pid}:0`, () => this.files(pid, target, 0, false, options.signal, 50))
              : undefined;
          const [rawProject, pinned] = await Promise.all([
            project(pid),
            vid ? file(pid, vid) : undefined,
            initialPage,
          ]);
          let selected = pinned;
          const installed = installedVersion(pid);
          if (!selected && installed) {
            const current = await file(pid, installed);
            if (cfPublicVersion(current, rawProject, target).compatibility.length === 0)
              selected = current;
          }
          if (!selected) {
            let beta: CFFile | undefined;
            for (let offset = 0; offset < 10000; offset += 50) {
              const page = await memo(`files:${pid}:${offset}`, () =>
                this.files(pid, target, offset, false, options.signal, 50),
              );
              const candidates = page.files
                .map((raw) => ({ raw, public: cfPublicVersion(raw, rawProject, target) }))
                .filter((entry) => entry.public.available && !entry.public.compatibility.length)
                .sort((a, b) => b.public.publishedAt.localeCompare(a.public.publishedAt));
              beta ??= candidates.find((entry) => entry.public.channel === 'beta')?.raw;
              selected = candidates.find(
                (entry) =>
                  entry.public.channel === 'release' ||
                  (options.preferBeta && entry.public.channel === 'beta'),
              )?.raw;
              if (selected || offset + page.files.length >= page.total || !page.files.length) break;
            }
            selected ??= beta;
          }
          const publicProject = cfPublicProject(rawProject);
          if (!selected) return { project: publicProject, dependencies: [] };
          const publicVersion = cfPublicVersion(selected, rawProject, target);
          const sha1 = cfHash(selected);
          const artifact: ContentArtifact | undefined =
            publicVersion.available && selected.downloadUrl && sha1
              ? {
                  path: `mods/${selected.fileName}`,
                  urls: [selected.downloadUrl],
                  size: selected.fileLength,
                  hashes: { sha1 },
                  projectId: pid,
                  versionId: String(selected.id),
                  kind: 'mod',
                  serverSide: 'unknown',
                }
              : undefined;
          const relations = {
            1: 'embedded',
            2: 'optional',
            3: 'required',
            4: 'optional',
            5: 'incompatible',
            6: 'embedded',
          } as const;
          return {
            project: publicProject,
            version: publicVersion,
            artifact,
            dependencies: selected.dependencies.map((dep) => {
              const relation = relations[dep.relationType as keyof typeof relations];
              if (!relation) fail('dependency_relation');
              return { projectId: String(dep.modId), relation };
            }),
          };
        }),
    });
  }
}
