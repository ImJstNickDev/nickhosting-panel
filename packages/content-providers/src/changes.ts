import {
  type ContentPlan,
  fail,
  type IncompatibleContent,
  incompatibleContentSchema,
  safeContentPath,
  validateContentPlan,
} from './contracts.js';

export interface InstalledContentFile {
  path: string;
  sha256: string;
  projectId?: string;
  versionId?: string;
  provider?: 'modrinth' | 'curseforge';
  dependencies?: string[];
  incompatible?: IncompatibleContent[];
}
export interface InstalledContentChange {
  removePaths: string[];
  replacements: { path: string; previousSha256: string }[];
}
/** Pure decisions only. Core must verify the recorded SHA-256 against each live file before any write/delete. */
export function installedContentChange(
  existing: readonly InstalledContentFile[],
  change: ContentPlan | { remove: { provider: 'modrinth' | 'curseforge'; projectId: string } },
): InstalledContentChange {
  const paths = new Set<string>();
  for (const file of existing) {
    safeContentPath(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || paths.has(file.path.toLowerCase()))
      fail('installed_inventory');
    paths.add(file.path.toLowerCase());
  }
  const identity = (provider: string | undefined, id: string | undefined) =>
    provider && id ? `${provider}:${id}` : undefined;
  const byIdentity = new Map<string, InstalledContentFile[]>();
  for (const file of existing) {
    const key = identity(file.provider, file.projectId);
    if (key) {
      const files = byIdentity.get(key) ?? [];
      files.push(file);
      byIdentity.set(key, files);
    }
  }
  const versions = new Map<string, string>();
  for (const [key, files] of byIdentity) {
    const set = new Set(files.map((f) => f.versionId));
    if (set.size > 1) fail('installed_version_conflict');
    if (files[0]?.versionId) versions.set(key, files[0].versionId);
  }
  if ('remove' in change) {
    const key = identity(change.remove.provider, change.remove.projectId) as string;
    const removed = byIdentity.get(key);
    if (!removed?.length) fail('content_not_installed');
    for (const file of existing)
      if (
        identity(file.provider, file.projectId) !== key &&
        file.provider === change.remove.provider &&
        file.dependencies?.includes(change.remove.projectId)
      )
        fail('dependency_still_required');
    return {
      removePaths: removed.map((f) => f.path),
      replacements: removed.map((f) => ({ path: f.path, previousSha256: f.sha256 })),
    };
  }
  const plan = validateContentPlan(change);
  const replacing = new Map(
    plan.projects.map((p) => [identity(p.provider, p.projectId) as string, p]),
  );
  if (replacing.size !== plan.projects.length) fail('plan_project_conflict');
  for (const file of existing) {
    const key = identity(file.provider, file.projectId);
    if (key && replacing.has(key)) continue;
    for (const dependency of file.dependencies ?? []) {
      const dep = identity(file.provider, dependency);
      const update = dep ? replacing.get(dep) : undefined;
      // Existing inventory stores project dependencies, not verified version ranges. Updating a
      // shared dependency requires resolving every dependent again; never guess compatibility.
      if (update && versions.get(dep as string) !== update.versionId)
        fail('dependency_update_requires_dependents');
    }
  }
  const resulting = new Map<
    string,
    {
      provider: string;
      projectId: string;
      versionId?: string;
      incompatible?: IncompatibleContent[];
    }
  >();
  for (const file of existing) {
    const key = identity(file.provider, file.projectId);
    if (!key || replacing.has(key) || !file.provider || !file.projectId) continue;
    const previous = resulting.get(key);
    if (
      previous &&
      JSON.stringify(previous.incompatible ?? []) !== JSON.stringify(file.incompatible ?? [])
    )
      fail('installed_constraint_conflict');
    for (const constraint of file.incompatible ?? [])
      if (!incompatibleContentSchema.safeParse(constraint).success) fail('installed_constraint');
    resulting.set(key, {
      provider: file.provider,
      projectId: file.projectId,
      versionId: file.versionId,
      incompatible: file.incompatible,
    });
  }
  for (const [key, project] of replacing) resulting.set(key, project);
  for (const project of resulting.values())
    for (const excluded of project.incompatible ?? []) {
      const forbidden = resulting.get(identity(excluded.provider, excluded.projectId) as string);
      if (forbidden && (!excluded.versionId || excluded.versionId === forbidden.versionId))
        fail('dependency_incompatible');
    }
  const destinations = new Set([...plan.artifacts, ...plan.overrides].map((f) => f.path));
  const removePaths: string[] = [];
  const replacements: { path: string; previousSha256: string }[] = [];
  for (const file of existing) {
    const key = identity(file.provider, file.projectId);
    const replacingProject = key ? replacing.has(key) : false;
    const replacement = plan.artifacts.find(
      (a) => a.path.toLowerCase() === file.path.toLowerCase(),
    );
    const override = plan.overrides.find((a) => a.path.toLowerCase() === file.path.toLowerCase());
    if (replacement || override) {
      if ((replacement?.path ?? override?.path) !== file.path) fail('content_case_conflict');
      if (file.projectId && (!replacingProject || replacement?.projectId !== file.projectId))
        fail('content_project_collision');
      replacements.push({ path: file.path, previousSha256: file.sha256 });
    } else if (replacingProject && !destinations.has(file.path)) {
      removePaths.push(file.path);
      replacements.push({ path: file.path, previousSha256: file.sha256 });
    }
  }
  return { removePaths, replacements };
}
