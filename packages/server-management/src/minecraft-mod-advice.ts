import type { ContentTarget } from '@nickhosting/content-providers';
import type {
  MinecraftModAlternatives,
  MinecraftModUpdates,
} from '../../../games/minecraft/src/mod-contracts.js';
import type {
  ModCatalogVersion,
  ModProvider,
  ModSelection,
} from '../../content-providers/src/mod-catalog.js';
import { recommendedModVersion } from '../../content-providers/src/mod-metadata.js';
import {
  createModMetadataMemo,
  type ModCatalogVersionsInput,
  type ResolvedMods,
  type ResolveModsOptions,
} from '../../content-providers/src/mod-resolution.js';

export interface ModAdviceProvider {
  modVersion(
    projectId: string,
    versionId: string,
    target: ContentTarget,
    signal?: AbortSignal,
    metadataMemo?: ReturnType<typeof createModMetadataMemo>,
  ): Promise<ModCatalogVersion>;
  modVersions(
    projectId: string,
    input: ModCatalogVersionsInput,
  ): Promise<{ items: ModCatalogVersion[]; total: number }>;
  resolveMods(
    roots: ModSelection[],
    target: ContentTarget,
    options?: ResolveModsOptions,
  ): Promise<ResolvedMods>;
}

/** Catalog-only advice. Three pages and two concurrent projects bound background work. */
export async function modAdviceVersions(
  provider: ModAdviceProvider,
  projectId: string,
  target: ContentTarget,
  preferBeta: boolean,
  signal?: AbortSignal,
  metadataMemo?: ReturnType<typeof createModMetadataMemo>,
) {
  const versions = new Map<string, ModCatalogVersion>();
  let complete = false;
  for (let offset = 0; offset < 60; offset += 20) {
    signal?.throwIfAborted();
    const page = await provider.modVersions(projectId, {
      target,
      offset,
      preferBeta,
      signal,
      metadataMemo,
    });
    for (const version of page.items) versions.set(version.id, version);
    complete = offset + page.items.length >= page.total || page.items.length === 0;
    const recommended = recommendedModVersion([...versions.values()], preferBeta);
    // A beta is only the default once the absence of stable releases is established.
    if (complete || (recommended && (preferBeta || recommended.channel === 'release'))) break;
  }
  return { versions: [...versions.values()], complete };
}

export async function modUpdateAdvice(input: {
  packs: { path: string; provider: ModProvider; projectId: string; versionId: string }[];
  target: ContentTarget;
  preferBeta: boolean;
  provider(name: ModProvider): ModAdviceProvider;
  signal?: AbortSignal;
}): Promise<MinecraftModUpdates> {
  const work = new Map<
    string,
    Promise<Pick<MinecraftModUpdates['items'][number], 'status' | 'version'>>
  >();
  const result: MinecraftModUpdates['items'] = [];
  let cursor = 0;
  async function inspect(pack: (typeof input.packs)[number]) {
    const provider = input.provider(pack.provider);
    const metadataMemo = createModMetadataMemo();
    const [current, page] = await Promise.all([
      provider.modVersion(pack.projectId, pack.versionId, input.target, input.signal, metadataMemo),
      modAdviceVersions(
        provider,
        pack.projectId,
        input.target,
        input.preferBeta,
        input.signal,
        metadataMemo,
      ),
    ]);
    const candidate = recommendedModVersion(page.versions, input.preferBeta);
    if (!candidate || (!page.complete && candidate.channel !== 'release' && !input.preferBeta))
      return { status: page.complete ? ('current' as const) : ('limited' as const) };
    // Provider version numbers are opaque. Published time prevents a stable preference
    // from offering an older release as an update to an installed beta/alpha.
    if (
      candidate.id !== current.id &&
      Date.parse(candidate.publishedAt) > Date.parse(current.publishedAt)
    )
      return { status: 'update' as const, version: candidate };
    return { status: 'current' as const };
  }
  const run = async () => {
    while (cursor < input.packs.length) {
      const index = cursor++;
      const pack = input.packs[index];
      if (!pack) continue;
      const key = `${pack.provider}:${pack.projectId}:${pack.versionId}`;
      let promise = work.get(key);
      if (!promise) {
        promise = input.signal?.aborted
          ? Promise.resolve({ status: 'unavailable' as const })
          : inspect(pack).catch(() => ({ status: 'unavailable' as const }));
        work.set(key, promise);
      }
      result[index] = {
        path: pack.path,
        provider: pack.provider,
        projectId: pack.projectId,
        currentVersionId: pack.versionId,
        ...(await promise),
      };
    }
  };
  await Promise.all([run(), run()]);
  return { checkedAt: new Date().toISOString(), items: result };
}

