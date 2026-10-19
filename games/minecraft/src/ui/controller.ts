import {
  worldCatalogFilesSchema,
  worldCatalogProjectsSchema,
} from '@nickhosting/content-providers/world-catalog';
import type { GameUiClient, UiOption, UiValues } from '@nickhosting/game-sdk/ui';
import { z } from 'zod';
import { minecraftContentCapabilities } from '../content-capabilities.js';
import {
  type MinecraftDatapackChange,
  type MinecraftDatapackSnapshot,
  minecraftDatapackApplySchema,
  minecraftDatapackChangeSchema,
} from '../datapack-contracts.js';

export type MinecraftDatapacks = MinecraftDatapackSnapshot;
const datapackMetadataSchema = z.object({
  description: z.string(),
  formatMin: z.tuple([z.number(), z.number()]).nullable(),
  formatMax: z.tuple([z.number(), z.number()]).nullable(),
  compatibility: z.enum(['compatible', 'incompatible', 'unknown', 'invalid']),
  features: z.array(z.string()),
});
const datapackSnapshotSchema: z.ZodType<MinecraftDatapackSnapshot> = z.object({
  world: z.string(),
  selectedWorld: z.string().nullable(),
  worlds: z.array(z.object({ name: z.string(), selected: z.boolean() })),
  running: z.boolean(),
  version: z.string(),
  supported: z.boolean(),
  installed: z.boolean(),
  packs: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      name: z.string(),
      kind: z.enum(['zip', 'directory']),
      state: z.enum(['enabled', 'disabled', 'pending']),
      nativeState: z.enum(['enabled', 'disabled', 'unknown']),
      metadata: datapackMetadataSchema.nullable(),
      compatibility: datapackMetadataSchema.shape.compatibility,
    }),
  ),
  changes: z.array(
    z.object({
      id: z.string(),
      action: z.enum(['install', 'enable', 'disable', 'delete']),
      name: z.string(),
      state: z.enum(['preparing', 'ready', 'failed', 'uncertain']),
      error: z.string().optional(),
      cancellable: z.boolean().optional(),
    }),
  ),
  reload: z.object({ state: z.enum(['not_required', 'required', 'requested', 'uncertain']) }),
});

export type {
  WorldCatalogFile,
  WorldCatalogProject,
} from '@nickhosting/content-providers/world-catalog';
export { minecraftContentCapabilities } from '../content-capabilities.js';

const uuid = z.uuid();
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const player = z.string().regex(/^[A-Za-z0-9_]{3,16}$/);
const world = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const properties = z.record(
  z.string().min(1).max(80),
  z.union([z.string().max(256), z.number().finite(), z.boolean()]),
);
const provider = z.enum(['modrinth', 'curseforge']);
const sourcePack = z.object({ sourceId: uuid }).strict();
const providerPack = z
  .object({ provider: z.literal('modrinth'), projectId: key, versionId: key })
  .strict();
const replacement = z
  .object({
    wipeConsent: z.literal(true),
    expectedDeletePaths: z.array(z.string().min(1).max(1024)).max(1000),
    backupBefore: z.boolean(),
  })
  .strict();
export const minecraftUiConfigurationSchema = z
  .object({
    eula: z.literal(true),
    properties: properties.default({}),
    operators: z.array(player).max(1000).default([]),
    whitelist: z.array(player).max(1000).default([]),
    modpack: z.union([sourcePack, providerPack]).optional(),
  })
  .strict();
