import type { GameUiClient } from '@nickhosting/game-sdk/ui';
import { z } from 'zod';
import {
  type ContentCatalogProvider,
  contentCatalogProviderSchema,
  modCatalogDetailsSchema,
  modCatalogProjectsSchema,
  modCatalogVersionsSchema,
  modProviderSchema,
  pluginProviderSchema,
} from '../../../../packages/content-providers/src/mod-catalog.js';
import {
  type MinecraftModSelection,
  type MinecraftModsSnapshot,
  minecraftModAlternativesSchema,
  minecraftModApplySchema,
  minecraftModBlockerSchema,
  minecraftModInstalledChangeSchema,
  minecraftModSelectionSchema,
  minecraftModToggleResultSchema,
  minecraftModToggleSchema,
  minecraftModUpdatesSchema,
} from '../mod-contracts.js';
import {
  minecraftPluginInstalledChangeSchema,
  minecraftPluginSelectionSchema,
  minecraftPluginToggleResultSchema,
  minecraftPluginToggleSchema,
} from '../plugin-contracts.js';

export type {
  ContentCatalogProvider,
  ModCatalogDetails,
  ModCatalogProject,
  ModCatalogVersion,
  ModCatalogVersions,
  ModEnvironment,
  ModTag,
} from '../../../../packages/content-providers/src/mod-catalog.js';
export type {
  MinecraftModAlternatives,
  MinecraftModMetadata,
  MinecraftModQueueItem,
  MinecraftModRoot,
  MinecraftModSelection,
  MinecraftModsSnapshot,
  MinecraftModUpdates,
} from '../mod-contracts.js';

const metadata = z.object({
  provider: contentCatalogProviderSchema,
  projectId: z.string(),
  versionId: z.string(),
  name: z.string(),
  version: z.string(),
  channel: z.enum(['release', 'beta', 'alpha']),
  iconUrl: z.string().optional(),
  side: z.enum(['server', 'client', 'both', 'unknown']),
  tags: z.array(z.object({ id: z.string(), label: z.string() })),
  minecraftVersions: z.array(z.string()),
  loaders: z.array(z.string()),
});
const aliases = z
  .array(
    z.object({
      provider: contentCatalogProviderSchema,
      projectId: z.string(),
      versionId: z.string().optional(),
    }),
  )
  .optional();
export const minecraftModsSnapshotSchema: z.ZodType<MinecraftModsSnapshot> = z.object({
  supported: z.boolean(),
  installed: z.boolean(),
  running: z.boolean(),
  version: z.string(),
  loader: z.string(),
  revision: z.number().int().nonnegative(),
  preferBeta: z.boolean(),
  roots: z.union([
    minecraftModSelectionSchema.shape.roots,
    minecraftPluginSelectionSchema.shape.roots,
  ]),
  preparing: z.boolean(),
  error: z.string().optional(),
  packs: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      name: z.string(),
      size: z.number().nonnegative(),
      state: z.enum(['enabled', 'disabled']),
      metadata: metadata.nullable(),
      aliases,
    }),
  ),
  changes: z.array(
    z.object({
      id: z.string(),
      action: z.enum(['install', 'enable', 'disable', 'delete']),
      name: z.string(),
      path: z.string(),
      size: z.number().nonnegative(),
      metadata: metadata.nullable(),
      aliases,
      dependency: z.boolean(),
      requiredBy: z.array(z.string()),
      forceIncompatible: z.boolean(),
      incompatibilities: z.array(z.enum(['minecraft', 'loader', 'client-only'])),
      state: z.enum(['queued', 'preparing', 'ready', 'failed', 'uncertain']),
      error: z.string().optional(),
      immediate: z.boolean().optional(),
    }),
  ),
  blockers: z.array(minecraftModBlockerSchema),
  optional: z.array(
    z.object({
      provider: contentCatalogProviderSchema,
      projectId: z.string(),
      name: z.string(),
      requiredBy: z.array(z.string()),
    }),
  ),
  restart: z.object({ required: z.boolean(), changedAt: z.string().optional() }),
});

