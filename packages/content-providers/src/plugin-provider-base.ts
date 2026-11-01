import type { ContentArtifact, ContentHttp, ContentLimits, ContentTarget } from './contracts.js';
import { contentLimits, fail } from './contracts.js';
import { dependencyMemo } from './datapack-resolution.js';
import {
  type ModCatalogDetails,
  type ModCatalogProject,
  type ModCatalogVersion,
  type ModCatalogVersions,
  type ModSelection,
  modCatalogVersionsSchema,
  type PluginProvider,
} from './mod-catalog.js';
import { modAvailabilityHints, recommendedModVersion } from './mod-metadata.js';
import {
  type ModCandidate,
  type ModCatalogSearchInput,
  type ModCatalogVersionsInput,
  type ResolveModsOptions,
  resolveModGraph,
} from './mod-resolution.js';

export interface PluginVersionRecord {
  version: ModCatalogVersion;
  artifact?: ContentArtifact;
  dependencies: ModCandidate['dependencies'];
}
export function pluginPage(offset = 0): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 9980) fail('search');
  return offset;
}
export function numericPluginId(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    fail('dependency_identity');
  return value;
}
/** Provider-specific metadata feeds the same dependency graph and artifact pipeline as Mods. */
export abstract class PluginProviderBase<Project> {
  protected readonly limits: ContentLimits;
  constructor(
    readonly http: ContentHttp,
    protected readonly provider: PluginProvider,
    limits: Partial<ContentLimits> = {},
  ) {
    this.limits = contentLimits(limits);
  }
  abstract searchPlugins(
    input: ModCatalogSearchInput,
  ): Promise<import('./mod-catalog.js').ModCatalogProjects>;
  protected abstract project(pid: string, signal?: AbortSignal): Promise<Project>;
  protected abstract publicProject(project: Project): ModCatalogDetails;
  protected abstract versions(
    project: Project,
    input: ModCatalogVersionsInput,
  ): Promise<{ items: PluginVersionRecord[]; total: number }>;
  protected abstract version(
    project: Project,
    vid: string,
    target: ContentTarget,
    signal?: AbortSignal,
  ): Promise<PluginVersionRecord>;
  private metadataProject(pid: string, options: ResolveModsOptions) {
    numericPluginId(pid);
    return (options.metadataMemo ?? dependencyMemo(this.limits.maxDependencies))(
      `${this.provider}:project:${pid}`,
      () => this.project(pid, options.signal),
    );
  }
  async pluginDetails(pid: string, signal?: AbortSignal): Promise<ModCatalogDetails> {
    return this.publicProject(await this.project(numericPluginId(pid), signal));
  }
  async pluginVersions(pid: string, input: ModCatalogVersionsInput): Promise<ModCatalogVersions> {
    const offset = pluginPage(input.offset);
    const project = await this.metadataProject(pid, input);
    const page = await this.versions(project, { ...input, offset });
    return modCatalogVersionsSchema.parse({
      offset,
      limit: 20,
      total: page.total,
      items: page.items.map((item) => item.version),
      recommendedId: recommendedModVersion(
        page.items.map((item) => item.version),
        input.preferBeta,
      )?.id,
    });
  }
  async pluginVersion(
    pid: string,
    vid: string,
    target: ContentTarget,
    signal?: AbortSignal,
    metadataMemo?: ResolveModsOptions['metadataMemo'],
  ): Promise<ModCatalogVersion> {
    const project = await this.metadataProject(pid, { signal, metadataMemo });
    return (await this.version(project, numericPluginId(vid), target, signal)).version;
  }
  private catalogProject(project: Project): ModCatalogProject {
    const { description, descriptionFormat, ...publicProject } = this.publicProject(project);
    return publicProject;
  }
  async resolvePlugins(
    roots: ModSelection[],
    target: ContentTarget,
    options: ResolveModsOptions = {},
  ) {
    const metadataMemo = options.metadataMemo ?? dependencyMemo(this.limits.maxDependencies);
    const memo = dependencyMemo(this.limits.maxDependencies);
    const maxVersionChecks = options.maxVersionChecks ?? 25;
    if (!Number.isSafeInteger(maxVersionChecks) || maxVersionChecks < 1 || maxVersionChecks > 1000)
      fail('dependency_budget');
    const rootIds = new Set(roots.map((root) => root.projectId));
    const project = (pid: string) => this.metadataProject(pid, { ...options, metadataMemo });
    return resolveModGraph({
      provider: this.provider,
      roots,
      target,
      limit: this.limits.maxDependencies,
      signal: options.signal,
      project: async (pid): Promise<ModCatalogProject> => this.catalogProject(await project(pid)),
      load: (pid, vid) =>
        memo(`${pid}:${vid}`, async (): Promise<ModCandidate> => {
          if (!pid) fail('dependency_identity');
          const rawProject = await project(pid);
          const publicProject = this.catalogProject(rawProject);
          let chosen: PluginVersionRecord | undefined;
          const installed = !rootIds.has(pid) ? options.installedVersions?.get(pid) : undefined;
          if (vid || installed) {
            const candidate = await this.version(
              rawProject,
              numericPluginId(vid ?? installed ?? ''),
              target,
              options.signal,
            );
            if (vid || !candidate.version.compatibility.length) chosen = candidate;
          }
          const observed: ModCatalogVersion[] = [];
          let beta: PluginVersionRecord | undefined;
          // Public API pages are bounded. Stable preference walks only until a stable candidate exists.
          for (let offset = 0; !chosen && offset < maxVersionChecks; offset += 20) {
            const page = await metadataMemo(
              `${this.provider}:versions:${pid}:${target.minecraftVersion}:${target.loader}:${offset}`,
              () => this.versions(rawProject, { target, offset, signal: options.signal }),
            );
            observed.push(
              ...page.items.map((item) => item.version).slice(0, Math.max(0, 20 - observed.length)),
            );
            const compatible = page.items
              .slice(0, maxVersionChecks - offset)
              .filter((item) => item.version.available && !item.version.compatibility.length);
            beta ??= compatible.find((item) => item.version.channel === 'beta');
            chosen = compatible.find(
              (item) =>
                item.version.channel === 'release' ||
                (options.preferBeta && item.version.channel === 'beta'),
            );
            if (offset + page.items.length >= page.total || !page.items.length) break;
          }
          chosen ??= beta;
          if (!chosen)
            return {
              project: publicProject,
              dependencies: [],
              blockedReason: observed.some((item) => item.compatibility.length === 0)
                ? 'unavailable'
                : 'incompatible-version',
              availabilityHints: modAvailabilityHints(observed),
            };
          return { project: publicProject, ...chosen };
        }),
    });
  }
}
