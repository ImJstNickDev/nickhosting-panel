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

/** Suggestions never mutate the draft or acquire artifacts. The explicit choice goes
 * through normal selection/preparation, including installed and cross-provider checks. */
export async function modAlternativeAdvice(input: {
  provider: ModAdviceProvider;
  name: ModProvider;
  projectId: string;
  roots: ModSelection[];
  revision: number;
  target: ContentTarget;
  preferBeta: boolean;
  signal?: AbortSignal;
}): Promise<MinecraftModAlternatives> {
  const metadataMemo = createModMetadataMemo();
  const page = await modAdviceVersions(
    input.provider,
    input.projectId,
    input.target,
    input.preferBeta,
    input.signal,
    metadataMemo,
  );
  const root = input.roots.find((item) => item.projectId === input.projectId);
  const ordered = page.versions
    .filter(
      (item) =>
        item.id !== root?.versionId &&
        item.available &&
        !item.compatibility.length &&
        item.channel !== 'alpha',
    )
    .sort(
      (a, b) =>
        (!input.preferBeta
          ? Number(b.channel === 'release') - Number(a.channel === 'release')
          : 0) || b.publishedAt.localeCompare(a.publishedAt),
    );
  let checked = 0;
  for (const version of ordered.slice(0, 5)) {
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
    });
    checked++;
    if (!resolved.catalog.blocked.length)
      return {
        revision: input.revision,
        provider: input.name,
        projectId: input.projectId,
        items: [version],
        checked,
        limited: !page.complete,
      };
  }
  return {
    revision: input.revision,
    provider: input.name,
    projectId: input.projectId,
    items: [],
    checked,
    limited: !page.complete || ordered.length > checked,
  };
}
