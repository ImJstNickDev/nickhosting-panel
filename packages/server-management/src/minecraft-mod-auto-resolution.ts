import type { ContentTarget } from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';
import type { ModResolution, ModSelection } from '../../content-providers/src/mod-catalog.js';
import {
  createModMetadataMemo,
  type ResolvedMods,
} from '../../content-providers/src/mod-resolution.js';
import { findModAlternative, type ModAdviceProvider } from './minecraft-mod-advice.js';

function hasRootBlockers(catalog: ModResolution, projectId: string): boolean {
  const byId = new Map(catalog.items.map((item) => [item.project.id, item]));
  const reachable = new Set<string>();
  const pending = [projectId];
  while (pending.length) {
    const id = pending.pop();
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...(byId.get(id)?.dependencies.map((dependency) => dependency.projectId) ?? []));
  }
  return catalog.blocked.some(
    (item) => reachable.has(item.projectId) || reachable.has(item.requiredBy),
  );
}

// A shared missing dependency can move from root A to root B after fixing A.
// Its reporter/name are presentation details, not a newly introduced failure.
const blockerKey = (item: ModResolution['blocked'][number]) =>
  JSON.stringify([item.provider, item.projectId, item.versionId ?? null, item.reason]);

/** One deterministic sweep over problematic roots, before artifacts are acquired.
 * Requested roots stay unchanged: effective selections live in the returned plan. */
export async function resolveModsAutomatically(input: {
  provider: ModAdviceProvider;
  roots: ModSelection[];
  target: ContentTarget;
  preferBeta: boolean;
  maxVersions: number;
  installedVersions?: ReadonlyMap<string, string>;
  signal?: AbortSignal;
  replacePinned: boolean;
}): Promise<ResolvedMods> {
  input.signal?.throwIfAborted();
  const metadataMemo = createModMetadataMemo();
  let roots = input.roots;
  let resolved = await input.provider.resolveMods(roots, input.target, {
    preferBeta: input.preferBeta,
    installedVersions: input.installedVersions,
    signal: input.signal,
    metadataMemo,
  });
  input.signal?.throwIfAborted();
  if (!resolved.catalog.blocked.length || input.maxVersions <= 0) return resolved;
  const deadline = AbortSignal.timeout(30_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  let remaining = input.maxVersions;
  for (const root of input.roots) {
    input.signal?.throwIfAborted();
    if (signal.aborted || remaining <= 0 || !resolved.catalog.blocked.length) break;
    if (
      root.forceIncompatible ||
      (root.versionId && !input.replacePinned) ||
      !hasRootBlockers(resolved.catalog, root.projectId)
    )
      continue;
    const knownBlockers = new Set(resolved.catalog.blocked.map(blockerKey));
    let result: Awaited<ReturnType<typeof findModAlternative>>;
    try {
      result = await findModAlternative({
        provider: input.provider,
        projectId: root.projectId,
        roots,
        target: input.target,
        preferBeta: input.preferBeta,
        maxVersions: remaining,
        installedVersions: input.installedVersions,
        metadataMemo,
        signal,
        excludeVersionId: resolved.catalog.items.find((item) => item.project.id === root.projectId)
          ?.version.id,
        accept: (candidate) =>
          !hasRootBlockers(candidate.catalog, root.projectId) &&
          candidate.catalog.blocked.every((item) => knownBlockers.has(blockerKey(item))),
      });
    } catch (error) {
      input.signal?.throwIfAborted();
      // The initial diagnosis remains useful when an optional fallback lookup
      // is rate-limited or unavailable. Stop the sweep instead of retrying other roots.
      if (
        signal.aborted ||
        (error instanceof DomainError &&
          (error.code === 'integration_unavailable' || error.code === 'not_found'))
      )
        break;
      throw error;
    }
    input.signal?.throwIfAborted();
    remaining -= result.checked;
    if (result.match) {
      roots = result.match.roots;
      resolved = result.match.resolved;
    }
  }
  return resolved;
}