interface ModAlternativeMatch {
  version: ModCatalogVersion;
  roots: ModSelection[];
  resolved: ResolvedMods;
}

/** Shared bounded metadata search. The caller decides which remaining blockers are unrelated. */
export async function findModAlternative(input: {
  provider: ModAdviceProvider;
  projectId: string;
  roots: ModSelection[];
  maxVersions: number;
  target: ContentTarget;
  preferBeta: boolean;
  signal?: AbortSignal;
  metadataMemo?: ReturnType<typeof createModMetadataMemo>;
  installedVersions?: ReadonlyMap<string, string>;
  excludeVersionId?: string;
  accept(resolved: ResolvedMods): boolean;
}): Promise<{ match?: ModAlternativeMatch; checked: number; limited: boolean }> {
  const metadataMemo = input.metadataMemo ?? createModMetadataMemo();
  const root = input.roots.find((item) => item.projectId === input.projectId);
  const seen = new Set<string>();
  const deferredBeta: ModCatalogVersion[] = [];
  // Sparse/alpha-only catalogs must not cause unlimited metadata requests just
  // to fill the resolution budget. Keep at least the existing three-page window.
  const scanLimit = Math.max(60, Math.ceil(input.maxVersions / 20) * 20);
  let complete = false;
  let checked = 0;
  const result = (limited: boolean, match?: ModAlternativeMatch) => ({
    ...(match ? { match } : {}),
    checked,
    limited,
  });
  async function check(version: ModCatalogVersion) {
    input.signal?.throwIfAborted();
    const roots = input.roots.map((item) =>
      item.projectId === input.projectId
        ? { ...item, versionId: version.id, forceIncompatible: false }
        : item,
    );
    const resolved = await input.provider.resolveMods(roots, input.target, {
      preferBeta: input.preferBeta,
      signal: input.signal,
      metadataMemo,
      installedVersions: input.installedVersions,
    });
    checked++;
    return input.accept(resolved) ? { version, roots, resolved } : undefined;
  }
  try {
    for (let offset = 0; offset < scanLimit; offset += 20) {
      input.signal?.throwIfAborted();
      const page = await input.provider.modVersions(input.projectId, {
        target: input.target,
        offset,
        preferBeta: input.preferBeta,
        signal: input.signal,
        metadataMemo,
      });
      complete = offset + page.items.length >= page.total || page.items.length === 0;
      const ordered = [...page.items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
      for (const version of ordered) {
        if (seen.has(version.id)) continue;
        seen.add(version.id);
        if (
          version.id === root?.versionId ||
          version.id === input.excludeVersionId ||
          !version.available ||
          version.compatibility.length ||
          version.channel === 'alpha'
        )
          continue;
        if (!input.preferBeta && version.channel === 'beta') {
          deferredBeta.push(version);
          continue;
        }
        if (checked >= input.maxVersions) return result(true);
        const match = await check(version);
        if (match) return result(false, match);
      }
      if (complete) break;
      if (checked >= input.maxVersions) return result(true);
    }
    // A truncated catalog cannot establish that no stable alternative exists.
    if (!complete) return result(true);
    for (const version of deferredBeta.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
      if (checked >= input.maxVersions) return result(true);
      const match = await check(version);
      if (match) return result(false, match);
    }
    return result(false);
  } catch (error) {
    // A bounded search may hit its deadline before its attempt budget. Keep an
    // honest partial negative result instead of turning a timeout into HTTP500.
    if (input.signal?.aborted) return result(true);
    throw error;
  }
}

/** Suggestions never mutate the draft or acquire artifacts. The explicit choice goes
 * through normal selection/preparation, including installed and cross-provider checks. */
export async function modAlternativeAdvice(input: {
  provider: ModAdviceProvider;
  name: ModProvider;
  projectId: string;
  roots: ModSelection[];
  revision: number;
  maxVersions: number;
  target: ContentTarget;
  preferBeta: boolean;
  signal?: AbortSignal;
}): Promise<MinecraftModAlternatives> {
  const result = await findModAlternative({
    ...input,
    accept: (resolved) => !resolved.catalog.blocked.length,
  });
  return {
    revision: input.revision,
    provider: input.name,
    projectId: input.projectId,
    items: result.match ? [result.match.version] : [],
    checked: result.checked,
    limited: result.limited,
  };
}
