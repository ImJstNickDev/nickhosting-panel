import { z } from 'zod';
import { DomainError } from './errors.js';

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

export const platformConfigSchema = z
  .object({
    instanceName: z.string().trim().min(1).max(100),
    defaultLocale: z.enum(['en', 'it']),
    publicUrl: httpUrl.optional(),
    apiUrl: httpUrl.optional(),
    pterodactylBaseUrl: httpUrl.optional(),
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
  })
  .strict();

export const platformConfigPatchSchema = platformConfigSchema.partial();
export type PlatformConfig = z.infer<typeof platformConfigSchema>;
export type PlatformConfigKey = keyof PlatformConfig;
export type ConfigSource = 'default' | 'database' | 'environment';

export const defaultPlatformConfig: Readonly<PlatformConfig> = Object.freeze({
  instanceName: 'NickHosting',
  defaultLocale: 'en',
  registrationInviteTtlSeconds: 86_400,
  supportIdleTtlSeconds: 300,
  supportAbsoluteTtlSeconds: 900,
  sessionTtlSeconds: 604_800,
  logLevel: 'info',
  smtpPort: 587,
  smtpSecure: false,
});

export const configEnvironmentKeys = {
  instanceName: 'NH_INSTANCE_NAME',
  defaultLocale: 'NH_DEFAULT_LOCALE',
  publicUrl: 'NH_PUBLIC_URL',
  apiUrl: 'NH_API_URL',
  pterodactylBaseUrl: 'NH_PTERODACTYL_BASE_URL',
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
} as const satisfies Record<PlatformConfigKey, string>;

const numericKeys = new Set<PlatformConfigKey>([
  'registrationInviteTtlSeconds',
  'supportIdleTtlSeconds',
  'supportAbsoluteTtlSeconds',
  'sessionTtlSeconds',
  'smtpPort',
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
    if (numericKeys.has(key)) {
      if (!/^(0|[1-9]\d*)$/.test(value)) invalid([key]);
      merged[key] = Number(value);
    } else if (key === 'smtpSecure') {
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
