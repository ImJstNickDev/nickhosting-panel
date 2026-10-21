import type { GameUiClient } from '@nickhosting/game-sdk/ui';
import { z } from 'zod';
import {
  type ModpackProvider,
  modpackCatalogDetailsSchema,
  modpackCatalogProjectsSchema,
  modpackCatalogVersionsSchema,
  modpackProviderSchema,
} from '../../../../packages/content-providers/src/modpack-catalog.js';
import {
  type MinecraftModpackApply,
  type MinecraftModpackOperation,
  type MinecraftModpackSelection,
  minecraftModpackApplySchema,
  minecraftModpackPrepareSchema,
  minecraftModpacksSnapshotSchema,
} from '../modpack-contracts.js';

export type {
  ModpackCatalogDetails,
  ModpackCatalogProject,
  ModpackCatalogVersion,
  ModpackProvider,
} from '../../../../packages/content-providers/src/modpack-catalog.js';
export type {
  MinecraftModpackApply,
  MinecraftModpackOperation,
  MinecraftModpackSelection,
  MinecraftModpacksSnapshot,
} from '../modpack-contracts.js';

const identity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^/\\\p{C}]+$/u);
const offsetSchema = z.number().int().min(0).max(9980);
export const minecraftModpackCatalogSchema = z.object({
  providers: z.array(
    z
      .object({ id: modpackProviderSchema, available: z.boolean(), reason: z.string().optional() })
      .passthrough(),
  ),
});
/** Metadata requests never start preparation; every mutation is an explicit, idempotent intent. */
export function createMinecraftModpacksController(client: GameUiClient) {
  const path = (serverId: string, suffix = '') =>
    `/v1/servers/${z.uuid().parse(serverId)}/minecraft/modpacks${suffix}`;
  const projectPath = (serverId: string, provider: ModpackProvider, projectId: string) =>
    path(
      serverId,
      `/catalog/${modpackProviderSchema.parse(provider)}/${encodeURIComponent(identity.parse(projectId))}`,
    );
  const prepare = (serverId: string, input: MinecraftModpackSelection) =>
    client
      .request(path(serverId, '/prepare'), {
        method: 'POST',
        body: minecraftModpackPrepareSchema.parse(input),
      })
      .then((value) => minecraftModpacksSnapshotSchema.parse(value));
  return {
    async snapshot(serverId: string, signal?: AbortSignal) {
      return minecraftModpacksSnapshotSchema.parse(
        await client.request(path(serverId), { signal }),
      );
    },
    async catalog(serverId: string, signal?: AbortSignal) {
      return minecraftModpackCatalogSchema.parse(
        await client.request(path(serverId, '/catalog'), { signal }),
      );
    },
    async search(
      serverId: string,
      input: { provider: ModpackProvider; query: string; offset: number },
      signal?: AbortSignal,
    ) {
      const params = new URLSearchParams({
        provider: modpackProviderSchema.parse(input.provider),
        query: z.string().max(200).parse(input.query),
        offset: String(offsetSchema.parse(input.offset)),
      });
      return modpackCatalogProjectsSchema.parse(
        await client.request(path(serverId, `/catalog/search?${params}`), { signal }),
      );
    },
    async details(
      serverId: string,
      provider: ModpackProvider,
      projectId: string,
      signal?: AbortSignal,
    ) {
      return modpackCatalogDetailsSchema.parse(
        await client.request(projectPath(serverId, provider, projectId), { signal }),
      );
    },
    async versions(
      serverId: string,
      provider: ModpackProvider,
      projectId: string,
      offset: number,
      signal?: AbortSignal,
    ) {
      return modpackCatalogVersionsSchema.parse(
        await client.request(
          `${projectPath(serverId, provider, projectId)}/versions?offset=${offsetSchema.parse(offset)}`,
          { signal },
        ),
      );
    },
    prepare,
    retry(serverId: string, operation: MinecraftModpackOperation, idempotencyKey: string) {
      if (operation.state !== 'failed' || idempotencyKey === operation.selection.idempotencyKey)
        throw new TypeError('A failed preparation retry requires a new intent');
      // Failed operations are terminal. Preserve their choices without cancelling them,
      // so a transport failure leaves the original operation available to retry.
      return prepare(serverId, { ...operation.selection, idempotencyKey });
    },
    apply(serverId: string, input: MinecraftModpackApply) {
      return client
        .request(path(serverId, '/apply'), {
          method: 'POST',
          body: minecraftModpackApplySchema.parse(input),
        })
        .then((value) => minecraftModpacksSnapshotSchema.parse(value));
    },
    discard(serverId: string, operationId: string) {
      return client
        .request(path(serverId, `/operations/${z.uuid().parse(operationId)}`), { method: 'DELETE' })
        .then((value) => minecraftModpacksSnapshotSchema.parse(value));
    },
    recover(serverId: string, operationId: string) {
      return client
        .request(path(serverId, `/operations/${z.uuid().parse(operationId)}/recover`), {
          method: 'POST',
          body: {},
        })
        .then((value) => minecraftModpacksSnapshotSchema.parse(value));
    },
  };
}
