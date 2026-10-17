import { z } from 'zod';
import type { PlatformConfig, ResolvedConfig } from './config.js';
import { DomainError } from './errors.js';

const bytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const contentPolicyOverrideSchema = z.strictObject({
  sourceGlobalBytes: bytes.optional(),
  sourceUserBytes: bytes.optional(),
  sourceConcurrent: z.number().int().min(1).max(100).optional(),
  sourceUserConcurrent: z.number().int().min(1).max(20).optional(),
  sourceFreeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  sourceFreePercent: z.number().min(0).max(95).optional(),
  downloadOrigins: z
    .array(
      z
        .string()
        .url()
        .refine((value) => {
          const url = new URL(value);
          return url.protocol === 'https:' && url.origin === value;
        }),
    )
    .max(100)
    .optional(),
});
export const gameContentPoliciesSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  contentPolicyOverrideSchema,
);
export type ContentPolicyOverride = z.infer<typeof contentPolicyOverrideSchema>;
export const contentPolicyKeys = [
  'sourceGlobalBytes',
  'sourceUserBytes',
  'sourceConcurrent',
  'sourceUserConcurrent',
  'sourceFreeBytes',
  'sourceFreePercent',
  'downloadOrigins',
] as const;
export type ContentPolicyKey = (typeof contentPolicyKeys)[number];
export const contentPolicyConfigKeys = {
  sourceGlobalBytes: 'contentSourceGlobalBytes',
  sourceUserBytes: 'contentSourceUserBytes',
  sourceConcurrent: 'contentSourceConcurrent',
  sourceUserConcurrent: 'contentSourceUserConcurrent',
  sourceFreeBytes: 'contentSourceFreeBytes',
  sourceFreePercent: 'contentSourceFreePercent',
  downloadOrigins: 'contentDownloadOrigins',
} as const;

/** Historical DB/env names remain readable. Public settings expose only the
 * canonical names; aliases are normalized before merging patches. No paths move. */
export const legacyContentConfigKeys = {
  minecraftMetadataUserAgent: 'contentMetadataUserAgent',
  minecraftSourceRoot: 'contentSourceRoot',
  minecraftContentRoot: 'contentWorkRoot',
  minecraftSourceGlobalBytes: 'contentSourceGlobalBytes',
  minecraftSourceUserBytes: 'contentSourceUserBytes',
  minecraftSourceConcurrent: 'contentSourceConcurrent',
  minecraftSourceUserConcurrent: 'contentSourceUserConcurrent',
  minecraftSourceFreeBytes: 'contentSourceFreeBytes',
  minecraftSourceFreePercent: 'contentSourceFreePercent',
  minecraftDownloadOrigins: 'contentDownloadOrigins',
} as const;
export const legacyContentEnvironmentKeys = {
  contentMetadataUserAgent: 'NH_MINECRAFT_METADATA_USER_AGENT',
  contentSourceRoot: 'NH_MINECRAFT_SOURCE_ROOT',
  contentWorkRoot: 'NH_MINECRAFT_CONTENT_ROOT',
  contentSourceGlobalBytes: 'NH_MINECRAFT_SOURCE_GLOBAL_BYTES',
  contentSourceUserBytes: 'NH_MINECRAFT_SOURCE_USER_BYTES',
  contentSourceConcurrent: 'NH_MINECRAFT_SOURCE_CONCURRENT',
  contentSourceUserConcurrent: 'NH_MINECRAFT_SOURCE_USER_CONCURRENT',
  contentSourceFreeBytes: 'NH_MINECRAFT_SOURCE_FREE_BYTES',
  contentSourceFreePercent: 'NH_MINECRAFT_SOURCE_FREE_PERCENT',
  contentDownloadOrigins: 'NH_MINECRAFT_DOWNLOAD_ORIGINS',
} as const;
export function normalizeLegacyContentSettings(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const normalized = { ...input } as Record<string, unknown>;
  for (const [legacy, canonical] of Object.entries(legacyContentConfigKeys)) {
    if (Object.hasOwn(normalized, legacy)) {
      if (!Object.hasOwn(normalized, canonical)) normalized[canonical] = normalized[legacy];
      delete normalized[legacy];
    }
  }
  return normalized;
}

/** Overrides are scoped caps, never a multiplication of global capacity. Local
 * origins can only narrow platform trust; physical disk floors can only rise. */
export function contentPolicyValues(config: PlatformConfig, gameId: string) {
  const local = config.gameContentPolicies[gameId] ?? {};
  const ceiling = (key: Exclude<ContentPolicyKey, 'downloadOrigins'>) => {
    const global = config[contentPolicyConfigKeys[key]];
    const override = local[key];
    return override === undefined
      ? global
      : key === 'sourceFreeBytes' || key === 'sourceFreePercent'
        ? Math.max(global, override)
        : Math.min(global, override);
  };
  return {
    sourceGlobalBytes: ceiling('sourceGlobalBytes'),
    sourceUserBytes: ceiling('sourceUserBytes'),
    sourceConcurrent: ceiling('sourceConcurrent'),
    sourceUserConcurrent: ceiling('sourceUserConcurrent'),
    sourceFreeBytes: ceiling('sourceFreeBytes'),
    sourceFreePercent: ceiling('sourceFreePercent'),
    downloadOrigins:
      local.downloadOrigins === undefined
        ? config.contentDownloadOrigins
        : local.downloadOrigins.filter((origin) => config.contentDownloadOrigins.includes(origin)),
  };
}
export function resolveContentPolicy(settings: ResolvedConfig, gameId: string) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(gameId)) throw new DomainError('validation_failed');
  const local = settings.values.gameContentPolicies[gameId] ?? {};
  const values = contentPolicyValues(settings.values, gameId);
  const locked = settings.lockedKeys.includes('gameContentPolicies');
  return {
    gameId,
    values,
    overrides: local,
    locked,
    fields: Object.fromEntries(
      contentPolicyKeys.map((key) => {
        const globalKey = contentPolicyConfigKeys[key];
        return [
          key,
          {
            value: values[key],
            global: settings.values[globalKey],
            override: local[key] ?? null,
            inherited: local[key] === undefined,
            locked,
            source:
              local[key] === undefined
                ? settings.sources[globalKey]
                : settings.sources.gameContentPolicies,
            globalLocked: settings.lockedKeys.includes(globalKey),
          },
        ];
      }),
    ),
  };
}
