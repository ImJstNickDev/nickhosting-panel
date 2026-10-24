import { DomainError } from '@nickhosting/core';
import { type ContentArtifact, fail } from './contracts.js';
import { type DatapackDependencyPlan, datapackDependencyPlanSchema } from './world-catalog.js';

export type DatapackDependency = {
  projectId?: string;
  versionId?: string;
  name?: string;
  relation: 'required' | 'optional' | 'embedded' | 'incompatible';
};
export type DatapackCandidate = {
  projectId: string;
  versionId?: string;
  name: string;
  filename?: string;
  kind: 'datapack' | 'mod' | 'unknown';
  compatible: boolean;
  dependencies: DatapackDependency[];
  artifact?: ContentArtifact;
};
/** One bounded graph walk, with request-local memoization supplied by each provider.
 * Re-walk only when a newly discovered explicit pin changes an earlier unpinned choice.
 * No downloads, installed-state assumptions, or provider URLs enter the public plan. */
export async function resolveDatapackGraph(options: {
  provider: 'modrinth' | 'curseforge';
  projectId: string;
  versionId: string;
  gameVersion: string;
  optionalProjectIds: string[];
  maxDependencies: number;
  signal?: AbortSignal;
  load: (projectId: string | undefined, versionId?: string) => Promise<DatapackCandidate>;
}): Promise<{ plan: DatapackDependencyPlan; artifacts: ContentArtifact[] }> {
  const { provider, projectId, versionId, gameVersion, signal } = options;
  const load = async (pid: string | undefined, vid?: string): Promise<DatapackCandidate> => {
    try {
      return await options.load(pid, vid);
    } catch (error) {
      if (
        error instanceof DomainError &&
        (error.code === 'not_found' ||
          (error.details?.reason === 'content_http_refused' &&
            error.details.providerStatus === 404))
      ) {
        return {
          projectId: pid ?? vid ?? 'unknown',
          versionId: vid,
          name: pid ?? vid ?? 'unknown',
          kind: 'unknown',
          compatible: false,
          dependencies: [],
        };
      }
      throw error;
    }
  };
  const limit = Math.min(512, options.maxDependencies);
  if (!gameVersion || gameVersion.length > 80 || options.optionalProjectIds.length > limit)
    fail('dependency_budget');
  const pins = new Map<string, string>([[projectId, versionId]]);
  const selectedOptional = new Set(options.optionalProjectIds);
  for (let pass = 0; pass <= limit; pass++) {
    const plan: DatapackDependencyPlan = {
      provider,
      root: { projectId, versionId },
      gameVersion,
      items: [],
      optional: [],
      embedded: [],
      blocked: [],
    };
    const selected = new Map<string, DatapackCandidate>();
    const artifacts: ContentArtifact[] = [];
    const queue: { projectId?: string; versionId?: string; requiredBy: string; name?: string }[] = [
      { projectId, versionId, requiredBy: projectId },
    ];
    let restart = false;
    let edges = 0;
    const block = (
      candidate: DatapackCandidate,
      requiredBy: string,
      reason: DatapackDependencyPlan['blocked'][number]['reason'],
    ) => {
      plan.blocked.push({
        projectId: candidate.projectId,
        ...(candidate.versionId ? { versionId: candidate.versionId } : {}),
        name: candidate.name,
        requiredBy,
        reason,
      });
    };
    while (queue.length) {
      signal?.throwIfAborted();
      const request = queue.shift();
      if (!request) break;
      if (!request.projectId && !request.versionId) {
        plan.blocked.push({
          projectId: 'unknown',
          name: request.name ?? 'unknown',
          requiredBy: request.requiredBy,
          reason: 'unresolved',
        });
        continue;
      }
      const pinned =
        request.versionId ?? (request.projectId ? pins.get(request.projectId) : undefined);
      const prior = request.projectId ? selected.get(request.projectId) : undefined;
      if (prior && (!pinned || pinned === prior.versionId)) continue;
      if (!prior && selected.size >= limit) fail('dependency_budget');
      const candidate = await load(request.projectId, pinned);
      if (request.projectId && candidate.projectId !== request.projectId)
        fail('dependency_identity');
      if (pinned && candidate.versionId && candidate.versionId !== pinned)
        fail('dependency_identity');
      if (request.versionId) {
        const oldPin = pins.get(candidate.projectId);
        if (oldPin && oldPin !== request.versionId) {
          block(candidate, request.requiredBy, 'version-conflict');
          continue;
        }
        pins.set(candidate.projectId, request.versionId);
        const previous = selected.get(candidate.projectId);
        if (previous && previous.versionId !== request.versionId) {
          restart = true;
          break;
        }
      }
      if (selected.has(candidate.projectId)) continue;
      selected.set(candidate.projectId, candidate);
      if (candidate.kind !== 'datapack') {
        block(
          { ...candidate, versionId: pinned },
          request.requiredBy,
          candidate.kind === 'mod'
            ? candidate.versionId && !candidate.compatible
              ? 'incompatible-version'
              : 'mod'
            : 'unresolved',
        );
        continue;
      }
      if (!candidate.compatible || !candidate.versionId) {
        block(candidate, request.requiredBy, 'incompatible-version');
        continue;
      }
      if (!candidate.artifact || !candidate.filename) {
        block(candidate, request.requiredBy, 'unavailable');
        continue;
      }
      const item: DatapackDependencyPlan['items'][number] = {
        projectId: candidate.projectId,
        versionId: candidate.versionId,
        name: candidate.name,
        filename: candidate.filename,
        required: [],
        conflicts: [],
      };
      plan.items.push(item);
      artifacts.push(candidate.artifact);
      for (const dependency of candidate.dependencies) {
        if (++edges > limit) fail('dependency_budget');
        // Version-only Modrinth references still need their canonical project identity.
        const resolved = dependency.versionId
          ? await load(dependency.projectId, dependency.versionId)
          : dependency.projectId
            ? { projectId: dependency.projectId, name: dependency.name ?? dependency.projectId }
            : undefined;
        if (!resolved) {
          if (dependency.relation === 'required')
            queue.push({ ...dependency, requiredBy: candidate.projectId });
          continue;
        }
        const ref = {
          projectId: resolved.projectId,
          ...(dependency.versionId ? { versionId: dependency.versionId } : {}),
        };
        if (dependency.relation === 'incompatible') {
          item.conflicts.push(ref);
          continue;
        }
        if (dependency.relation === 'optional' || dependency.relation === 'embedded') {
          // Metadata only; never download optional/embedded payloads without selection.
          const info = await load(resolved.projectId, dependency.versionId);
          plan[dependency.relation].push({
            ...ref,
            name: info.name,
            requiredBy: candidate.projectId,
          });
          if (dependency.relation === 'embedded' || !selectedOptional.has(resolved.projectId))
            continue;
        }
        if (dependency.relation === 'required') item.required.push(ref);
        queue.push({ ...ref, requiredBy: candidate.projectId });
      }
    }
    if (restart) continue;
    for (const item of plan.items) {
      for (const conflict of item.conflicts) {
        const other = plan.items.find(
          (entry) =>
            entry.projectId === conflict.projectId &&
            (!conflict.versionId || entry.versionId === conflict.versionId),
        );
        if (other)
          plan.blocked.push({
            ...conflict,
            name: other.name,
            requiredBy: item.projectId,
            reason: 'conflict',
          });
      }
    }
    return { plan: datapackDependencyPlanSchema.parse(plan), artifacts };
  }
  return fail('dependency_budget');
}
/** Bound metadata fan-out and collapse duplicate project/version reads per resolution. */
export function dependencyMemo(limit: number) {
  const pending = new Map<string, Promise<unknown>>();
  return <T>(key: string, read: () => Promise<T>): Promise<T> => {
    const cached = pending.get(key);
    if (cached) return cached as Promise<T>;
    if (pending.size >= Math.min(512, limit) * 4 + 4) fail('dependency_budget');
    const result = read();
    pending.set(key, result);
    return result;
  };
}
