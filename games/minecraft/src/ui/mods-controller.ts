import type { GameUiClient } from '@nickhosting/game-sdk/ui';
import { z } from 'zod';
import {
  type ModProvider,
  modCatalogDetailsSchema,
  modCatalogProjectsSchema,
  modCatalogVersionsSchema,
  modProviderSchema,
} from '../../../../packages/content-providers/src/mod-catalog.js';
import {
  type MinecraftModSelection,
  type MinecraftModsSnapshot,
  minecraftModApplySchema,
  minecraftModInstalledChangeSchema,
  minecraftModSelectionSchema,
} from '../mod-contracts.js';

export type {
  ModCatalogDetails,
  ModCatalogProject,
  ModCatalogVersion,
  ModCatalogVersions,
  ModEnvironment,
  ModProvider,
  ModTag,
} from '../../../../packages/content-providers/src/mod-catalog.js';
export type {
  MinecraftModMetadata,
  MinecraftModQueueItem,
  MinecraftModRoot,
  MinecraftModSelection,
  MinecraftModsSnapshot,
} from '../mod-contracts.js';

const metadata = z.object({
  provider: modProviderSchema,
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
      provider: modProviderSchema,
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
  roots: minecraftModSelectionSchema.shape.roots,
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
    }),
  ),
  blockers: z.array(z.object({ projectId: z.string(), name: z.string(), reason: z.string() })),
  optional: z.array(
    z.object({
      provider: modProviderSchema,
      projectId: z.string(),
      name: z.string(),
      requiredBy: z.array(z.string()),
    }),
  ),
  restart: z.object({ required: z.boolean(), changedAt: z.string().optional() }),
});

/** One protected same-origin transport. Background preparation is a durable API operation. */
export function createMinecraftModsController(client: GameUiClient) {
  const path = (serverId: string, suffix = '') =>
    `/v1/servers/${z.uuid().parse(serverId)}/minecraft/mods${suffix}`;
  const projectPath = (serverId: string, provider: ModProvider, projectId: string) =>
    path(
      serverId,
      `/catalog/${modProviderSchema.parse(provider)}/${encodeURIComponent(
        z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,128}$/)
          .parse(projectId),
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
            z.object({ id: modProviderSchema, available: z.boolean() }).passthrough(),
          ),
        })
        .parse(await client.request(path(serverId, '/catalog'), { signal }));
    },
    async search(
      serverId: string,
      input: { provider: ModProvider; query: string; offset: number; includeIncompatible: boolean },
      signal?: AbortSignal,
    ) {
      const params = new URLSearchParams({
        provider: input.provider,
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
      provider: ModProvider,
      projectId: string,
      signal?: AbortSignal,
    ) {
      return modCatalogDetailsSchema.parse(
        await client.request(projectPath(serverId, provider, projectId), { signal }),
      );
    },
    async versions(
      serverId: string,
      provider: ModProvider,
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
    async select(serverId: string, input: MinecraftModSelection) {
      return z.object({ revision: z.number().int().nonnegative() }).parse(
        await client.request(path(serverId, '/selection'), {
          method: 'PUT',
          body: minecraftModSelectionSchema.parse(input),
        }),
      );
    },
    async change(serverId: string, input: z.infer<typeof minecraftModInstalledChangeSchema>) {
      return client.request(path(serverId, '/changes'), {
        method: 'POST',
        body: minecraftModInstalledChangeSchema.parse(input),
      });
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
