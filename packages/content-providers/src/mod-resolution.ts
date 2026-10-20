import { DomainError } from '@nickhosting/core';
import {
  type ContentArtifact,
  type ContentPlan,
  type ContentTarget,
  fail,
  validateContentPlan,
} from './contracts.js';
import {
  type ModCatalogProject,
  type ModCatalogVersion,
  type ModProvider,
  type ModResolution,
  type ModSelection,
  modResolutionSchema,
  modSelectionSchema,
} from './mod-catalog.js';

export interface ModCandidate {
  project: ModCatalogProject;
  version?: ModCatalogVersion;
  artifact?: ContentArtifact;
  dependencies: {
    projectId?: string;
    versionId?: string;
    relation: 'required' | 'optional' | 'embedded' | 'incompatible';
  }[];
}
export interface ResolveModsOptions {
  preferBeta?: boolean;
  signal?: AbortSignal;
  installedVersions?: ReadonlyMap<string, string>;
}
export interface ModCatalogSearchInput {
  query: string;
  target: ContentTarget;
  offset?: number;
  includeIncompatible?: boolean;
  signal?: AbortSignal;
}
export interface ModCatalogVersionsInput {
  target: ContentTarget;
  offset?: number;
  includeIncompatible?: boolean;
  preferBeta?: boolean;
  signal?: AbortSignal;
}
export interface ResolvedMods {
  plan: ContentPlan;
  catalog: ModResolution;
}