/** One protected same-origin transport. Background preparation is a durable API operation. */
export function createMinecraftModsController(
  client: GameUiClient,
  kind: 'mods' | 'plugins' = 'mods',
) {
  const providerSchema = kind === 'plugins' ? pluginProviderSchema : modProviderSchema;
  const projectIdSchema =
    kind === 'plugins'
      ? minecraftPluginSelectionSchema.shape.roots.element.shape.projectId
      : minecraftModSelectionSchema.shape.roots.element.shape.projectId;
  const selectionSchema =
    kind === 'plugins' ? minecraftPluginSelectionSchema : minecraftModSelectionSchema;
  const changeSchema =
    kind === 'plugins' ? minecraftPluginInstalledChangeSchema : minecraftModInstalledChangeSchema;
  const toggleSchema = kind === 'plugins' ? minecraftPluginToggleSchema : minecraftModToggleSchema;
  const toggleResultSchema =
    kind === 'plugins' ? minecraftPluginToggleResultSchema : minecraftModToggleResultSchema;
  const path = (serverId: string, suffix = '') =>
    `/v1/servers/${z.uuid().parse(serverId)}/minecraft/${kind}${suffix}`;
  const projectPath = (serverId: string, provider: ContentCatalogProvider, projectId: string) =>
    path(
      serverId,
      `/catalog/${providerSchema.parse(provider)}/${encodeURIComponent(
        projectIdSchema.parse(projectId),
      )}`,
    );
  return {
    async snapshot(serverId: string, signal?: AbortSignal) {
      return minecraftModsSnapshotSchema.parse(await client.request(path(serverId), { signal }));
    },
    async catalog(serverId: string, signal?: AbortSignal) {
      return z
        .object({
          providers: z.array(
            z
              .object({
                id: z.union([contentCatalogProviderSchema, z.enum(['voxel', 'builtbybit'])]),
                available: z.boolean(),
                comingSoon: z.boolean().optional(),
              })
              .passthrough(),
          ),
        })
        .parse(await client.request(path(serverId, '/catalog'), { signal }));
    },
    async search(
      serverId: string,
      input: {
        provider: ContentCatalogProvider;
        query: string;
        offset: number;
        includeIncompatible: boolean;
      },
      signal?: AbortSignal,
    ) {
      const params = new URLSearchParams({
        provider: providerSchema.parse(input.provider),
        query: input.query,
        offset: String(input.offset),
        includeIncompatible: String(input.includeIncompatible),
      });
      return modCatalogProjectsSchema.parse(
        await client.request(path(serverId, `/catalog/search?${params}`), { signal }),
      );
    },
    async details(
      serverId: string,
      provider: ContentCatalogProvider,
      projectId: string,
      signal?: AbortSignal,
    ) {
      return modCatalogDetailsSchema.parse(
        await client.request(projectPath(serverId, provider, projectId), { signal }),
      );
    },
    async versions(
      serverId: string,
      provider: ContentCatalogProvider,
      projectId: string,
      input: { offset: number; includeIncompatible: boolean; preferBeta: boolean },
      signal?: AbortSignal,
    ) {
      const params = new URLSearchParams({
        offset: String(input.offset),
        includeIncompatible: String(input.includeIncompatible),
        preferBeta: String(input.preferBeta),
      });
      return modCatalogVersionsSchema.parse(
        await client.request(`${projectPath(serverId, provider, projectId)}/versions?${params}`, {
          signal,
        }),
      );
    },
    async updates(serverId: string, preferBeta: boolean, signal?: AbortSignal) {
      return minecraftModUpdatesSchema.parse(
        await client.request(path(serverId, `/updates?preferBeta=${preferBeta}`), { signal }),
      );
    },
    async alternatives(
      serverId: string,
      provider: ContentCatalogProvider,
      projectId: string,
      revision: number,
      signal?: AbortSignal,
    ) {
      const project = projectIdSchema.parse(projectId);
      const current = z.number().int().nonnegative().parse(revision);
      return minecraftModAlternativesSchema.parse(
        await client.request(
          path(
            serverId,
            `/alternatives/${providerSchema.parse(provider)}/${encodeURIComponent(project)}?revision=${current}`,
          ),
          { signal },
        ),
      );
    },
    async select(serverId: string, input: MinecraftModSelection) {
      return z.object({ revision: z.number().int().nonnegative() }).parse(
        await client.request(path(serverId, '/selection'), {
          method: 'PUT',
          body: selectionSchema.parse(input),
        }),
      );
    },
    async change(serverId: string, input: z.infer<typeof minecraftModInstalledChangeSchema>) {
      return client.request(path(serverId, '/changes'), {
        method: 'POST',
        body: changeSchema.parse(input),
      });
    },
    async toggle(serverId: string, input: z.infer<typeof minecraftModToggleSchema>) {
      return toggleResultSchema.parse(
        await client.request(path(serverId, '/toggle'), {
          method: 'POST',
          body: toggleSchema.parse(input),
        }),
      );
    },
    async discard(serverId: string, changeId: string) {
      return client.request(path(serverId, `/changes/${z.uuid().parse(changeId)}`), {
        method: 'DELETE',
      });
    },
    async apply(serverId: string, input: z.infer<typeof minecraftModApplySchema>) {
      return client.request(path(serverId, '/apply'), {
        method: 'POST',
        body: minecraftModApplySchema.parse(input),
      });
    },
    async recover(serverId: string) {
      return client.request(path(serverId, '/recover'), { method: 'POST', body: {} });
    },
  };
}
