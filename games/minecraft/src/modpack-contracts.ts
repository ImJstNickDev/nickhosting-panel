import { z } from 'zod';
import {
  modpackCatalogProjectSchema,
  modpackCatalogVersionSchema,
  modpackProviderSchema,
  modpackTargetSchema,
} from '../../../packages/content-providers/src/modpack-catalog.js';

const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const identity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^/\\\p{C}]+$/u);
export const minecraftModpackPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !/[\\\p{C}:]/u.test(path) &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  );
export const minecraftModpackPrepareSchema = z
  .object({
    provider: modpackProviderSchema,
    projectId: identity,
    versionId: identity,
    mode: z.enum(['install', 'update', 'replace']),
    worldPolicy: z.enum(['preserve', 'reset']).default('preserve'),
    fileDecisions: z
      .record(minecraftModpackPathSchema, z.enum(['keep-local', 'use-pack']))
      .default({}),
    install: z.strictObject({ backupBefore: z.boolean().default(false) }).optional(),
    idempotencyKey: key,
  })
  .strict()
  .refine(
    (value) =>
      value.mode === 'replace' || value.worldPolicy === 'preserve' || Boolean(value.install),
    {
      path: ['worldPolicy'],
      message: 'World reset requires explicit replacement or an Install intent',
    },
  );
export type MinecraftModpackSelection = z.infer<typeof minecraftModpackPrepareSchema>;
export const minecraftModpackApplySchema = z
  .object({
    operationId: z.uuid(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/),
    confirm: z.literal(true),
    backupBefore: z.boolean().default(true),
    expectedDeletePaths: z.array(minecraftModpackPathSchema).max(20000).default([]),
    idempotencyKey: key,
  })
  .strict();
export type MinecraftModpackApply = z.infer<typeof minecraftModpackApplySchema>;
export const minecraftModpackStateSchema = z.enum([
  'queued',
  'preparing',
  'ready',
  'blocked',
  'apply_queued',
  'applying',
  'applied',
  'failed',
  'uncertain',
  'cancelled',
]);
export type MinecraftModpackState = z.infer<typeof minecraftModpackStateSchema>;
export const minecraftModpackPhaseSchema = z.enum([
  'queued',
  'resolving',
  'downloading',
  'inspecting',
  'ready',
  'checking',
  'stopping',
  'backup',
  'runtime',
  'publishing',
  'verifying',
  'restoring',
  'complete',
]);
export type MinecraftModpackPhase = z.infer<typeof minecraftModpackPhaseSchema>;
export const minecraftModpackBlockerSchema = z
  .object({
    reason: z.enum([
      'runtime',
      'loader-version',
      'unresolved',
      'server-pack',
      'distribution',
      'permission',
      'client-only',
      'conflict',
      'installed-pack',
      'modified-file',
      'protected-path',
      'publication-limit',
    ]),
    path: minecraftModpackPathSchema.optional(),
  })
  .strict();
export type MinecraftModpackBlocker = z.infer<typeof minecraftModpackBlockerSchema>;
export const minecraftModpackPackSchema = z
  .object({
    project: modpackCatalogProjectSchema,
    version: modpackCatalogVersionSchema,
  })
  .strict();
export type MinecraftModpackPack = z.infer<typeof minecraftModpackPackSchema>;
export const minecraftModpackProgressSchema = z
  .object({
    completedFiles: z.number().int().nonnegative(),
    totalFiles: z.number().int().nonnegative(),
    completedBytes: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().nonnegative().safe().nullable(),
  })
  .strict();
export type MinecraftModpackProgress = z.infer<typeof minecraftModpackProgressSchema>;
export const minecraftModpackOperationSchema = z
  .object({
    id: z.uuid(),
    selection: minecraftModpackPrepareSchema,
    state: minecraftModpackStateSchema,
    canCancel: z.boolean().optional(),
    cancellationEffect: z.literal('runtime-retained').optional(),
    phase: minecraftModpackPhaseSchema,
    progress: minecraftModpackProgressSchema.nullable(),
    pack: minecraftModpackPackSchema.nullable(),
    target: modpackTargetSchema.nullable(),
    runtimeSupported: z.boolean(),
    planDigest: z.string().nullable(),
    changes: z
      .object({
        write: z.number().int().nonnegative(),
        remove: z.number().int().nonnegative(),
        preserve: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative().safe(),
      })
      .nullable(),
    deletePaths: z.array(minecraftModpackPathSchema).max(20000),
    blockers: z.array(minecraftModpackBlockerSchema).max(20000),
    error: z.string().nullable(),
    backupId: z.string().nullable(),
    restartRequired: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type MinecraftModpackOperation = z.infer<typeof minecraftModpackOperationSchema>;
export const minecraftModpacksSnapshotSchema = z
  .object({
    installed: z
      .object({
        pack: minecraftModpackPackSchema,
        target: modpackTargetSchema,
        installedAt: z.iso.datetime(),
        operationId: z.uuid(),
      })
      .nullable(),
    operation: minecraftModpackOperationSchema.nullable(),
  })
  .strict();
export type MinecraftModpacksSnapshot = z.infer<typeof minecraftModpacksSnapshotSchema>;
