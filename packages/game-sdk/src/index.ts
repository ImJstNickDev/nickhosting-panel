import { DomainError, type PlatformRole } from '@nickhosting/core';
import { z } from 'zod';

export const gameRolloutStates = [
  'development',
  'private-testing',
  'public',
  'disabled-for-new-servers',
] as const;
export const gameRolloutSchema = z
  .object({
    gameId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    state: z.enum(gameRolloutStates),
    allowedUserIds: z.array(z.string().min(1)).max(10_000).default([]),
  })
  .strict();
export type GameRollout = z.infer<typeof gameRolloutSchema>;
export type GameRolloutState = (typeof gameRolloutStates)[number];
export type RolloutState = GameRolloutState;

export interface GameAccess {
  visible: boolean;
  canCreate: boolean;
  canManageExisting: boolean;
}

/** Rollout never grants resource permission. Existing access must come from core authorization. */
export function evaluateGameAccess(
  policy: GameRollout,
  viewer: { userId: string; role: PlatformRole },
  options: { hasExistingServerAccess?: boolean } = {},
): GameAccess {
  const parsed = gameRolloutSchema.safeParse(policy);
  if (!parsed.success || !viewer.userId || !['owner', 'operator', 'user'].includes(viewer.role))
    throw new DomainError('validation_failed');
  const rollout = parsed.data;
  const owner = viewer.role === 'owner';
  const permitted =
    owner ||
    rollout.state === 'public' ||
    (rollout.state === 'private-testing' && rollout.allowedUserIds.includes(viewer.userId));
  const canManageExisting = owner || options.hasExistingServerAccess === true;
  return {
    visible: permitted || canManageExisting,
    canCreate: rollout.state !== 'disabled-for-new-servers' && permitted,
    canManageExisting,
  };
}

export function assertGameAccess(
  access: GameAccess,
  action: 'visible' | 'canCreate' | 'canManageExisting',
): void {
  if (!access[action]) throw new DomainError('forbidden');
}

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const translationKey = z.string().regex(/^games\.[a-z][a-z0-9-]*\.[a-zA-Z0-9_.-]+$/);
const settingKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/);

export const connectionModeSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('custom-subdomain'),
      zoneSettingKey: settingKey,
      srv: z
        .object({ service: z.string().regex(/^_[a-z0-9-]+$/), proto: z.enum(['tcp', 'udp']) })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('static-host-port'),
      hostnameSettingKey: settingKey,
      showPort: z.literal(true),
    })
    .strict(),
]);
export type ConnectionMode = z.infer<typeof connectionModeSchema>;

export const portRequirementSchema = z
  .object({
    role: identifier,
    transport: z.enum(['tcp', 'udp', 'both']),
    defaultPort: z.number().int().min(1).max(65535).optional(),
    required: z.boolean(),
  })
  .strict();
export type PortRequirement = z.infer<typeof portRequirementSchema>;

const capabilitySchema = z
  .object({
    console: z.boolean(),
    files: z.boolean(),
    backups: z.boolean(),
    players: z.boolean(),
    mods: z.boolean(),
    worlds: z.boolean(),
    idleDetection: z.boolean(),
    gracefulStop: z.boolean(),
    readiness: z.boolean(),
    wake: z.enum(['unsupported', 'manual', 'verified-protocol']),
  })
  .strict();
export type GameCapabilities = z.infer<typeof capabilitySchema>;

export const gameManifestSchema = z
  .object({
    id: identifier,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
    nameKey: translationKey,
    capabilities: capabilitySchema,
    connection: connectionModeSchema,
    ports: z.array(portRequirementSchema).min(1),
    runtimes: z
      .array(
        z
          .object({
            id: identifier,
            nameKey: translationKey,
            supportedGameVersions: z.array(z.string().min(1)),
            supports: z.record(z.string(), z.boolean()),
          })
          .strict(),
      )
      .min(1),
    wizard: z
      .object({
        steps: z.array(
          z
            .object({
              id: identifier,
              titleKey: translationKey,
              fields: z.array(settingKey),
              when: z
                .object({
                  field: settingKey,
                  equals: z.union([z.string(), z.number(), z.boolean()]),
                })
                .strict()
                .optional(),
            })
            .strict(),
        ),
      })
      .strict(),
    management: z.array(
      z
        .object({
          id: identifier,
          titleKey: translationKey,
          requiredCapability: z.enum(['console', 'files', 'backups', 'players', 'mods', 'worlds']),
        })
        .strict(),
    ),
    contentProviders: z.array(identifier).default([]),
    localizations: z
      .object({ namespace: z.string(), locales: z.array(z.enum(['en', 'it'])).min(2) })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const unique = (values: string[], path: string) => {
      if (new Set(values).size !== values.length)
        context.addIssue({ code: 'custom', path: [path], message: 'duplicate_identifier' });
    };
    unique(
      manifest.ports.map((port) => port.role),
      'ports',
    );
    unique(
      manifest.runtimes.map((runtime) => runtime.id),
      'runtimes',
    );
    unique(
      manifest.wizard.steps.map((step) => step.id),
      'wizard',
    );
    unique(
      manifest.management.map((entry) => entry.id),
      'management',
    );
    unique(manifest.localizations.locales, 'localizations');
    if (manifest.localizations.namespace !== `games.${manifest.id}`)
      context.addIssue({ code: 'custom', path: ['localizations'], message: 'invalid_namespace' });
    const keys = [
      manifest.nameKey,
      ...manifest.runtimes.map((runtime) => runtime.nameKey),
      ...manifest.wizard.steps.map((step) => step.titleKey),
      ...manifest.management.map((entry) => entry.titleKey),
    ];
    if (keys.some((key) => !key.startsWith(`games.${manifest.id}.`)))
      context.addIssue({
        code: 'custom',
        path: ['nameKey'],
        message: 'invalid_translation_namespace',
      });
    for (const entry of manifest.management) {
      if (!manifest.capabilities[entry.requiredCapability])
        context.addIssue({
          code: 'custom',
          path: ['management'],
          message: 'unsupported_capability',
        });
    }
  });
