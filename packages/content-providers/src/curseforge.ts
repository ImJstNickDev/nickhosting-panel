import { z } from 'zod';
import {
  type ContentHttp,
  type ContentLimits,
  type ContentPlan,
  type ContentTarget,
  contentLimits,
  fail,
  unavailable,
  validateContentPlan,
} from './contracts.js';

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
  constructor(
    readonly http: ContentHttp,
    options: { apiKey: string; apiBase?: string; limits?: Partial<ContentLimits> },
  ) {
    if (!options.apiKey || /[\r\n]/.test(options.apiKey)) unavailable('curseforge_credentials');
    this.#key = options.apiKey;
    this.base = options.apiBase ?? 'https://api.curseforge.com/v1';
    this.limits = contentLimits(options.limits);
  }
  private async get(path: string): Promise<unknown> {
    const result = z
      .object({ data: z.unknown() })
      .parse(await this.http.json(`${this.base}${path}`, { headers: { 'x-api-key': this.#key } }));
    return result.data;
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