/** Wire request validation only; the API repeats authoritative compatibility and permission checks. */
export const minecraftUiCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('verify') }).strict(),
  z.object({ kind: z.literal('properties'), changes: properties }).strict(),
  z
    .object({
      kind: z.literal('player'),
      list: z.enum(['operators', 'whitelist']),
      action: z.enum(['add', 'remove']),
      name: player,
      expectedUuid: uuid.optional(),
      operatorLevel: z.number().int().min(1).max(4).optional(),
      bypassesPlayerLimit: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('world-select'), world }).strict(),
  z
    .object({
      kind: z.literal('world-remove'),
      world,
      confirm: z.literal(true),
      backupBefore: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('world-import'),
      archiveRef: uuid,
      targetWorld: world,
      replace: replacement
        .extend({ expectedDeletePaths: z.array(z.string()).min(1).max(1000) })
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal('install'), provider, projectId: key, versionId: key }).strict(),
  z.object({ kind: z.literal('remove'), provider, projectId: key }).strict(),
  z
    .object({
      kind: z.literal('modpack'),
      provider: z.literal('modrinth'),
      projectId: key,
      versionId: key,
      replace: replacement.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('modpack-upload'),
      archiveRef: uuid,
      replace: replacement.optional(),
    })
    .strict(),
]);
export type MinecraftUiCommand = z.infer<typeof minecraftUiCommandSchema>;
export const minecraftChoiceSchema = z
  .object({
    id: uuid,
    version: z.string().min(1).max(80),
    runtime: z.enum(['vanilla', 'paper', 'folia', 'fabric', 'forge']),
    releaseTime: z.iso.datetime({ offset: true }).nullable().optional(),
    releaseType: z.enum(['release', 'snapshot', 'old_alpha', 'old_beta']).optional(),
    capabilities: z.record(z.string(), z.boolean()).optional(),
  })
  .strip();
export type MinecraftUiChoice = z.infer<typeof minecraftChoiceSchema>;
const profileSchema = z
  .object({
    choiceId: uuid,
    version: z.string(),
    runtime: minecraftChoiceSchema.shape.runtime,
    installed: z.boolean(),
    configuration: z
      .object({
        eula: z.literal(true),
        properties,
        operators: z.array(player),
        whitelist: z.array(player),
        modpack: z.union([sourcePack, providerPack]).optional(),
      })
      .passthrough(),
    content: z
      .array(
        z.object({ path: z.string(), artifact: z.unknown(), installed_at: z.string() }).strip(),
      )
      .max(100000),
    effectiveProperties: z.record(z.string().max(80), z.string().max(256)),
    supportedProperties: z.array(z.string()).max(1000).optional(),
  })
  .strip();
export type MinecraftUiProfile = z.infer<typeof profileSchema>;
const managedPlayer = z.object({ name: player, uuid: z.string().max(36) }).strip();
export const minecraftPlayersSchema = z
  .object({
    supported: z.boolean(),
    installed: z.boolean(),
    operators: z
      .array(
        managedPlayer.extend({
          level: z.number().int().min(1).max(4),
          bypassesPlayerLimit: z.boolean(),
        }),
      )
      .max(100000),
    whitelist: z.array(managedPlayer).max(100000),
    banned: z
      .array(
        managedPlayer.extend({ reason: z.string().optional(), expires: z.string().optional() }),
      )
      .max(100000),
    whitelistEnabled: z.boolean(),
    enforceWhitelist: z.boolean(),
  })
  .strip();
