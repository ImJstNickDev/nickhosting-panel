import { posix } from 'node:path';
import { z } from 'zod';
import {
  gameContentPoliciesSchema,
  legacyContentEnvironmentKeys,
  normalizeLegacyContentSettings,
} from './content-policy.js';
import { dnsBlockedTermsSchema, dnsDomainsSchema, dnsGamePoliciesSchema } from './dns-policy.js';
import { DomainError } from './errors.js';
import {
  defaultGatewayDataPolicy,
  gatewayDataPolicySchema,
  gatewayNetworkPolicySchema,
  gatewayNodeProbesSchema,
  gatewayObserverSchema,
} from './gateway-config.js';
import { minecraftGatewayResponsesSchema } from './minecraft-gateway-config.js';

const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search
    );
  });

const origin = (protocols: string[]) =>
  z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return protocols.includes(url.protocol) && url.origin === value;
    });

export const gameIdleTimeoutSchema = z.union([z.literal(-1), z.number().int().min(1).max(604800)]);
export const idleTimeoutUserAccessSchema = z.enum(['hidden', 'editable', 'shorten-only']);
export const gameIdleTimeoutsSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    z.strictObject({
      gameTimeoutSeconds: gameIdleTimeoutSchema.nullable(),
      userAccess: idleTimeoutUserAccessSchema.nullable().default(null),
      runtimeUserAccess: z
        .record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), idleTimeoutUserAccessSchema)
        .default({}),
      runtimeTimeouts: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), gameIdleTimeoutSchema),
    }),
  )
  .transform((policies, context) => {
    // Environment overrides can outlive the database migration. Accept exactly
    // this historical integration key while exposing only the canonical identity.
    const legacy = policies['minecraft-java'];
    if (!legacy) return policies;
    if (policies.minecraft) {
      context.addIssue({ code: 'custom', message: 'Conflicting Minecraft integration identities' });
      return z.NEVER;
    }
    const { 'minecraft-java': _legacy, ...current } = policies;
    return { ...current, minecraft: legacy };
  });

