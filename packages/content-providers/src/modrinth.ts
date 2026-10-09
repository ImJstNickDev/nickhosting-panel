import { z } from 'zod';
import {
  type ContentHttp,
  type ContentLimits,
  type ContentPlan,
  type ContentTarget,
  contentLimits,
  fail,
  hashesSchema,
  safeContentPath,
  validateContentPlan,
} from './contracts.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const projectSchema = z.object({
  id,
  slug: z.string().optional(),
  title: z.string(),
  project_type: z.enum(['mod', 'plugin', 'modpack', 'resourcepack', 'shader', 'datapack']),
  server_side: z.enum(['required', 'optional', 'unsupported', 'unknown']).optional(),
  environment: z.union([z.string(), z.array(z.string()).max(32)]).optional(),
});
const versionSchema = z.object({
  id,
  project_id: id,
  name: z.string(),
  version_number: z.string(),
  game_versions: z.array(z.string()),
  loaders: z.array(z.string()),
  date_published: z.string(),
  environment: z.string().optional(),
  files: z
    .array(
      z.object({
        url: z.string().url(),
        filename: z.string(),
        size: z.number().int().nonnegative(),
        hashes: hashesSchema,
        primary: z.boolean().default(false),
      }),
    )
    .min(1),
  dependencies: z
    .array(
      z.object({
        version_id: id.nullable().optional(),
        project_id: id.nullable().optional(),
        file_name: z.string().nullable().optional(),
        dependency_type: z.enum(['required', 'optional', 'incompatible', 'embedded']),
      }),
    )
    .default([]),
});
export type ModrinthProject = z.infer<typeof projectSchema>;
export type ModrinthVersion = z.infer<typeof versionSchema>;
const serverEnvironments = new Set([
  'client_and_server',
  'client_only_server_optional',
  'server_only',
  'server_only_client_optional',
  'dedicated_server_only',
  'client_or_server',
  'client_or_server_prefers_both',
]);
function serverSupported(project: ModrinthProject, version: ModrinthVersion): boolean {
  if (version.environment !== undefined) return serverEnvironments.has(version.environment);
  if (project.environment !== undefined) {
    const environments = Array.isArray(project.environment)
      ? project.environment
      : [project.environment];
    return (
      environments.length > 0 &&
      environments.every((environment) => serverEnvironments.has(environment))
    );
  }
  return project.server_side === 'required' || project.server_side === 'optional';
}
export class ModrinthProvider {
  readonly origin: string;
  constructor(
    readonly http: ContentHttp,
    options: { apiBase?: string; limits?: Partial<ContentLimits> } = {},
  ) {
    this.origin = options.apiBase ?? 'https://api.modrinth.com/v2';
    this.limits = contentLimits(options.limits);
  }
  private readonly limits: ContentLimits;
  async search(
    query: string,
    target: ContentTarget,
    type: 'mod' | 'plugin' | 'modpack' = 'mod',
    offset = 0,
  ): Promise<unknown> {
    if (query.length > 256 || !Number.isSafeInteger(offset) || offset < 0) fail('search');
    const facets = JSON.stringify([
      [`project_type:${type}`],
      [`versions:${target.minecraftVersion}`],
      [`categories:${target.loader}`],
    ]);
    return this.http.json(
      `${this.origin}/search?${new URLSearchParams({ query, facets, offset: String(offset), limit: '20' })}`,
    );
  }
  /** Pack discovery precedes runtime selection; the wizard later verifies the archive's exact loader. */
  async searchModpacks(query: string, offset = 0): Promise<unknown> {
    if (query.length > 256 || !Number.isSafeInteger(offset) || offset < 0) fail('search');
    return this.http.json(
      `${this.origin}/search?${new URLSearchParams({
        query,
        facets: JSON.stringify([['project_type:modpack']]),
        offset: String(offset),
        limit: '20',
      })}`,
    );
  }
  async modpackVersions(projectId: string): Promise<ModrinthVersion[]> {
    const project = await this.project(projectId);
    if (project.project_type !== 'modpack') fail('modpack_project');
    const versions = z
      .array(versionSchema)
      .max(10000)
      .parse(
        await this.http.json(`${this.origin}/project/${encodeURIComponent(projectId)}/version`),
      );
    if (versions.some((version) => version.project_id !== project.id)) fail('modpack_identity');
    return versions;
  }
  async project(projectId: string): Promise<ModrinthProject> {
    id.parse(projectId);
    return projectSchema.parse(
      await this.http.json(`${this.origin}/project/${encodeURIComponent(projectId)}`),
    );
  }
  async version(versionId: string): Promise<ModrinthVersion> {
    id.parse(versionId);
    return versionSchema.parse(
      await this.http.json(`${this.origin}/version/${encodeURIComponent(versionId)}`),
    );
  }
  async versions(projectId: string, target: ContentTarget): Promise<ModrinthVersion[]> {
    id.parse(projectId);
    const params = new URLSearchParams({
      game_versions: JSON.stringify([target.minecraftVersion]),
      loaders: JSON.stringify([target.loader]),
    });
    return z
      .array(versionSchema)
      .max(10000)
      .parse(
        await this.http.json(
          `${this.origin}/project/${encodeURIComponent(projectId)}/version?${params}`,
        ),
      )
      .filter(
        (v) =>
          v.game_versions.includes(target.minecraftVersion) && v.loaders.includes(target.loader),
      )
      .sort((a, b) => b.date_published.localeCompare(a.date_published) || a.id.localeCompare(b.id));
  }
  async modpackArchive(
    projectId: string,
    versionId: string,
  ): Promise<import('./contracts.js').ContentArtifact> {
    const project = await this.project(projectId);
    const version = await this.version(versionId);
    if (
      project.project_type !== 'modpack' ||
      version.project_id !== project.id ||
      !serverSupported(project, version)
    )
      fail('modpack_compatibility');
    const primary = version.files.filter((file) => file.primary);
    const file =
      primary.length === 1 ? primary[0] : version.files.length === 1 ? version.files[0] : undefined;
    if (!file?.filename.endsWith('.mrpack') || file.filename.includes('/'))
      fail('artifact_ambiguous');
    return {
      path: 'config/input.mrpack',
      urls: [file.url],
      size: file.size,
      hashes: file.hashes,
      kind: 'override',
      serverSide: 'required',
      projectId: project.id,
      versionId: version.id,
    };
  }
  async resolve(projectId: string, versionId: string, target: ContentTarget): Promise<ContentPlan> {
    const plan: ContentPlan = {
      format: 'individual',
      target,
      artifacts: [],
      overrides: [],
      projects: [],
      warnings: [],
    };
    const selected = new Map<string, string>();
    const active = new Set<string>();
    const incompatible: { project: string; version?: string }[] = [];
    const visit = async (pid: string, vid?: string): Promise<void> => {
      if (selected.size >= this.limits.maxDependencies && !selected.has(pid))
        fail('dependency_budget');
      const project = await this.project(pid);
      const version = vid ? await this.version(vid) : (await this.versions(project.id, target))[0];
      if (
        !version ||
        version.project_id !== project.id ||
        !version.game_versions.includes(target.minecraftVersion) ||
        !version.loaders.includes(target.loader)
      )
        fail('content_compatibility');
      if (!serverSupported(project, version)) fail('client_or_unknown_content');
      if (!['mod', 'plugin'].includes(project.project_type)) fail('content_kind');
      if ((project.project_type === 'plugin') !== ['paper', 'folia'].includes(target.loader))
        fail('content_loader');
      const previous = selected.get(project.id);
      if (previous && previous !== version.id) fail('dependency_version_conflict');
      if (previous || active.has(project.id)) return;
      selected.set(project.id, version.id);
      active.add(project.id);
      const primary = version.files.filter((f) => f.primary);
      const file =
        primary.length === 1
          ? primary[0]
          : version.files.length === 1
            ? version.files[0]
            : undefined;
      if (!file?.filename.endsWith('.jar') || file.filename.includes('/'))
        fail('artifact_ambiguous');
      const path = safeContentPath(
        `${project.project_type === 'plugin' ? 'plugins' : 'mods'}/${file.filename}`,
      );
      plan.artifacts.push({
        path,
        urls: [file.url],
        size: file.size,
        hashes: file.hashes,
        projectId: project.id,
        versionId: version.id,
        kind: project.project_type === 'plugin' ? 'plugin' : 'mod',
        serverSide: 'required',
      });
      const dependencies: string[] = [];
      const exclusions: { provider: 'modrinth'; projectId: string; versionId?: string }[] = [];
      for (const dependency of version.dependencies) {
        if (dependency.dependency_type === 'optional' || dependency.dependency_type === 'embedded')
          continue;
        const pinned = dependency.version_id
          ? await this.version(dependency.version_id)
          : undefined;
        if (pinned && dependency.project_id && pinned.project_id !== dependency.project_id)
          fail('dependency_identity');
        const depProject = pinned?.project_id ?? dependency.project_id;
        if (!depProject) fail('unresolved_dependency');
        if (dependency.dependency_type === 'incompatible') {
          incompatible.push({ project: depProject, version: pinned?.id });
          exclusions.push({
            provider: 'modrinth',
            projectId: depProject,
            ...(pinned ? { versionId: pinned.id } : {}),
          });
          continue;
        }
        dependencies.push(depProject);
        await visit(depProject, pinned?.id);
      }
      active.delete(project.id);
      plan.projects.push({
        provider: 'modrinth',
        projectId: project.id,
        versionId: version.id,
        dependencies,
        incompatible: exclusions,
      });
    };
    await visit(projectId, versionId);
    if (
      incompatible.some(
        (i) => selected.has(i.project) && (!i.version || selected.get(i.project) === i.version),
      )
    )
      fail('dependency_incompatible');
    return validateContentPlan(plan);
  }
}