export type MinecraftPlayers = z.infer<typeof minecraftPlayersSchema>;
export const minecraftOnlinePlayersSchema = z
  .object({
    state: z.enum(['available', 'unavailable', 'offline']),
    players: z.array(z.object({ name: player }).strip()).max(100000),
    observedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strip();
export const minecraftPlayerActionSchema = z
  .object({
    action: z.enum([
      'op',
      'deop',
      'whitelist-add',
      'whitelist-remove',
      'whitelist-on',
      'whitelist-off',
      'kick',
      'ban',
      'pardon',
    ]),
    name: player.optional(),
    expectedUuid: uuid.optional(),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const toggle = value.action === 'whitelist-on' || value.action === 'whitelist-off';
    if (!toggle && !value.name)
      context.addIssue({ code: 'custom', path: ['name'], message: 'required' });
    if (toggle && (value.name || value.expectedUuid))
      context.addIssue({ code: 'custom', path: ['name'], message: 'unexpected' });
    if (value.reason !== undefined && !['ban', 'kick'].includes(value.action))
      context.addIssue({ code: 'custom', path: ['reason'], message: 'unexpected' });
  });
export type MinecraftPlayerAction = z.infer<typeof minecraftPlayerActionSchema>;
const worldSchema = z
  .object({
    name: world,
    status: z.enum(['verified', 'incompatible', 'unknown', 'invalid', 'unavailable']),
    validation: z
      .object({
        dataVersion: z.number().int().nonnegative().optional(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        uncompressedBytes: z.number().int().nonnegative(),
        versionName: z.string().max(128).optional(),
        detectedRelease: z.string().max(128).optional(),
        storageVersion: z.number().int().nonnegative().optional(),
        versionSeries: z.string().max(128).optional(),
        snapshot: z.boolean().optional(),
        versionHistory: z.array(z.number().int().positive()).max(4096).optional(),
      })
      .strip()
      .optional(),
  })
  .strip();
export const minecraftWorldsSchema = z
  .object({
    installed: z.boolean(),
    supported: z.boolean(),
    selectedWorld: z.string().max(1024).nullable(),
    release: z.string().max(128),
    compatibility: z.enum(['available', 'unavailable']),
    worlds: z.array(worldSchema).max(1000),
  })
  .strip();
export type MinecraftWorlds = z.infer<typeof minecraftWorldsSchema>;
const jobSchema = z.object({ serverId: uuid, jobId: uuid }).strip();
export type AcceptedMinecraftOperation = z.infer<typeof jobSchema>;
const sourceSchema = z
  .object({ id: uuid, status: z.string().optional(), state: z.string().optional() })
  .passthrough();
const wizardSchema = z
  .object({
    choices: z.array(
      z
        .object({
          id: uuid,
          release: z.string(),
          runtime: minecraftChoiceSchema.shape.runtime,
          nameKey: z.string(),
        })
        .strip(),
    ),
    derived: z
      .object({ release: z.string(), runtime: minecraftChoiceSchema.shape.runtime, choiceId: uuid })
      .strip()
      .optional(),
  })
  .strip();
export class MinecraftUiError extends Error {
  constructor(
    readonly code: 'validation_failed' | 'integration_unavailable' | 'conflict',
    readonly reason?: string,
  ) {
    super(code);
  }
}
/** Release chronology is independent of release kind; unknown dates stay last. */
export function minecraftCatalogOptions(
  raw: unknown,
  handler: string,
  values: UiValues,
): UiOption[] {
  const choices = z.array(minecraftChoiceSchema).max(10000).parse(raw);
  if (handler === 'runtimes')
    return [...new Set(choices.map((choice) => choice.runtime))].map((runtime) => ({
      value: runtime,
      labelKey: `games.minecraft.runtimes.${runtime}`,
      disabled: false,
    }));
  if (handler !== 'choices') throw new MinecraftUiError('integration_unavailable');
  return choices
    .filter((choice) => !values.runtime || choice.runtime === values.runtime)
    .sort((a, b) => {
      const first = Date.parse(a.releaseTime ?? ''),
        second = Date.parse(b.releaseTime ?? '');
      if (Number.isFinite(first) !== Number.isFinite(second))
        return Number.isFinite(first) ? -1 : 1;
      return (
        (Number.isFinite(first) && first !== second
          ? second - first
          : b.version.localeCompare(a.version, 'en', { numeric: true })) || a.id.localeCompare(b.id)
      );
    })
    .map((choice) => ({
      value: choice.id,
      label: choice.version,
      disabled: false,
      releaseType: choice.releaseType ?? 'release',
      ...(choice.capabilities ? { capabilities: choice.capabilities } : {}),
    }));
}
/** Same-origin NickHosting only; no provider URL/token or arbitrary API path is accepted. */
export function createMinecraftUiController(client: GameUiClient) {
  const request = (
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
    signal?: AbortSignal,
  ) => client.request(path, { method, ...(body === undefined ? {} : { body }), signal });
  const serverPath = (id: string, suffix = '') =>
    `/v1/servers/${uuid.parse(id)}/minecraft${suffix}`;
  const profile = async (serverId: string, signal?: AbortSignal) =>
    profileSchema.parse(await request(serverPath(serverId), 'GET', undefined, signal));
  const choices = async (signal?: AbortSignal) =>
    z
      .array(minecraftChoiceSchema)
      .max(10000)
      .parse(
        await (client.catalogRequest
          ? client.catalogRequest('/v1/minecraft/choices', signal)
          : request('/v1/minecraft/choices', 'GET', undefined, signal)),
      );
  const operate = async (
    serverId: string,
    idempotencyKey: string,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<AcceptedMinecraftOperation> => {
    const command = minecraftUiCommandSchema.parse(raw);
    if (command.kind === 'install') {
      const current = await profile(serverId, signal);
      const supported = minecraftContentCapabilities(current.runtime);
      if (!supported.mods && !supported.plugins)
        throw new MinecraftUiError('integration_unavailable', 'content_not_supported');
    }
    return jobSchema.parse(
      await request(
        serverPath(serverId, '/operations'),
        'POST',
        { idempotencyKey: key.parse(idempotencyKey), action: 'minecraft-content', command },
        signal,
      ),
    );
  };
  const source = async (sourceId: string, signal?: AbortSignal) =>
    sourceSchema.parse(
      await request(`/v1/minecraft/sources/${uuid.parse(sourceId)}`, 'GET', undefined, signal),
    );
  return {
    choices,
    async runtimeOptions(signal?: AbortSignal): Promise<UiOption[]> {
      return minecraftCatalogOptions(await choices(signal), 'runtimes', {});
    },
    async choiceOptions(signal?: AbortSignal, runtime?: string): Promise<UiOption[]> {
      return minecraftCatalogOptions(await choices(signal), 'choices', { runtime });
    },
    profile,
    async players(serverId: string, signal?: AbortSignal): Promise<MinecraftPlayers> {
      return minecraftPlayersSchema.parse(
        await request(serverPath(serverId, '/players'), 'GET', undefined, signal),
      );
    },
    async onlinePlayers(serverId: string, signal?: AbortSignal) {
      return minecraftOnlinePlayersSchema.parse(
        await request(serverPath(serverId, '/players/online'), 'GET', undefined, signal),
      );
    },
    async playerAction(serverId: string, action: MinecraftPlayerAction, signal?: AbortSignal) {
      return z
        .object({ outcome: z.literal('dispatched') })
        .strip()
        .parse(
          await request(
            serverPath(serverId, '/players/actions'),
            'POST',
            minecraftPlayerActionSchema.parse(action),
            signal,
          ),
        );
    },
    async inspectDatapack(serverId: string, world: string, path: string, signal?: AbortSignal) {
      const params = new URLSearchParams({ world, path });
      return z
        .object({
          metadata: datapackMetadataSchema.nullable(),
          reason: z.literal('too_large').optional(),
        })
        .parse(
          await request(
            serverPath(serverId, `/datapacks/inspect?${params}`),
            'GET',
            undefined,
            signal,
          ),
        );
    },
    async recoverDatapacks(serverId: string, world: string, signal?: AbortSignal) {
      return request(serverPath(serverId, '/datapacks/recover'), 'POST', { world }, signal);
    },
    async datapackCatalog(serverId: string, signal?: AbortSignal) {
      return z
        .object({ providers: z.array(z.object({ id: provider, available: z.boolean() })) })
        .parse(await request(serverPath(serverId, '/datapacks/catalog'), 'GET', undefined, signal));
    },
    async searchDatapacks(
      serverId: string,
      input: { provider: 'modrinth' | 'curseforge'; query: string; offset: number },
      signal?: AbortSignal,
    ) {
      const values = z
        .object({ provider, query: z.string().max(256), offset: z.number().int().min(0).max(9980) })
        .parse(input);
      const params = new URLSearchParams({
        provider: values.provider,
        query: values.query,
        offset: String(values.offset),
      });
      return worldCatalogProjectsSchema.parse(
        await request(
          serverPath(serverId, `/datapacks/catalog/search?${params}`),
          'GET',
          undefined,
          signal,
        ),
      );
    },
    async datapackCatalogFiles(
      serverId: string,
      providerId: 'modrinth' | 'curseforge',
      projectId: string,
      offset = 0,
      signal?: AbortSignal,
    ) {
      return worldCatalogFilesSchema.parse(
        await request(
          serverPath(
            serverId,
            `/datapacks/catalog/${provider.parse(providerId)}/${encodeURIComponent(key.parse(projectId))}/files?offset=${z.number().int().min(0).max(9980).parse(offset)}`,
          ),
          'GET',
          undefined,
          signal,
        ),
      );
    },
    async acquireDatapack(
      serverId: string,
      input: {
        provider: 'modrinth' | 'curseforge';
        projectId: string;
        versionId: string;
        world: string;
        idempotencyKey: string;
      },
      signal?: AbortSignal,
    ) {
      const body = z
        .object({
          provider,
          projectId: key,
          versionId: key,
          world: minecraftDatapackChangeSchema.shape.world,
          idempotencyKey: key,
        })
        .strict()
        .parse(input);
      return z
        .object({ changeId: z.string(), state: z.string() })
        .parse(
          await request(serverPath(serverId, '/datapacks/catalog/acquire'), 'POST', body, signal),
        );
    },
    async datapacks(
      serverId: string,
      world?: string,
      signal?: AbortSignal,
    ): Promise<MinecraftDatapackSnapshot> {
      return datapackSnapshotSchema.parse(
        await request(
          serverPath(serverId, `/datapacks${world ? `?world=${encodeURIComponent(world)}` : ''}`),
          'GET',
          undefined,
          signal,
        ),
      );
    },
    async datapackChange(serverId: string, input: MinecraftDatapackChange, signal?: AbortSignal) {
      return request(
        serverPath(serverId, '/datapacks/changes'),
        'POST',
        minecraftDatapackChangeSchema.parse(input),
        signal,
      );
    },
    async cancelDatapackChange(serverId: string, changeId: string, signal?: AbortSignal) {
      return request(
        serverPath(serverId, `/datapacks/changes/${uuid.parse(changeId)}`),
        'DELETE',
        undefined,
        signal,
      );
    },
    async applyDatapacks(
      serverId: string,
      input: { world: string; idempotencyKey: string },
      signal?: AbortSignal,
    ) {
      return z
        .object({
          state: z.string(),
          reload: z.enum(['not_required', 'required', 'requested', 'uncertain']),
        })
        .parse(
          await request(
            serverPath(serverId, '/datapacks/apply'),
            'POST',
            minecraftDatapackApplySchema.parse(input),
            signal,
          ),
        );
    },
    async worlds(serverId: string, signal?: AbortSignal) {
      return minecraftWorldsSchema.parse(
        await request(serverPath(serverId, '/worlds'), 'GET', undefined, signal),
      );
    },
    async wipePreview(serverId: string, signal?: AbortSignal) {
      return z
        .object({ deletePaths: z.array(z.string()).max(1000) })
        .strip()
        .parse(await request(serverPath(serverId, '/wipe-preview'), 'GET', undefined, signal));
    },
    async inspectModpack(sourceId: string, signal?: AbortSignal) {
      const result = wizardSchema.parse(
        await request('/v1/minecraft/wizard', 'POST', { sourceId: uuid.parse(sourceId) }, signal),
      );
      if (
        !result.derived ||
        !result.choices.some(
          (c) =>
            c.id === result.derived?.choiceId &&
            c.release === result.derived.release &&
            c.runtime === result.derived.runtime,
        )
      )
        throw new MinecraftUiError('integration_unavailable');
      return result;
    },
    async create(raw: unknown, signal?: AbortSignal): Promise<AcceptedMinecraftOperation> {
      const input = z
        .object({
          idempotencyKey: key,
          name: z.string().trim().min(1).max(100),
          projectId: uuid.optional(),
          limits: z
            .object({
              memory: z.number().int().min(32).max(1048576),
              cpu: z.number().int().min(1).max(100000),
              disk: z.number().int().min(16).max(1073741824).optional(),
              swap: z.literal(0).default(0),
              io: z.number().int().min(10).max(1000).default(500),
            })
            .strict(),
          autoStart: z.boolean().default(true),
          connection: z
            .object({
              domainId: z.string().min(1).max(80).optional(),
              subdomain: z.string().max(63).optional(),
              reservationId: uuid.optional(),
            })
            .strict()
            .optional(),
          minecraft: z
            .object({ choiceId: uuid, configuration: minecraftUiConfigurationSchema })
            .strict(),
        })
        .strict()
        .parse(raw);
      // Never forward caller-controlled mapping IDs or manufacture an eligible combination.
      if (!(await choices(signal)).some((c) => c.id === input.minecraft.choiceId))
        throw new MinecraftUiError('integration_unavailable');
      return jobSchema.parse(await request('/v1/minecraft/servers', 'POST', input, signal));
    },
    operate,
    async updateProperties(
      serverId: string,
      idempotencyKey: string,
      changes: UiValues,
      signal?: AbortSignal,
    ) {
      // The displayed form already limits editable fields. The API validates the
      // current runtime's supported properties; another profile read is not authority.
      return operate(serverId, idempotencyKey, { kind: 'properties', changes }, signal);
    },
    async player(name: string, avatar = false, signal?: AbortSignal) {
      return z
        .object({
          uuid: z.string().regex(/^[a-f0-9-]{36}$/),
          name: player,
          source: z.literal('mojang'),
          verifiedAt: z.iso.datetime({ offset: true }),
          avatar: z.url().optional(),
        })
        .strip()
        .parse(
          await request(
            `/v1/minecraft/players/${encodeURIComponent(player.parse(name))}?avatar=${avatar}`,
            'GET',
            undefined,
            signal,
          ),
        );
    },
    source,
    async uploadSource(input: {
      kind: 'world' | 'modpack' | 'datapack';
      serverId?: string;
      idempotencyKey: string;
      file: Blob;
      sha256: string;
      signal?: AbortSignal;
      onProgress?: (sent: number, total: number) => void;
    }) {
      if (!client.upload)
        throw new MinecraftUiError('integration_unavailable', 'upload_unavailable');
      const reservation = z
        .object({
          kind: z.enum(['world', 'modpack', 'datapack']),
          serverId: uuid.optional(),
          idempotencyKey: key,
          bytes: z
            .number()
            .int()
            .positive()
            .max(Number.MAX_SAFE_INTEGER - 65536),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse({
          kind: input.kind,
          serverId: input.serverId,
          idempotencyKey: input.idempotencyKey,
          bytes: input.file.size,
          sha256: input.sha256,
        });
      const reserved = sourceSchema.parse(
        await request('/v1/minecraft/sources', 'POST', reservation, input.signal),
      );
      // The shared client streams the Blob; neither JSON nor arrayBuffer materialization is used.
      const finished = sourceSchema.parse(
        await client.upload(`/v1/minecraft/sources/${reserved.id}/upload`, input.file, {
          bytes: input.file.size,
          signal: input.signal,
          onProgress: input.onProgress,
        }),
      );
      if (finished.id !== reserved.id || finished.state !== 'ready')
        throw new MinecraftUiError('conflict', 'source_not_ready');
      return finished;
    },
    async acquireModpack(
      input: { projectId: string; versionId: string; serverId?: string; idempotencyKey: string },
      signal?: AbortSignal,
    ) {
      const body = z
        .object({ projectId: key, versionId: key, serverId: uuid.optional(), idempotencyKey: key })
        .strict()
        .parse(input);
      return sourceSchema.parse(
        await request('/v1/minecraft/sources/modrinth', 'POST', body, signal),
      );
    },
    async searchModpacks(query: string, offset = 0, signal?: AbortSignal) {
      const p = z
        .object({ query: z.string().max(256), offset: z.number().int().min(0).max(10000) })
        .parse({ query, offset });
      const params = new URLSearchParams({ query: p.query, offset: String(p.offset) });
      return z
        .object({
          offset: z.number(),
          hits: z
            .array(z.object({ projectId: key, title: z.string(), description: z.string() }).strip())
            .max(100),
        })
        .strip()
        .parse(await request(`/v1/minecraft/modpacks/search?${params}`, 'GET', undefined, signal));
    },
    async modpackVersions(projectId: string, signal?: AbortSignal) {
      return z
        .array(
          z
            .object({ projectId: key, versionId: key, name: z.string(), version: z.string() })
            .strip(),
        )
        .max(10000)
        .parse(
          await request(
            `/v1/minecraft/modpacks/${key.parse(projectId)}/versions`,
            'GET',
            undefined,
            signal,
          ),
        );
    },
    async worldCatalog(serverId: string, signal?: AbortSignal) {
      return z
        .object({
          providers: z
            .array(z.object({ id: z.literal('curseforge'), available: z.boolean() }))
            .max(8),
        })
        .parse(
          await request(
            `/v1/servers/${uuid.parse(serverId)}/minecraft/world-catalog`,
            'GET',
            undefined,
            signal,
          ),
        );
    },
    async searchWorlds(
      input: { serverId: string; query: string; offset?: number; gameVersion?: string },
      signal?: AbortSignal,
    ) {
      const value = z
        .strictObject({
          serverId: uuid,
          query: z.string().max(256),
          offset: z.number().int().min(0).max(9980).default(0),
          gameVersion: z.string().min(1).max(80).optional(),
        })
        .parse(input);
      const params = new URLSearchParams({
        provider: 'curseforge',
        query: value.query,
        offset: String(value.offset),
        ...(value.gameVersion ? { gameVersion: value.gameVersion } : {}),
      });
      return worldCatalogProjectsSchema.parse(
        await request(
          `/v1/servers/${value.serverId}/minecraft/world-catalog/search?${params}`,
          'GET',
          undefined,
          signal,
        ),
      );
    },
    async worldCatalogFiles(serverId: string, projectId: string, offset = 0, signal?: AbortSignal) {
      const value = z
        .strictObject({
          serverId: uuid,
          projectId: z.string().regex(/^[1-9]\d{0,14}$/),
          offset: z.number().int().min(0).max(9980),
        })
        .parse({ serverId, projectId, offset });
      return worldCatalogFilesSchema.parse(
        await request(
          `/v1/servers/${value.serverId}/minecraft/world-catalog/curseforge/${value.projectId}/files?offset=${value.offset}`,
          'GET',
          undefined,
          signal,
        ),
      );
    },
    async acquireWorld(
      input: { serverId: string; projectId: string; versionId: string; idempotencyKey: string },
      signal?: AbortSignal,
    ) {
      const body = z
        .strictObject({
          serverId: uuid,
          projectId: z.string().regex(/^[1-9]\d{0,14}$/),
          versionId: z.string().regex(/^[1-9]\d{0,14}$/),
          idempotencyKey: key,
        })
        .parse(input);
      const result = sourceSchema.parse(
        await request(
          '/v1/minecraft/sources/world-catalog',
          'POST',
          { ...body, provider: 'curseforge' },
          signal,
        ),
      );
      if (result.state !== 'ready') throw new MinecraftUiError('conflict', 'source_not_ready');
      return result;
    },
    async searchContent(
      input: {
        choiceId: string;
        provider: 'modrinth' | 'curseforge';
        query: string;
        type: 'mod' | 'plugin' | 'modpack';
        offset?: number;
      },
      signal?: AbortSignal,
    ) {
      const parsed = z
        .object({
          choiceId: uuid,
          provider,
          query: z.string().max(256),
          type: z.enum(['mod', 'plugin', 'modpack']),
          offset: z.number().int().min(0).max(10000).default(0),
        })
        .strict()
        .parse(input);
      const choice = (await choices(signal)).find((c) => c.id === parsed.choiceId);
      const capability = choice && minecraftContentCapabilities(choice.runtime);
      if (
        !capability ||
        (parsed.type === 'mod' && !capability.mods) ||
        (parsed.type === 'plugin' && !capability.plugins)
      )
        throw new MinecraftUiError('integration_unavailable', 'content_not_supported');
      return request(
        `/v1/minecraft/content/search?${new URLSearchParams(Object.entries(parsed).map(([k, v]) => [k, String(v)]))}`,
        'GET',
        undefined,
        signal,
      );
    },
    async contentVersions(
      input: { choiceId: string; provider: 'modrinth' | 'curseforge'; projectId: string },
      signal?: AbortSignal,
    ) {
      const parsed = z.object({ choiceId: uuid, provider, projectId: key }).strict().parse(input);
      return request(
        `/v1/minecraft/content/versions?${new URLSearchParams(parsed)}`,
        'GET',
        undefined,
        signal,
      );
    },
  };
}
