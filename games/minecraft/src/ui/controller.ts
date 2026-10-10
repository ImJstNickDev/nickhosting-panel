import type { GameUiClient, UiOption, UiValues } from '@nickhosting/game-sdk/ui';
import { z } from 'zod';

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
const worldSchema = z
  .object({
    name: world,
    status: z.enum(['verified', 'incompatible', 'unavailable']),
    validation: z.unknown().optional(),
  })
  .strip();
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
export function minecraftContentCapabilities(runtime: MinecraftUiChoice['runtime']) {
  return {
    mods: runtime === 'fabric' || runtime === 'forge',
    plugins: runtime === 'paper' || runtime === 'folia',
  };
}
/** Same-origin NickHosting only; no provider URL/token or arbitrary API path is accepted. */
export function createMinecraftUiController(client: GameUiClient) {
  const request = (path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal) =>
    client.request(path, { method, ...(body === undefined ? {} : { body }), signal });
  const serverPath = (id: string, suffix = '') =>
    `/v1/servers/${uuid.parse(id)}/minecraft${suffix}`;
  const profile = async (serverId: string, signal?: AbortSignal) =>
    profileSchema.parse(await request(serverPath(serverId), 'GET', undefined, signal));
  const choices = async (signal?: AbortSignal) =>
    z
      .array(minecraftChoiceSchema)
      .max(10000)
      .parse(await request('/v1/minecraft/choices', 'GET', undefined, signal));
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
    async choiceOptions(signal?: AbortSignal): Promise<UiOption[]> {
      return (await choices(signal)).map((choice) => ({
        value: choice.id,
        label: `${choice.version} · ${choice.runtime}`,
        disabled: false,
        releaseType: choice.releaseType ?? 'release',
        ...(choice.capabilities ? { capabilities: choice.capabilities } : {}),
      }));
    },
    profile,
    async worlds(serverId: string, signal?: AbortSignal) {
      return z
        .array(worldSchema)
        .max(1000)
        .parse(await request(serverPath(serverId, '/worlds'), 'GET', undefined, signal));
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
      const current = await profile(serverId, signal);
      if (
        !current.supportedProperties ||
        Object.keys(changes).some((k) => !current.supportedProperties?.includes(k))
      )
        throw new MinecraftUiError('integration_unavailable', 'property_unavailable');
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
      kind: 'world' | 'modpack';
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
          kind: z.enum(['world', 'modpack']),
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
      await client.upload(`/v1/minecraft/sources/${reserved.id}/upload`, input.file, {
        bytes: input.file.size,
        signal: input.signal,
        onProgress: input.onProgress,
      });
      const finished = await source(reserved.id, input.signal);
      if (finished.state !== 'ready') throw new MinecraftUiError('conflict', 'source_not_ready');
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
