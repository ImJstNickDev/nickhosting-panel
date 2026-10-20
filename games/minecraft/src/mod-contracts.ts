import { z } from 'zod';

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
export type MinecraftModSelection = z.infer<typeof minecraftModSelectionSchema>;
export type MinecraftModRoot = MinecraftModSelection['roots'][number];
export type MinecraftModSide = 'server' | 'client' | 'both' | 'unknown';
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
  blockers: { projectId: string; name: string; reason: string }[];
  optional: {
    provider: 'modrinth' | 'curseforge';
    projectId: string;
    name: string;
    requiredBy: string[];
  }[];
  restart: { required: boolean; changedAt?: string };
}
