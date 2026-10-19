import { z } from 'zod';
import {
  type ContentArtifact,
  type ContentHttp,
  type ContentLimits,
  type ContentPlan,
  type ContentTarget,
  contentLimits,
  fail,
  safeArchivePath,
  unavailable,
  validateContentPlan,
} from './contracts.js';
import { type DatapackCatalogFiles, datapackCatalogFilesSchema } from './datapack-catalog.js';
import {
  type DatapackCandidate,
  dependencyMemo,
  resolveDatapackGraph,
} from './datapack-resolution.js';
import {
  type WorldCatalogFiles,
  type WorldCatalogProjects,
  worldCatalogFilesSchema,
  worldCatalogProjectsSchema,
} from './world-catalog.js';

const numeric = z.number().int().positive();
const fileSchema = z.object({
  id: numeric,
  modId: numeric,
  fileName: z.string(),
  fileLength: z.number().int().positive(),
  downloadUrl: z.string().url().nullable(),
  isAvailable: z.boolean(),
  gameVersions: z.array(z.string()),
  hashes: z.array(z.object({ algo: z.number().int(), value: z.string() })),
  dependencies: z.array(z.object({ modId: numeric, relationType: z.number().int() })).default([]),
});
const projectSchema = z.object({
  id: numeric,
  name: z.string(),
  allowModDistribution: z.boolean().nullable().optional(),
});
const worldProjectSchema = projectSchema.extend({
  gameId: numeric,
  classId: numeric,
  slug: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/),
  summary: z.string(),
  downloadCount: z.number().nonnegative(),
  authors: z.array(z.object({ name: z.string() })),
  logo: z.object({ thumbnailUrl: z.string() }).nullable().optional(),
  isAvailable: z.boolean(),
});
const worldFileSchema = fileSchema.extend({
  gameId: numeric,
  displayName: z.string(),
  fileDate: z.iso.datetime({ offset: true }),
});
const paginationSchema = z.object({
  index: z.number().int().nonnegative(),
  pageSize: z.literal(20),
  resultCount: z.number().int().min(0).max(20),
  totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const responseSchema = z.object({ data: z.unknown(), pagination: z.unknown().optional() });
const minecraftGameId = 432;
const worldPageSize = 20 as const;

function worldOffset(offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + worldPageSize > 10000) fail('search');
}
function worldId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    fail('curseforge_identity');
  return Number(value);
}
function worldPagination(raw: unknown, offset: number, count: number) {
  const page = paginationSchema.parse(raw);
  if (page.index !== offset || page.resultCount !== count || page.totalCount < count)
    fail('curseforge_pagination');
  return { offset, limit: worldPageSize, total: page.totalCount };
}
function httpsUrl(value: string | null | undefined): URL | undefined {
  if (!value || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}
function worldFileIntegrity(file: z.infer<typeof worldFileSchema>): string | undefined {
  const sha1 = file.hashes.find((hash) => hash.algo === 1)?.value.toLowerCase();
  if (
    !sha1 ||
    !/^[a-f0-9]{40}$/.test(sha1) ||
    !/\.zip$/i.test(file.fileName) ||
    file.fileName.includes('/') ||
    !httpsUrl(file.downloadUrl) ||
    !Number.isSafeInteger(file.fileLength)
  )
    return undefined;
  try {
    safeArchivePath(file.fileName);
    return sha1;
  } catch {
    return undefined;
  }
}
export type CurseForgeFile = z.infer<typeof fileSchema>;
const loaderNames: Record<ContentTarget['loader'], string> = {
  vanilla: '',
  paper: '',
  folia: '',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
};
const loaderIds: Partial<Record<ContentTarget['loader'], number>> = {
  forge: 1,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
};
/** Optional adapter: caller must supply an approved key; never bypass a missing distribution URL. */
export class CurseForgeProvider {
  readonly #key: string;
  private readonly base: string;
  private readonly limits: ContentLimits;
  private readonly catalogClasses = new Map<string, Promise<number>>();
  constructor(
    readonly http: ContentHttp,
    options: { apiKey: string; apiBase?: string; limits?: Partial<ContentLimits> },
  ) {
    if (!options.apiKey || /[\r\n]/.test(options.apiKey)) unavailable('curseforge_credentials');
    this.#key = options.apiKey;
    this.base = options.apiBase ?? 'https://api.curseforge.com/v1';
    this.limits = contentLimits(options.limits);
  }
  private async request(path: string, signal?: AbortSignal) {
    return responseSchema.parse(
      await this.http.json(`${this.base}${path}`, {
        headers: { 'x-api-key': this.#key },
        ...(signal ? { signal } : {}),
      }),
    );
  }
  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    return (await this.request(path, signal)).data;
  }
  private getCatalogClass(kind: 'worlds' | 'data-packs', signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    const cached = this.catalogClasses.get(kind);
    if (cached) return cached;
    // Provider classes are discovered, not guessed from historical numeric IDs.
    const pending = this.get('/categories?gameId=432&classesOnly=true', signal)
      .then((data) => {
        const classes = z
          .array(
            z.object({
              id: numeric,
              gameId: numeric,
              slug: z.string(),
              isClass: z.boolean().nullable(),
            }),
          )
          .max(1000)
          .parse(data)
          .filter(
            (category) =>
              category.gameId === minecraftGameId &&
              category.isClass === true &&
              category.slug === kind,
          );
        if (classes.length !== 1 || !classes[0]) unavailable(`curseforge_${kind}_class`);
        return classes[0].id;
      })
      .catch((error) => {
        this.catalogClasses.delete(kind);
        throw error;
      });
    this.catalogClasses.set(kind, pending);
    return pending;
  }
  private async catalogProject(
    kind: 'worlds' | 'data-packs',
    projectId: number,
    signal?: AbortSignal,
  ) {
    const [classId, raw] = await Promise.all([
      this.getCatalogClass(kind, signal),
      this.get(`/mods/${projectId}`, signal),
    ]);
    const project = worldProjectSchema.parse(raw);
    if (
      project.id !== projectId ||
      project.gameId !== minecraftGameId ||
      project.classId !== classId
    )
      fail('curseforge_world_identity');
    return project;
  }
  private async searchCatalog(
    kind: 'worlds' | 'data-packs',
    query: string,
    offset = 0,
    gameVersion?: string,
    signal?: AbortSignal,
  ): Promise<WorldCatalogProjects> {
    worldOffset(offset);
    if (
      query.length > 256 ||
      (gameVersion !== undefined && (!gameVersion || gameVersion.length > 80))
    )
      fail('search');
    const classId = await this.getCatalogClass(kind, signal);
    const params = new URLSearchParams({
      gameId: String(minecraftGameId),
      classId: String(classId),
      searchFilter: query,
      index: String(offset),
      pageSize: String(worldPageSize),
      sortField: '6',
      sortOrder: 'desc',
    });
    if (gameVersion) params.set('gameVersion', gameVersion);
    const response = await this.request(`/mods/search?${params}`, signal);
    const projects = z.array(worldProjectSchema).max(worldPageSize).parse(response.data);
    if (
      projects.some((project) => project.gameId !== minecraftGameId || project.classId !== classId)
    )
      fail('curseforge_world_identity');
    return worldCatalogProjectsSchema.parse({
      ...worldPagination(response.pagination, offset, projects.length),
      items: projects.map((project) => {
        const image = httpsUrl(project.logo?.thumbnailUrl);
        return {
          id: String(project.id),
          name: project.name,
          summary: project.summary,
          websiteUrl: `https://www.curseforge.com/minecraft/${kind}/${project.slug}`,
          ...(image && ['media.forgecdn.net', 'mediafilez.forgecdn.net'].includes(image.hostname)
            ? { imageUrl: image.href }
            : {}),
          authors: project.authors.map((author) => author.name),
          downloads: project.downloadCount,
        };
      }),
    });
  }
  private async catalogFiles(
    kind: 'worlds' | 'data-packs',
    projectId: string,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<DatapackCatalogFiles> {
    worldOffset(offset);
    const pid = worldId(projectId);
    const [project, response] = await Promise.all([
      this.catalogProject(kind, pid, signal),
      this.request(`/mods/${pid}/files?index=${offset}&pageSize=${worldPageSize}`, signal),
    ]);
    const files = z.array(worldFileSchema).max(worldPageSize).parse(response.data);
    if (files.some((file) => file.gameId !== minecraftGameId || file.modId !== pid))
      fail('curseforge_world_identity');
    return (kind === 'data-packs' ? datapackCatalogFilesSchema : worldCatalogFilesSchema).parse({
      ...worldPagination(response.pagination, offset, files.length),
      items: files.map((file) => ({
        id: String(file.id),
        projectId,
        name: file.displayName,
        filename: file.fileName,
        gameVersions: file.gameVersions,
        publishedAt: file.fileDate,
        bytes: file.fileLength,
        available:
          project.isAvailable &&
          project.allowModDistribution !== false &&
          file.isAvailable &&
          Boolean(worldFileIntegrity(file)),
        ...(kind === 'data-packs'
          ? {
              unavailableReason:
                !project.isAvailable ||
                project.allowModDistribution === false ||
                !file.isAvailable ||
                !file.downloadUrl
                  ? 'distribution'
                  : !worldFileIntegrity(file)
                    ? 'archive'
                    : undefined,
            }
          : {}),
      })),
    });
  }
  private async catalogArchive(
    kind: 'worlds' | 'data-packs',
    projectId: string,
    fileId: string,
    signal?: AbortSignal,
  ): Promise<ContentArtifact> {
    const pid = worldId(projectId);
    const fid = worldId(fileId);
    const [project, raw] = await Promise.all([
      this.catalogProject(kind, pid, signal),
      this.get(`/mods/${pid}/files/${fid}`, signal),
    ]);
    const file = worldFileSchema.parse(raw);
    if (file.gameId !== minecraftGameId || file.modId !== pid || file.id !== fid)
      fail('curseforge_world_identity');
    if (
      !project.isAvailable ||
      project.allowModDistribution === false ||
      !file.isAvailable ||
      !file.downloadUrl
    )
      unavailable('distribution_unavailable');
    const sha1 = worldFileIntegrity(file);
    if (!sha1) fail('curseforge_integrity');
    return {
      path: 'config/input.zip',
      urls: [file.downloadUrl],
      size: file.fileLength,
      hashes: { sha1 },
      projectId,
      versionId: fileId,
      kind: 'override',
      serverSide: 'required',
    };
  }
  searchWorlds(
    query: string,
    offset = 0,
    gameVersion?: string,
    signal?: AbortSignal,
  ): Promise<WorldCatalogProjects> {
    return this.searchCatalog('worlds', query, offset, gameVersion, signal);
  }
  worldFiles(projectId: string, offset = 0, signal?: AbortSignal): Promise<WorldCatalogFiles> {
    return this.catalogFiles('worlds', projectId, offset, signal);
  }
  worldArchive(
    projectId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<ContentArtifact> {
    return this.catalogArchive('worlds', projectId, versionId, signal);
  }
  searchDatapacks(
    query: string,
    offset = 0,
    gameVersion?: string,
    signal?: AbortSignal,
  ): Promise<WorldCatalogProjects> {
    return this.searchCatalog('data-packs', query, offset, gameVersion, signal);
  }
  datapackFiles(
    projectId: string,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<DatapackCatalogFiles> {
    return this.catalogFiles('data-packs', projectId, offset, signal);
  }
  datapackArchive(
    projectId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<ContentArtifact> {
    return this.catalogArchive('data-packs', projectId, versionId, signal);
  }
  async resolveDatapackPlan(
    projectId: string,
    versionId: string,
    gameVersion: string,
    signal?: AbortSignal,
    optionalProjectIds: string[] = [],
    installedVersions: ReadonlyMap<string, string> = new Map(),
  ) {
    worldId(projectId);
    worldId(versionId);
    for (const value of optionalProjectIds) worldId(value);
    const memo = dependencyMemo(this.limits.maxDependencies);
    const classId = await this.getCatalogClass('data-packs', signal);
    return resolveDatapackGraph({
      provider: 'curseforge',
      projectId,
      versionId,
      gameVersion,
      signal,
      optionalProjectIds,
      maxDependencies: this.limits.maxDependencies,
      load: (pid, vid) =>
        memo(`candidate:${pid}:${vid ?? ''}`, async (): Promise<DatapackCandidate> => {
          if (!pid) fail('dependency_identity');
          worldId(pid);
          if (vid) worldId(vid);
          const metadata = await memo(`project:${pid}`, async () =>
            worldProjectSchema.parse(await this.get(`/mods/${pid}`, signal)),
          );
          if (String(metadata.id) !== pid || metadata.gameId !== minecraftGameId)
            fail('dependency_identity');
          const isDatapack = metadata.classId === classId;
          let file: z.infer<typeof worldFileSchema> | undefined;
          if (vid)
            file = await memo(`file:${pid}:${vid}`, async () =>
              worldFileSchema.parse(await this.get(`/mods/${pid}/files/${vid}`, signal)),
            );
          else {
            const preferredId = installedVersions.get(pid);
            if (preferredId) {
              worldId(preferredId);
              const preferred = await memo(`file:${pid}:${preferredId}`, async () =>
                worldFileSchema.parse(await this.get(`/mods/${pid}/files/${preferredId}`, signal)),
              );
              if (
                String(preferred.modId) !== pid ||
                String(preferred.id) !== preferredId ||
                preferred.gameId !== minecraftGameId
              )
                fail('dependency_identity');
              if (preferred.gameVersions.includes(gameVersion)) file = preferred;
              // Preserve incompatible installed mod evidence so it cannot satisfy a requirement.
              else if (!isDatapack) file = preferred;
            }
          }
          if (!file && isDatapack && !vid)
            file = await memo(`versions:${pid}`, async () => {
              const params = new URLSearchParams({ gameVersion, pageSize: '50', index: '0' });
              const files = z
                .array(worldFileSchema)
                .max(50)
                .parse(await this.get(`/mods/${pid}/files?${params}`, signal));
              if (
                files.some(
                  (entry) => String(entry.modId) !== pid || entry.gameId !== minecraftGameId,
                )
              )
                fail('dependency_identity');
              return files
                .filter((entry) => entry.gameVersions.includes(gameVersion))
                .sort((a, b) => b.fileDate.localeCompare(a.fileDate) || b.id - a.id)[0];
            });
          if (
            file &&
            (String(file.modId) !== pid ||
              file.gameId !== minecraftGameId ||
              (vid && String(file.id) !== vid))
          )
            fail('dependency_identity');
          const sha1 = file ? worldFileIntegrity(file) : undefined;
          const allowed =
            metadata.isAvailable &&
            metadata.allowModDistribution !== false &&
            file?.isAvailable &&
            file.downloadUrl;
          return {
            projectId: pid,
            ...(file ? { versionId: String(file.id), filename: file.fileName } : {}),
            name: metadata.name,
            kind: isDatapack ? 'datapack' : metadata.classId === 6 ? 'mod' : 'unknown',
            compatible: Boolean(file?.gameVersions.includes(gameVersion)),
            dependencies:
              file?.dependencies.map((dependency) => {
                const relation = (
                  {
                    1: 'embedded',
                    2: 'optional',
                    3: 'required',
                    4: 'optional',
                    5: 'incompatible',
                    6: 'embedded',
                  } as const
                )[dependency.relationType as 1 | 2 | 3 | 4 | 5 | 6];
                if (!relation) fail('dependency_relation');
                return { projectId: String(dependency.modId), relation };
              }) ?? [],
            ...(isDatapack && allowed && sha1 && file?.downloadUrl
              ? {
                  artifact: {
                    path: 'config/input.zip',
                    urls: [file.downloadUrl],
                    size: file.fileLength,
                    hashes: { sha1 },
                    projectId: pid,
                    versionId: String(file.id),
                    kind: 'override' as const,
                    serverSide: 'required' as const,
                  },
                }
              : {}),
          };
        }),
    });
  }
  async search(query: string, target: ContentTarget): Promise<unknown> {
    if (query.length > 256) fail('search');
    const loader = loaderIds[target.loader];
    if (!loader) fail('curseforge_loader');
    return this.get(
      `/mods/search?${new URLSearchParams({ gameId: '432', classId: '6', searchFilter: query, gameVersion: target.minecraftVersion, modLoaderType: String(loader), pageSize: '20' })}`,
    );
  }
  async project(projectId: number) {
    numeric.parse(projectId);
    return projectSchema.parse(await this.get(`/mods/${projectId}`));
  }
  async file(projectId: number, fileId: number): Promise<CurseForgeFile> {
    numeric.parse(projectId);
    numeric.parse(fileId);
    const file = fileSchema.parse(await this.get(`/mods/${projectId}/files/${fileId}`));
    if (file.modId !== projectId || file.id !== fileId) fail('curseforge_identity');
    return file;
  }
  async versions(projectId: number, target: ContentTarget): Promise<CurseForgeFile[]> {
    numeric.parse(projectId);
    const loader = loaderIds[target.loader];
    if (!loader) fail('curseforge_loader');
    return z
      .array(fileSchema)
      .max(10000)
      .parse(
        await this.get(
          `/mods/${projectId}/files?${new URLSearchParams({ gameVersion: target.minecraftVersion, modLoaderType: String(loader), pageSize: '50' })}`,
        ),
      )
      .filter(
        (f) =>
          f.gameVersions.includes(target.minecraftVersion) &&
          f.gameVersions.includes(loaderNames[target.loader]),
      )
      .sort((a, b) => b.id - a.id);
  }
  async resolve(projectId: number, fileId: number, target: ContentTarget): Promise<ContentPlan> {
    return this.resolveMany([{ projectID: projectId, fileID: fileId }], target);
  }
  async resolveMany(
    roots: readonly { projectID: number; fileID: number }[],
    target: ContentTarget,
  ): Promise<ContentPlan> {
    const plan: ContentPlan = {
      format: 'curseforge',
      target,
      artifacts: [],
      overrides: [],
      projects: [],
      warnings: [],
    };
    const selected = new Map<number, number>(roots.map((r) => [r.projectID, r.fileID]));
    if (selected.size !== roots.length) fail('dependency_version_conflict');
    const visited = new Set<number>();
    const conflicts = new Set<number>();
    const visit = async (pid: number, fid?: number): Promise<void> => {
      if (visited.has(pid)) {
        if (fid && selected.get(pid) !== fid) fail('dependency_version_conflict');
        return;
      }
      if (visited.size >= this.limits.maxDependencies) fail('dependency_budget');
      visited.add(pid);
      const project = await this.project(pid);
      if (project.id !== pid || project.allowModDistribution === false)
        unavailable('distribution_denied');
      const file = fid ? await this.file(pid, fid) : (await this.versions(pid, target))[0];
      if (!file || file.modId !== pid || !file.isAvailable || !file.downloadUrl)
        unavailable('distribution_unavailable');
      if (
        !file.gameVersions.includes(target.minecraftVersion) ||
        !loaderNames[target.loader] ||
        !file.gameVersions.includes(loaderNames[target.loader])
      )
        fail('content_compatibility');
      if (selected.has(pid) && selected.get(pid) !== file.id) fail('dependency_version_conflict');
      selected.set(pid, file.id);
      const sha1 = file.hashes.find((h) => h.algo === 1)?.value.toLowerCase();
      if (
        !sha1 ||
        !/^[a-f0-9]{40}$/.test(sha1) ||
        !file.fileName.endsWith('.jar') ||
        file.fileName.includes('/')
      )
        fail('curseforge_integrity');
      // CF API does not prove execution side. Staging requires inspectable JAR side evidence.
      plan.artifacts.push({
        path: `mods/${file.fileName}`,
        urls: [file.downloadUrl],
        size: file.fileLength,
        hashes: { sha1 },
        projectId: String(pid),
        versionId: String(file.id),
        kind: 'mod',
        serverSide: 'unknown',
      });
      const dependencies: string[] = [];
      const exclusions: { provider: 'curseforge'; projectId: string }[] = [];
      for (const dependency of file.dependencies) {
        if (dependency.relationType === 3) {
          dependencies.push(String(dependency.modId));
          await visit(dependency.modId, selected.get(dependency.modId));
        } else if (dependency.relationType === 5) {
          conflicts.add(dependency.modId);
          exclusions.push({ provider: 'curseforge', projectId: String(dependency.modId) });
        } else if (![1, 2, 4, 6].includes(dependency.relationType)) fail('dependency_relation');
      }
      plan.projects.push({
        provider: 'curseforge',
        projectId: String(pid),
        versionId: String(file.id),
        dependencies,
        incompatible: exclusions,
      });
    };
    for (const root of roots) await visit(root.projectID, root.fileID);
    if ([...conflicts].some((pid) => selected.has(pid))) fail('dependency_incompatible');
    return validateContentPlan(plan);
  }
}
