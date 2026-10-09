import { posix } from 'node:path';
import { z } from 'zod';
import { DomainError } from './errors.js';
import {
  defaultGatewayDataPolicy,
  gatewayDataPolicySchema,
  gatewayNetworkPolicySchema,
  gatewayNodeProbesSchema,
  gatewayObserverSchema,
} from './gateway-config.js';

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
    defaultUserStorageMiB: z.number().int().min(1).max(1073741824),
    maxServersPerUser: z.number().int().min(1).max(10000).nullable(),
    maxConcurrentProvisionsPerUser: z.number().int().min(1).max(100),
    observationMaxAgeSeconds: z.number().int().min(1).max(30),
    sftpgoBaseUrl: httpUrl.optional(),
    sftpgoDataRoot: z.string().startsWith('/').optional(),
    sftpgoInstanceId: z.uuid().optional(),
    dnsInstanceId: z.uuid().optional(),
    sftpCredentialTtlSeconds: z.number().int().min(60).max(86400),
    cloudflareZoneId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    dnsBaseDomain: z.string().min(1).max(253).optional(),
    dnsTarget: z.string().min(1).max(253).optional(),
    staticGameHostname: z.string().min(1).max(253).optional(),
    minecraftMetadataUserAgent: z
      .string()
      .min(10)
      .max(256)
      .refine((value) => !/[\r\n]/.test(value))
      .optional(),
    minecraftSourceRoot: z.string().regex(/^\.\/mountdata\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
    minecraftSourceGlobalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    minecraftSourceUserBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    minecraftSourceConcurrent: z.number().int().min(1).max(100),
    minecraftSourceUserConcurrent: z.number().int().min(1).max(20),
    minecraftSourceFreeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    minecraftSourceFreePercent: z.number().min(0).max(95),
    minecraftContentRoot: z.string().regex(/^\.\/mountdata\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
    minecraftDownloadOrigins: z.array(origin(['https:'])).max(100),
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

export const platformConfigPatchSchema = platformConfigSchema.partial();
export type PlatformConfig = z.infer<typeof platformConfigSchema>;
export type PlatformConfigKey = keyof PlatformConfig;
export type ConfigSource = 'default' | 'database' | 'environment';

export const defaultPlatformConfig: Readonly<PlatformConfig> = Object.freeze({
  instanceName: 'NickHosting',
  defaultLocale: 'en',
  pterodactylWebSocketOrigins: [],
  pterodactylDownloadOrigins: [],
  pterodactylUploadOrigins: [],
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
  maxServersPerUser: null,
  maxConcurrentProvisionsPerUser: 4,
  observationMaxAgeSeconds: 15,
  sftpCredentialTtlSeconds: 3600,
  gatewayEnabled: false,
  gatewayLeaseSeconds: 15,
  gatewayNodeProbes: {},
  gatewayDataPolicy: defaultGatewayDataPolicy,
  minecraftContentRoot: './mountdata/minecraft-content',
  minecraftSourceRoot: './mountdata/minecraft-sources',
  minecraftSourceGlobalBytes: 20 * 1024 ** 3,
  minecraftSourceUserBytes: 5 * 1024 ** 3,
  minecraftSourceConcurrent: 4,
  minecraftSourceUserConcurrent: 2,
  minecraftSourceFreeBytes: 512 * 1024 ** 2,
  minecraftSourceFreePercent: 10,
  minecraftDownloadOrigins: [
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
  maxServersPerUser: 'NH_MAX_SERVERS_PER_USER',
  maxConcurrentProvisionsPerUser: 'NH_MAX_CONCURRENT_PROVISIONS_PER_USER',
  observationMaxAgeSeconds: 'NH_OBSERVATION_MAX_AGE_SECONDS',
  sftpgoBaseUrl: 'NH_SFTPGO_BASE_URL',
  sftpgoDataRoot: 'NH_SFTPGO_DATA_ROOT',
  sftpgoInstanceId: 'NH_SFTPGO_INSTANCE_ID',
  sftpCredentialTtlSeconds: 'NH_SFTP_CREDENTIAL_TTL_SECONDS',
  cloudflareZoneId: 'NH_CLOUDFLARE_ZONE_ID',
  dnsInstanceId: 'NH_DNS_INSTANCE_ID',
  dnsBaseDomain: 'NH_DNS_BASE_DOMAIN',
  dnsTarget: 'NH_DNS_TARGET',
  staticGameHostname: 'NH_STATIC_GAME_HOSTNAME',
  minecraftMetadataUserAgent: 'NH_MINECRAFT_METADATA_USER_AGENT',
  minecraftContentRoot: 'NH_MINECRAFT_CONTENT_ROOT',
  minecraftSourceRoot: 'NH_MINECRAFT_SOURCE_ROOT',
  minecraftSourceGlobalBytes: 'NH_MINECRAFT_SOURCE_GLOBAL_BYTES',
  minecraftSourceUserBytes: 'NH_MINECRAFT_SOURCE_USER_BYTES',
  minecraftSourceConcurrent: 'NH_MINECRAFT_SOURCE_CONCURRENT',
  minecraftSourceUserConcurrent: 'NH_MINECRAFT_SOURCE_USER_CONCURRENT',
  minecraftSourceFreeBytes: 'NH_MINECRAFT_SOURCE_FREE_BYTES',
  minecraftSourceFreePercent: 'NH_MINECRAFT_SOURCE_FREE_PERCENT',
  minecraftDownloadOrigins: 'NH_MINECRAFT_DOWNLOAD_ORIGINS',
  minecraftProtocolSource: 'NH_MINECRAFT_PROTOCOL_SOURCE',
  gatewayDiagnosticsSocket: 'NH_GATEWAY_DIAGNOSTICS_SOCKET',
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
  'registrationInviteTtlSeconds',
  'supportIdleTtlSeconds',
  'supportAbsoluteTtlSeconds',
  'sessionTtlSeconds',
  'smtpPort',
  'defaultUserMemoryMiB',
  'defaultUserCpuPercent',
  'defaultUserStorageMiB',
  'maxServersPerUser',
  'maxConcurrentProvisionsPerUser',
  'observationMaxAgeSeconds',
  'sftpCredentialTtlSeconds',
  'gatewayLeaseSeconds',
  'minecraftSourceGlobalBytes',
  'minecraftSourceUserBytes',
  'minecraftSourceConcurrent',
  'minecraftSourceUserConcurrent',
  'minecraftSourceFreeBytes',
  'minecraftSourceFreePercent',
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
    const value = env[configEnvironmentKeys[key]];
    if (value === undefined) continue;
    if (value.trim() === '') invalid([key]);
    if (
      key === 'pterodactylWebSocketOrigins' ||
      key === 'pterodactylDownloadOrigins' ||
      key === 'pterodactylUploadOrigins' ||
      [
        'gatewayNetworkPolicy',
        'gatewayObserver',
        'gatewayNodeProbes',
        'gatewayDataPolicy',
        'minecraftDownloadOrigins',
        'minecraftProtocolSource',
      ].includes(key)
    ) {
      try {
        merged[key] = JSON.parse(value);
      } catch {
        invalid([key]);
      }
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
