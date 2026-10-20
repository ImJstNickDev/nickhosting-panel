import { z } from 'zod';
import { modCatalogVersionSchema } from '../../../packages/content-providers/src/mod-catalog.js';

export const minecraftModProviderSchema = z.enum(['modrinth', 'curseforge']);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const minecraftModSelectionSchema = z.strictObject({
  roots: z
    .array(
      z.strictObject({
        provider: minecraftModProviderSchema,
        projectId: identifier,
        versionId: identifier.optional(),
        forceIncompatible: z.boolean().default(false),
        optionalProjectIds: z.array(identifier).max(512).default([]),
      }),
    )
    .max(512),
  preferBeta: z.boolean().default(false),
  idempotencyKey: identifier,
});
export const minecraftModApplySchema = z.strictObject({
  idempotencyKey: identifier,
  revision: z.number().int().nonnegative(),
});
export const minecraftModInstalledChangeSchema = z.strictObject({
  path: z.string().regex(/^mods\/[^/\\\p{C}]+\.jar(?:\.disabled)?$/u),
  action: z.enum(['enable', 'disable', 'delete']),
  idempotencyKey: identifier,
});
export const minecraftModToggleSchema = minecraftModInstalledChangeSchema
  .extend({ action: z.enum(['enable', 'disable']) })
  .refine((value) => value.path.endsWith('.disabled') === (value.action === 'enable'), {
    path: ['path'],
    message: 'The mod state must match the requested action',
  });
export const minecraftModToggleResultSchema = z.object({
  state: z.enum(['published', 'dispatched', 'uncertain']),
  path: minecraftModInstalledChangeSchema.shape.path,
  restartRequired: z.boolean(),
});
export type MinecraftModSelection = z.infer<typeof minecraftModSelectionSchema>;
export type MinecraftModRoot = MinecraftModSelection['roots'][number];
export type MinecraftModSide = 'server' | 'client' | 'both' | 'unknown';
export const minecraftModBlockerSchema = z.object({
  projectId: identifier,
  name: z.string(),
  reason: z.string(),
  provider: minecraftModProviderSchema.optional(),
  versionId: identifier.optional(),
  requiredBy: identifier.optional(),
  requiredByName: z.string().optional(),
  roots: z.array(z.object({ projectId: identifier, name: z.string() })).optional(),
  availableMinecraftVersions: z.array(z.string()).max(20).optional(),
  availableLoaders: z.array(z.string()).max(20).optional(),
  availableChannels: z
    .array(z.enum(['release', 'beta', 'alpha']))
    .max(3)
    .optional(),
});
export const minecraftModUpdatesSchema = z.object({
  checkedAt: z.iso.datetime(),
  limited: z.boolean().optional(),
  items: z.array(
    z.object({
      path: z.string(),
      provider: minecraftModProviderSchema,
      projectId: identifier,
      currentVersionId: identifier,
      status: z.enum(['update', 'current', 'limited', 'unavailable']),
      version: modCatalogVersionSchema.optional(),
    }),
  ),
});
export type MinecraftModUpdates = z.infer<typeof minecraftModUpdatesSchema>;
export const minecraftModAlternativesSchema = z.object({
  revision: z.number().int().nonnegative(),
  provider: minecraftModProviderSchema,
  projectId: identifier,
  items: z.array(modCatalogVersionSchema).max(1),
  checked: z.number().int().nonnegative(),
  limited: z.boolean(),
});
export type MinecraftModAlternatives = z.infer<typeof minecraftModAlternativesSchema>;
export interface MinecraftModAlias {
  provider: 'modrinth' | 'curseforge';
  projectId: string;
  versionId?: string;
}
export interface MinecraftModTag {
  id: string;
  label: string;
  source?: 'modrinth' | 'curseforge';
  original?: string;
}
export interface MinecraftModMetadata {
  provider: 'modrinth' | 'curseforge';
  projectId: string;
  versionId: string;
  name: string;
  version: string;
  channel: 'release' | 'beta' | 'alpha';
  iconUrl?: string;
  side: MinecraftModSide;
  environment?: { kind: MinecraftModSide; detail?: string; source: string; original: string[] };
  tags: MinecraftModTag[];
  minecraftVersions: string[];
  loaders: string[];
}
export interface MinecraftModQueueItem {
  id: string;
  action: 'install' | 'enable' | 'disable' | 'delete';
  name: string;
  path: string;
  size: number;
  metadata: MinecraftModMetadata | null;
  aliases?: MinecraftModAlias[];
  dependency: boolean;
  requiredBy: string[];
  forceIncompatible: boolean;
  incompatibilities: ('minecraft' | 'loader' | 'client-only')[];
  state: 'queued' | 'preparing' | 'ready' | 'failed' | 'uncertain';
  error?: string;
  immediate?: boolean;
}
export interface MinecraftModsSnapshot {
  supported: boolean;
  installed: boolean;
  running: boolean;
  version: string;
  loader: string;
  revision: number;
  preferBeta: boolean;
  roots: MinecraftModRoot[];
  preparing: boolean;
  error?: string;
  packs: {
    id: string;
    path: string;
    name: string;
    size: number;
    state: 'enabled' | 'disabled';
    metadata: MinecraftModMetadata | null;
    aliases?: MinecraftModAlias[];
  }[];
  changes: MinecraftModQueueItem[];
  blockers: z.infer<typeof minecraftModBlockerSchema>[];
  optional: {
    provider: 'modrinth' | 'curseforge';
    projectId: string;
    name: string;
    requiredBy: string[];
  }[];
  restart: { required: boolean; changedAt?: string };
}