export const platformConfigSchema = z
  .object({
    instanceName: z.string().trim().min(1).max(100),
    defaultLocale: z.enum(['en', 'it']),
    publicUrl: httpUrl.optional(),
    apiUrl: httpUrl.optional(),
    pterodactylBaseUrl: httpUrl.optional(),
    dockerObserverSocket: z
      .string()
      .refine(
        (value) =>
          posix.isAbsolute(value) &&
          value !== '/' &&
          posix.normalize(value) === value &&
          !value.endsWith('/') &&
          !/[?#]/.test(value) &&
          !Array.from(value).some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127;
          }),
      )
      .optional(),
    pterodactylWebSocketOrigins: z.array(origin(['ws:', 'wss:'])).max(50),
    pterodactylDownloadOrigins: z.array(origin(['http:', 'https:'])).max(50),
    pterodactylUploadOrigins: z.array(origin(['http:', 'https:'])).max(50),
    uploadConcurrency: z.number().int().min(1).max(6),
    registrationInviteTtlSeconds: z.number().int().min(60).max(31_536_000),
    supportIdleTtlSeconds: z.number().int().min(60).max(900),
    supportAbsoluteTtlSeconds: z.number().int().min(60).max(3600),
    sessionTtlSeconds: z.number().int().min(300).max(2_592_000),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']),
    discordClientId: z.string().trim().min(1).max(100).optional(),
    smtpHost: z.string().trim().min(1).max(253).optional(),
    smtpPort: z.number().int().min(1).max(65535),
    smtpSecure: z.boolean(),
    smtpUser: z.string().trim().min(1).max(320).optional(),
    smtpFrom: z.string().trim().min(1).max(320).optional(),
    storagePolicy: z.enum(['GLOBAL_POOL', 'PER_USER_BUDGET']),
    defaultUserMemoryMiB: z.number().int().min(1).max(1048576),
    defaultUserCpuPercent: z.number().int().min(1).max(100000),
    defaultServerStorageMiB: z.number().int().min(16).max(1073741824),
    defaultUserStorageMiB: z.number().int().min(1).max(1073741824),
    maxServersPerUser: z.number().int().min(1).max(10000).nullable(),
    maxConcurrentProvisionsPerUser: z.number().int().min(1).max(100),
    observationMaxAgeSeconds: z.number().int().min(1).max(30),
    sftpgoBaseUrl: httpUrl.optional(),
    sftpgoDataRoot: z.string().startsWith('/').optional(),
    sftpgoInstanceId: z.uuid().optional(),
    fileViewers: z
      .strictObject({
        managementUrl: httpUrl,
        dataRoot: z.string().regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/),
        instanceId: z.uuid(),
        host: z.union([z.hostname(), z.ipv4(), z.ipv6()]),
        port: z.number().int().min(1).max(65535).default(2022),
        hostFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/),
        cacheRoot: z.string().regex(/^\.\/mountdata\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
        cacheBytes: z.number().int().min(1048576).max(107374182400).default(1073741824),
        maxSnapshotBytes: z.number().int().min(1048576).max(10737418240).default(268435456),
        maxConnections: z.number().int().min(1).max(64).default(16),
      })
      .optional(),
    // Public SSH endpoint is explicitly configured, never inferred from the
    // private SFTPGo HTTP management URL or the Wings filesystem mapping.
    sftpPublicHostname: z.union([z.hostname(), z.ipv4(), z.ipv6()]).optional(),
    sftpPublicPort: z.number().int().min(1).max(65535).optional(),
    dnsInstanceId: z.uuid().optional(),
    sftpAuxiliaryLimit: z.number().int().min(0).max(32),
    sftpCredentialTtlSeconds: z.number().int().min(60).max(86400),
    cloudflareZoneId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    dnsBaseDomain: z.string().min(1).max(253).optional(),
    dnsTarget: z.string().min(1).max(253).optional(),
    dnsDomains: dnsDomainsSchema,
    dnsDefaultDomainId: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .optional(),
    dnsGamePolicies: dnsGamePoliciesSchema,
    dnsBlockedTerms: dnsBlockedTermsSchema,
    dnsNameReuseDelaySeconds: z.number().int().min(0).max(2592000),
    dnsAvailabilityCacheSeconds: z.number().int().min(0).max(300),
    dnsAvailabilityRequestsPerMinute: z.number().int().min(2).max(200),
    dnsAvailabilityConcurrency: z.number().int().min(1).max(8),
    staticGameHostname: z.string().min(1).max(253).optional(),
    contentMetadataUserAgent: z
      .string()
      .min(10)
      .max(256)
      .refine((value) => !/[\r\n]/.test(value))
      .optional(),
    fileOperationsFreeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    fileOperationsFreePercent: z.number().min(0).max(95),
    fileOperationsRoot: z.string().regex(/^\.\/mountdata\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
    gameContentPolicies: gameContentPoliciesSchema,
    contentSourceRoot: z.string().regex(/^\.\/mountdata\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
    contentSourceGlobalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    contentSourceUserBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    contentSourceConcurrent: z.number().int().min(1).max(100),
    contentSourceUserConcurrent: z.number().int().min(1).max(20),
    contentSourceFreeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contentSourceFreePercent: z.number().min(0).max(95),
    contentWorkRoot: z.string().regex(/^\.\/mountdata\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
    contentDownloadOrigins: z.array(origin(['https:'])).max(100),
    minecraftGatewayResponses: minecraftGatewayResponsesSchema.optional(),
    minecraftProtocolSource: z
      .object({
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    gatewayDiagnosticsSocket: z
      .string()
      .startsWith('/')
      .max(100)
      .refine((v) => posix.normalize(v) === v && !/[\0-\x20?#]/.test(v))
      .optional(),
    gameIdleTimeouts: gameIdleTimeoutsSchema,
    defaultIdleTimeoutSeconds: gameIdleTimeoutSchema,
    idleTimeoutUserAccess: idleTimeoutUserAccessSchema,
    gatewayEnabled: z.boolean(),
    gatewayId: z.uuid().optional(),
    gatewayPhysicalHostId: z.uuid().optional(),
    gatewayCoreUrl: httpUrl.optional(),
    gatewayLeaseSeconds: z.number().int().min(3).max(30),
    gatewayNetworkPolicy: gatewayNetworkPolicySchema.optional(),
    gatewayObserver: gatewayObserverSchema.optional(),
    gatewayNodeProbes: gatewayNodeProbesSchema,
    gatewayDataPolicy: gatewayDataPolicySchema,
  })
  .strict();

export const platformConfigPatchSchema = z.preprocess(
  normalizeLegacyContentSettings,
  platformConfigSchema.partial(),
);
export type PlatformConfig = z.infer<typeof platformConfigSchema>;
export type PlatformConfigKey = keyof PlatformConfig;
export type ConfigSource = 'default' | 'database' | 'environment';

export const defaultPlatformConfig: Readonly<PlatformConfig> = Object.freeze({
  instanceName: 'NickHosting',
  defaultLocale: 'en',
  pterodactylWebSocketOrigins: [],
  pterodactylDownloadOrigins: [],
  pterodactylUploadOrigins: [],
  uploadConcurrency: 2,
  registrationInviteTtlSeconds: 86_400,
  supportIdleTtlSeconds: 300,
  supportAbsoluteTtlSeconds: 900,
  sessionTtlSeconds: 604_800,
  logLevel: 'info',
  smtpPort: 587,
  smtpSecure: false,
  storagePolicy: 'GLOBAL_POOL',
  defaultUserMemoryMiB: 16384,
  defaultUserCpuPercent: 400,
  defaultUserStorageMiB: 32768,
  defaultServerStorageMiB: 4096,
  maxServersPerUser: null,
  maxConcurrentProvisionsPerUser: 4,
  observationMaxAgeSeconds: 4,
  sftpAuxiliaryLimit: 3,
  sftpCredentialTtlSeconds: 3600,
  gameIdleTimeouts: {},
  dnsDomains: [],
  dnsGamePolicies: {},
  dnsBlockedTerms: [],
  dnsNameReuseDelaySeconds: 0,
  dnsAvailabilityCacheSeconds: 30,
  dnsAvailabilityRequestsPerMinute: 60,
  dnsAvailabilityConcurrency: 2,
  defaultIdleTimeoutSeconds: -1,
  idleTimeoutUserAccess: 'hidden',
  gatewayEnabled: false,
  gatewayLeaseSeconds: 15,
  gatewayNodeProbes: {},
  gatewayDataPolicy: defaultGatewayDataPolicy,
  contentMetadataUserAgent:
    'NickHostingPanel/0.1 (+https://github.com/ImJstNickDev/nickhosting-panel)',
  fileOperationsFreeBytes: 512 * 1024 ** 2,
  fileOperationsFreePercent: 0,
  fileOperationsRoot: './mountdata/file-operations',
  // Keep historical storage locations: existing files and in-flight jobs must not move.
  gameContentPolicies: {},
  contentWorkRoot: './mountdata/minecraft-content',
  contentSourceRoot: './mountdata/minecraft-sources',
  contentSourceGlobalBytes: 20 * 1024 ** 3,
  contentSourceUserBytes: 5 * 1024 ** 3,
  contentSourceConcurrent: 4,
  contentSourceUserConcurrent: 2,
  contentSourceFreeBytes: 512 * 1024 ** 2,
  contentSourceFreePercent: 10,
  contentDownloadOrigins: [
    'https://cdn.modrinth.com',
    'https://edge.forgecdn.net',
    'https://mediafilez.forgecdn.net',
  ],
});

export const configEnvironmentKeys = {
  instanceName: 'NH_INSTANCE_NAME',
  defaultLocale: 'NH_DEFAULT_LOCALE',
  publicUrl: 'NH_PUBLIC_URL',
  apiUrl: 'NH_API_URL',
  pterodactylBaseUrl: 'NH_PTERODACTYL_BASE_URL',
  dockerObserverSocket: 'NH_DOCKER_OBSERVER_SOCKET',
  pterodactylWebSocketOrigins: 'NH_PTERODACTYL_WEBSOCKET_ORIGINS',
  pterodactylDownloadOrigins: 'NH_PTERODACTYL_DOWNLOAD_ORIGINS',
  pterodactylUploadOrigins: 'NH_PTERODACTYL_UPLOAD_ORIGINS',
  uploadConcurrency: 'NH_UPLOAD_CONCURRENCY',
  registrationInviteTtlSeconds: 'NH_INVITE_TTL_SECONDS',
  supportIdleTtlSeconds: 'NH_SUPPORT_IDLE_TTL_SECONDS',
  supportAbsoluteTtlSeconds: 'NH_SUPPORT_ABSOLUTE_TTL_SECONDS',
  sessionTtlSeconds: 'NH_SESSION_TTL_SECONDS',
  logLevel: 'NH_LOG_LEVEL',
  discordClientId: 'DISCORD_CLIENT_ID',
  smtpHost: 'SMTP_HOST',
  smtpPort: 'SMTP_PORT',
  smtpSecure: 'SMTP_SECURE',
  smtpUser: 'SMTP_USER',
  smtpFrom: 'SMTP_FROM',
  storagePolicy: 'NH_STORAGE_POLICY',
  defaultUserMemoryMiB: 'NH_DEFAULT_USER_MEMORY_MIB',
  defaultUserCpuPercent: 'NH_DEFAULT_USER_CPU_PERCENT',
  defaultUserStorageMiB: 'NH_DEFAULT_USER_STORAGE_MIB',
  defaultServerStorageMiB: 'NH_DEFAULT_SERVER_STORAGE_MIB',
  maxServersPerUser: 'NH_MAX_SERVERS_PER_USER',
  maxConcurrentProvisionsPerUser: 'NH_MAX_CONCURRENT_PROVISIONS_PER_USER',
  observationMaxAgeSeconds: 'NH_OBSERVATION_MAX_AGE_SECONDS',
  sftpgoBaseUrl: 'NH_SFTPGO_BASE_URL',
  sftpgoDataRoot: 'NH_SFTPGO_DATA_ROOT',
  sftpgoInstanceId: 'NH_SFTPGO_INSTANCE_ID',
  fileViewers: 'NH_FILE_VIEWERS',
  sftpPublicHostname: 'NH_SFTP_PUBLIC_HOSTNAME',
  sftpPublicPort: 'NH_SFTP_PUBLIC_PORT',
  sftpAuxiliaryLimit: 'NH_SFTP_AUXILIARY_LIMIT',
  sftpCredentialTtlSeconds: 'NH_SFTP_CREDENTIAL_TTL_SECONDS',
  cloudflareZoneId: 'NH_CLOUDFLARE_ZONE_ID',
  dnsInstanceId: 'NH_DNS_INSTANCE_ID',
  dnsBaseDomain: 'NH_DNS_BASE_DOMAIN',
  dnsTarget: 'NH_DNS_TARGET',
  dnsDomains: 'NH_DNS_DOMAINS',
  dnsDefaultDomainId: 'NH_DNS_DEFAULT_DOMAIN_ID',
  dnsGamePolicies: 'NH_DNS_GAME_POLICIES',
  dnsBlockedTerms: 'NH_DNS_BLOCKED_TERMS',
  dnsNameReuseDelaySeconds: 'NH_DNS_NAME_REUSE_DELAY_SECONDS',
  dnsAvailabilityCacheSeconds: 'NH_DNS_AVAILABILITY_CACHE_SECONDS',
  dnsAvailabilityRequestsPerMinute: 'NH_DNS_AVAILABILITY_REQUESTS_PER_MINUTE',
  dnsAvailabilityConcurrency: 'NH_DNS_AVAILABILITY_CONCURRENCY',
  staticGameHostname: 'NH_STATIC_GAME_HOSTNAME',
  gameContentPolicies: 'NH_GAME_CONTENT_POLICIES',
  contentMetadataUserAgent: 'NH_CONTENT_METADATA_USER_AGENT',
  fileOperationsFreeBytes: 'NH_FILE_OPERATIONS_FREE_BYTES',
  fileOperationsFreePercent: 'NH_FILE_OPERATIONS_FREE_PERCENT',
  fileOperationsRoot: 'NH_FILE_OPERATIONS_ROOT',
  contentWorkRoot: 'NH_CONTENT_WORK_ROOT',
  contentSourceRoot: 'NH_CONTENT_SOURCE_ROOT',
  contentSourceGlobalBytes: 'NH_CONTENT_SOURCE_GLOBAL_BYTES',
  contentSourceUserBytes: 'NH_CONTENT_SOURCE_USER_BYTES',
  contentSourceConcurrent: 'NH_CONTENT_SOURCE_CONCURRENT',
  contentSourceUserConcurrent: 'NH_CONTENT_SOURCE_USER_CONCURRENT',
  contentSourceFreeBytes: 'NH_CONTENT_SOURCE_FREE_BYTES',
  contentSourceFreePercent: 'NH_CONTENT_SOURCE_FREE_PERCENT',
  contentDownloadOrigins: 'NH_CONTENT_DOWNLOAD_ORIGINS',
  minecraftProtocolSource: 'NH_MINECRAFT_PROTOCOL_SOURCE',
  minecraftGatewayResponses: 'NH_MINECRAFT_GATEWAY_RESPONSES',
  gatewayDiagnosticsSocket: 'NH_GATEWAY_DIAGNOSTICS_SOCKET',
  gameIdleTimeouts: 'NH_GAME_IDLE_TIMEOUTS',
  defaultIdleTimeoutSeconds: 'NH_DEFAULT_IDLE_TIMEOUT_SECONDS',
  idleTimeoutUserAccess: 'NH_IDLE_TIMEOUT_USER_ACCESS',
  gatewayEnabled: 'NH_GATEWAY_ENABLED',
  gatewayId: 'NH_GATEWAY_ID',
  gatewayPhysicalHostId: 'NH_GATEWAY_PHYSICAL_HOST_ID',
  gatewayCoreUrl: 'NH_GATEWAY_CORE_URL',
  gatewayLeaseSeconds: 'NH_GATEWAY_LEASE_SECONDS',
  gatewayNetworkPolicy: 'NH_GATEWAY_NETWORK_POLICY',
  gatewayObserver: 'NH_GATEWAY_OBSERVER',
  gatewayNodeProbes: 'NH_GATEWAY_NODE_PROBES',
  gatewayDataPolicy: 'NH_GATEWAY_DATA_POLICY',
} as const satisfies Record<PlatformConfigKey, string>;

const numericKeys = new Set<PlatformConfigKey>([
  'dnsNameReuseDelaySeconds',
  'dnsAvailabilityCacheSeconds',
  'dnsAvailabilityRequestsPerMinute',
  'dnsAvailabilityConcurrency',
  'uploadConcurrency',
  'registrationInviteTtlSeconds',
  'supportIdleTtlSeconds',
  'supportAbsoluteTtlSeconds',
  'sessionTtlSeconds',
  'smtpPort',
  'defaultUserMemoryMiB',
  'defaultUserCpuPercent',
  'defaultUserStorageMiB',
  'defaultServerStorageMiB',
  'maxServersPerUser',
  'maxConcurrentProvisionsPerUser',
  'observationMaxAgeSeconds',
  'sftpAuxiliaryLimit',
  'sftpCredentialTtlSeconds',
  'sftpPublicPort',
  'gatewayLeaseSeconds',
  'contentSourceGlobalBytes',
  'contentSourceUserBytes',
  'contentSourceConcurrent',
  'contentSourceUserConcurrent',
  'contentSourceFreeBytes',
  'contentSourceFreePercent',
]);

function invalid(fields: string[]): never {
  throw new DomainError('configuration_invalid', 400, { fields });
}

export interface ResolvedConfig {
  values: Readonly<PlatformConfig>;
  sources: Readonly<Record<PlatformConfigKey, ConfigSource>>;
  lockedKeys: readonly PlatformConfigKey[];
}

/** Undefined means absent; empty values, invalid false/zero coercions and unknown DB keys fail. */
export function resolveConfig(
  ownerSettings: unknown = {},
  env: Readonly<Record<string, string | undefined>> = {},
): ResolvedConfig {
  const owner = platformConfigPatchSchema.safeParse(ownerSettings);
  if (!owner.success) invalid(owner.error.issues.map((issue) => issue.path.join('.')));
  const merged: Record<string, unknown> = { ...defaultPlatformConfig };
  const sources = {} as Record<PlatformConfigKey, ConfigSource>;
  const lockedKeys: PlatformConfigKey[] = [];
  for (const key of Object.keys(configEnvironmentKeys) as PlatformConfigKey[]) {
    sources[key] = 'default';
    if (owner.data[key] !== undefined) {
      merged[key] = owner.data[key];
      sources[key] = 'database';
    }
    const alias = legacyContentEnvironmentKeys[key as keyof typeof legacyContentEnvironmentKeys];
    const value = env[configEnvironmentKeys[key]] ?? (alias ? env[alias] : undefined);
    if (value === undefined) continue;
    if (value.trim() === '') invalid([key]);
    if (
      key === 'pterodactylWebSocketOrigins' ||
      key === 'pterodactylDownloadOrigins' ||
      key === 'pterodactylUploadOrigins' ||
      [
        'gameIdleTimeouts',
        'gameContentPolicies',
        'dnsDomains',
        'dnsGamePolicies',
        'dnsBlockedTerms',
        'fileViewers',
        'gatewayNetworkPolicy',
        'gatewayObserver',
        'gatewayNodeProbes',
        'gatewayDataPolicy',
        'contentDownloadOrigins',
        'minecraftProtocolSource',
        'minecraftGatewayResponses',
      ].includes(key)
    ) {
      try {
        merged[key] = JSON.parse(value);
      } catch {
        invalid([key]);
      }
    } else if (key === 'defaultIdleTimeoutSeconds') {
      if (!/^(-1|[1-9]\d*)$/.test(value)) invalid([key]);
      merged[key] = Number(value);
    } else if (key === 'maxServersPerUser' && value === 'null') {
      merged[key] = null;
    } else if (numericKeys.has(key)) {
      if (!/^(0|[1-9]\d*)$/.test(value)) invalid([key]);
      merged[key] = Number(value);
    } else if (key === 'smtpSecure' || key === 'gatewayEnabled') {
      if (!['true', 'false', '1', '0'].includes(value)) invalid([key]);
      merged[key] = value === 'true' || value === '1';
    } else {
      merged[key] = value;
    }
    sources[key] = 'environment';
    lockedKeys.push(key);
  }
  const result = platformConfigSchema.safeParse(merged);
  if (!result.success) invalid(result.error.issues.map((issue) => issue.path.join('.')));
  if (result.data.supportIdleTtlSeconds > result.data.supportAbsoluteTtlSeconds)
    invalid(['supportIdleTtlSeconds']);
  return {
    values: Object.freeze(result.data),
    sources: Object.freeze(sources),
    lockedKeys: Object.freeze(lockedKeys),
  };
}

/** A settings write must not pretend to change a value locked by the environment. */
export function assertConfigWritable(
  patch: unknown,
  resolved: ResolvedConfig,
): asserts patch is Partial<PlatformConfig> {
  const result = platformConfigPatchSchema.safeParse(patch);
  if (!result.success) invalid(result.error.issues.map((issue) => issue.path.join('.')));
  const locked = Object.keys(result.data).filter((key) =>
    resolved.lockedKeys.includes(key as PlatformConfigKey),
  );
  if (locked.length)
    throw new DomainError('conflict', 409, { fields: locked, reason: 'environment_override' });
}

export function assertPublicUrls(
  config: PlatformConfig,
): asserts config is PlatformConfig & { publicUrl: string; apiUrl: string } {
  const missing = (['publicUrl', 'apiUrl'] as const).filter((key) => !config[key]);
  if (missing.length) invalid([...missing]);
}