export type GameManifest = z.infer<typeof gameManifestSchema>;

/** Populated by Owner configuration and adapter discovery, not plugin defaults. */
export interface RuntimeEggMapping {
  gameId: string;
  runtimeId: string;
  mappingId: string;
  nestId: string;
  eggId: string;
  compatibleImages: readonly string[];
  variables: Readonly<Record<string, string>>;
}

export interface ServerPlan {
  gameId: string;
  runtimeId: string;
  gameVersion: string;
  configuration: Readonly<Record<string, unknown>>;
  ports: readonly PortRequirement[];
}

/** Core creates an instance scoped to one authorized server, without exposing tokens. */
export interface AuthorizedGameServices {
  readonly serverId: string;
  readonly operationId: string;
  readonly actorUserId: string;
  readonly ownerUserId: string;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  sendConsoleCommand(command: string): Promise<void>;
  requestPower(action: 'start' | 'stop' | 'restart'): Promise<void>;
  recordProgress(
    messageKey: string,
    parameters?: Readonly<Record<string, string | number>>,
  ): Promise<void>;
}

export interface GameRuntimeHandler {
  readonly id: string;
  readonly configurationSchema: z.ZodType<Readonly<Record<string, unknown>>>;
  buildPlan(
    configuration: Readonly<Record<string, unknown>>,
    gameVersion: string,
  ): Promise<ServerPlan>;
  configureServer?(plan: ServerPlan, services: AuthorizedGameServices): Promise<void>;
}

export type JoinIntent =
  | { kind: 'status' | 'ignore' }
  | { kind: 'join'; protocolVersion?: number }
  | { kind: 'unsupported'; messageKey: string };
export interface ProtocolContext {
  serverId: string;
  gameVersion: string;
  locale: 'en' | 'it';
  protocolVersion?: number;
}
export interface ProtocolHandler {
  id: string;
  supports(gameVersion: string, protocolVersion?: number): boolean;
  parseJoinAttempt(input: Uint8Array, context: ProtocolContext): JoinIntent;
  sleepingStatus?(context: ProtocolContext): Uint8Array;
  wakingResponse?(context: ProtocolContext): Uint8Array;
  resourcesUnavailable?(context: ProtocolContext): Uint8Array;
}

export interface IdleSleepWakeProvider {
  observeIdle?(
    services: AuthorizedGameServices,
  ): Promise<{ idle: boolean; observedAt: Date; playerCount?: number }>;
  saveAndStop?(services: AuthorizedGameServices): Promise<void>;
  checkReadiness?(
    services: AuthorizedGameServices,
  ): Promise<{ ready: boolean; messageKey?: string }>;
  protocols?: readonly ProtocolHandler[];
}

export interface GameIntegration {
  manifest: GameManifest;
  runtimes: readonly GameRuntimeHandler[];
  lifecycle?: IdleSleepWakeProvider;
}

export function defineGameIntegration(integration: GameIntegration): GameIntegration {
  const parsed = gameManifestSchema.safeParse(integration.manifest);
  if (!parsed.success)
    throw new DomainError('validation_failed', 400, {
      fields: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  const declared = parsed.data.runtimes.map((runtime) => runtime.id).sort();
  const supplied = integration.runtimes.map((runtime) => runtime.id).sort();
  if (JSON.stringify(declared) !== JSON.stringify(supplied))
    throw new DomainError('configuration_invalid');
  const capabilities = parsed.data.capabilities;
  if (
    (capabilities.idleDetection && !integration.lifecycle?.observeIdle) ||
    (capabilities.gracefulStop && !integration.lifecycle?.saveAndStop) ||
    (capabilities.readiness && !integration.lifecycle?.checkReadiness) ||
    (capabilities.wake === 'verified-protocol' && !integration.lifecycle?.protocols?.length)
  ) {
    throw new DomainError('configuration_invalid');
  }
  return { ...integration, manifest: parsed.data };
}