/** A single memoized graph across all selected roots. No downloaded bytes or remote effects. */
export async function resolveModGraph(options: {
  provider: ModProvider;
  roots: ModSelection[];
  target: ContentTarget;
  limit: number;
  signal?: AbortSignal;
  load: (projectId?: string, versionId?: string) => Promise<ModCandidate>;
  project: (projectId: string) => Promise<ModCatalogProject>;
}): Promise<ResolvedMods> {
  const limit = Math.min(512, options.limit);
  if (options.roots.length > limit) fail('dependency_budget');
  const roots = options.roots.map((root) => modSelectionSchema.parse(root));
  if (roots.some((root) => root.forceIncompatible && !root.versionId))
    fail('content_override_requires_version');
  const rootMap = new Map(roots.map((root) => [root.projectId, root]));
  if (rootMap.size !== roots.length) fail('dependency_version_conflict');
  const pins = new Map(
    roots.flatMap((root) => (root.versionId ? [[root.projectId, root.versionId] as const] : [])),
  );
  const optional = new Set(roots.flatMap((root) => root.optionalProjectIds));
  const load = async (pid?: string, vid?: string) => {
    try {
      return await options.load(pid, vid);
    } catch (error) {
      if (
        error instanceof DomainError &&
        (error.code === 'not_found' ||
          (error.details?.reason === 'content_http_refused' &&
            error.details.providerStatus === 404))
      )
        return undefined;
      throw error;
    }
  };
  for (let pass = 0; pass <= limit; pass++) {
    const catalog: ModResolution = { items: [], optional: [], embedded: [], blocked: [] };
    const plan: ContentPlan = {
      format: 'individual',
      target: options.target,
      artifacts: [],
      overrides: [],
      projects: [],
      warnings: [],
    };
    const visited = new Map<string, ModCandidate>();
    const queue = roots.map((root) => ({
      projectId: root.projectId as string | undefined,
      versionId: root.versionId,
      requiredBy: root.projectId,
    }));
    const notice = (pid: string, vid: string | undefined, name: string, requiredBy: string) => ({
      provider: options.provider,
      projectId: pid,
      ...(vid ? { versionId: vid } : {}),
      name,
      requiredBy,
    });
    const block = (
      pid: string,
      vid: string | undefined,
      name: string,
      requiredBy: string,
      reason: ModResolution['blocked'][number]['reason'],
    ) => {
      catalog.blocked.push({ ...notice(pid, vid, name, requiredBy), reason });
    };
    let restart = false;
    let edges = 0;
    while (queue.length) {
      options.signal?.throwIfAborted();
      const request = queue.shift();
      if (!request) break;
      const pin =
        request.versionId ?? (request.projectId ? pins.get(request.projectId) : undefined);
      const prior = request.projectId ? visited.get(request.projectId) : undefined;
      if (prior && (!pin || prior.version?.id === pin)) {
        const item = catalog.items.find((entry) => entry.project.id === prior.project.id);
        if (
          item &&
          !item.requiredBy.includes(request.requiredBy) &&
          request.requiredBy !== item.project.id
        )
          item.requiredBy.push(request.requiredBy);
        continue;
      }
      if (!prior && visited.size >= limit) fail('dependency_budget');
      const candidate = await load(request.projectId, pin);
      if (!candidate) {
        block(
          request.projectId ?? 'unknown',
          pin,
          request.projectId ?? 'unknown',
          request.requiredBy,
          'unresolved',
        );
        continue;
      }
      const pid = candidate.project.id;
      if (
        (request.projectId && pid !== request.projectId) ||
        (pin && candidate.version && candidate.version.id !== pin)
      )
        fail('dependency_identity');
      if (request.versionId) {
        const existingPin = pins.get(pid);
        if (existingPin && existingPin !== request.versionId) {
          block(
            pid,
            request.versionId,
            candidate.project.name,
            request.requiredBy,
            'version-conflict',
          );
          continue;
        }
        pins.set(pid, request.versionId);
        if (visited.has(pid) && visited.get(pid)?.version?.id !== request.versionId) {
          restart = true;
          break;
        }
      }
      if (visited.has(pid)) continue;
      visited.set(pid, candidate);
      const { version, artifact } = candidate;
      const forced =
        rootMap.get(pid)?.forceIncompatible === true && Boolean(rootMap.get(pid)?.versionId);
      if (!version) {
        block(pid, pin, candidate.project.name, request.requiredBy, 'unavailable');
        continue;
      }
      if (version.compatibility.length && !forced) {
        block(pid, version.id, candidate.project.name, request.requiredBy, 'incompatible-version');
        continue;
      }
      if (!version.available || !artifact) {
        block(pid, version.id, candidate.project.name, request.requiredBy, 'unavailable');
        continue;
      }
      const item: ModResolution['items'][number] = {
        project: candidate.project,
        version,
        root: rootMap.has(pid),
        forced,
        requiredBy: request.requiredBy === pid ? [] : [request.requiredBy],
        dependencies: [],
        conflicts: [],
      };
      catalog.items.push(item);
      plan.artifacts.push({
        ...artifact,
        ...(item.forced
          ? {
              allowClientOnly: true as const,
              ...(version.compatibility.length
                ? { compatibilityOverride: [...version.compatibility] }
                : {}),
            }
          : {}),
      });
      if (item.forced)
        plan.warnings.push(
          `forced:${options.provider}:${pid}:${version.id}:${version.compatibility.join(',')}`,
        );
      for (const dependency of candidate.dependencies) {
        if (++edges > limit * 4) fail('dependency_budget');
        const pinned = dependency.versionId
          ? await load(dependency.projectId, dependency.versionId)
          : undefined;
        if (pinned && dependency.projectId && pinned.project.id !== dependency.projectId)
          fail('dependency_identity');
        const depId = pinned?.project.id ?? dependency.projectId;
        if (!depId) {
          if (dependency.relation === 'required')
            block('unknown', dependency.versionId, 'unknown', pid, 'unresolved');
          continue;
        }
        const ref = {
          provider: options.provider,
          projectId: depId,
          ...(dependency.versionId ? { versionId: dependency.versionId } : {}),
        };
        if (dependency.relation === 'incompatible') {
          item.conflicts.push(ref);
          continue;
        }
        if (dependency.relation === 'optional' || dependency.relation === 'embedded') {
          let name = pinned?.project.name ?? depId;
          if (!pinned) {
            try {
              name = (await options.project(depId)).name;
            } catch (error) {
              if (
                !(
                  error instanceof DomainError &&
                  (error.code === 'not_found' ||
                    (error.details?.reason === 'content_http_refused' &&
                      error.details.providerStatus === 404))
                )
              )
                throw error;
            }
          }
          catalog[dependency.relation].push(notice(depId, dependency.versionId, name, pid));
          if (dependency.relation === 'embedded' || !optional.has(depId)) continue;
        }
        item.dependencies.push(ref);
        queue.push({ projectId: depId, versionId: dependency.versionId, requiredBy: pid });
      }
      plan.projects.push({
        provider: options.provider,
        projectId: pid,
        versionId: version.id,
        dependencies: item.dependencies.map((ref) => ref.projectId),
        incompatible: item.conflicts,
      });
    }
    if (restart) continue;
    for (const item of catalog.items)
      for (const conflict of item.conflicts) {
        const match = catalog.items.find(
          (other) =>
            other.project.id === conflict.projectId &&
            (!conflict.versionId || other.version.id === conflict.versionId),
        );
        if (match)
          block(
            match.project.id,
            match.version.id,
            match.project.name,
            item.project.id,
            'conflict',
          );
      }
    // Different projects distributing the same filename cannot overwrite one another.
    const paths = new Map<string, ContentArtifact>();
    plan.artifacts = plan.artifacts.filter((artifact) => {
      const previous = paths.get(artifact.path.toLowerCase());
      if (!previous) {
        paths.set(artifact.path.toLowerCase(), artifact);
        return true;
      }
      const item = catalog.items.find((entry) => entry.project.id === artifact.projectId);
      block(
        artifact.projectId ?? 'unknown',
        artifact.versionId,
        item?.project.name ?? artifact.path,
        previous.projectId ?? 'unknown',
        'conflict',
      );
      return false;
    });
    return { plan: validateContentPlan(plan), catalog: modResolutionSchema.parse(catalog) };
  }
  return fail('dependency_budget');
}
