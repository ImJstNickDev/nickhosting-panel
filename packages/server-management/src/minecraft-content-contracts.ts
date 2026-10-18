import type { ContentPlan } from '@nickhosting/content-providers';
import { z } from 'zod';

const properties = z.record(
  z.string().min(1).max(80),
  z.union([z.string().max(256), z.number().finite(), z.boolean()]),
);
const playerName = z.string().regex(/^[A-Za-z0-9_]{3,16}$/);
const modpackChoice = z
  .object({
    provider: z.literal('modrinth'),
    projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    versionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  })
  .strict();
export const minecraftConfigurationSchema = z
  .object({
    eula: z.literal(true),
    properties: properties.default({}),
    operators: z.array(playerName).max(1000).default([]),
    whitelist: z.array(playerName).max(1000).default([]),
    modpack: z.union([modpackChoice, z.object({ sourceId: z.uuid() }).strict()]).optional(),
  })
  .strict();
export const minecraftStoredPlayerSchema = z
  .object({
    uuid: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    name: playerName,
    // Server-file provenance preserves observed UUID authority without claiming Mojang verification.
    source: z.enum(['mojang', 'server-file']),
    verifiedAt: z.iso.datetime({ offset: true }),
    level: z.number().int().min(1).max(4).optional(),
    bypassesPlayerLimit: z.boolean().optional(),
  })
  .strict();
/** Internal persistence only. The public creation schema deliberately excludes these attestations. */
export const minecraftStoredConfigurationSchema = minecraftConfigurationSchema
  .extend({
    operators: z.array(playerName).max(100000).default([]),
    whitelist: z.array(playerName).max(100000).default([]),
    playerIdentities: z
      .object({
        operators: z.array(minecraftStoredPlayerSchema).max(100000),
        whitelist: z.array(minecraftStoredPlayerSchema).max(100000),
      })
      .strict()
      .optional(),
  })
  .refine(
    (configuration) =>
      configuration.playerIdentities?.operators.every(
        (player) => player.level !== undefined && player.bypassesPlayerLimit !== undefined,
      ) ?? true,
  );
const replacement = z
  .object({
    wipeConsent: z.literal(true),
    expectedDeletePaths: z.array(z.string()).min(1).max(1000),
    backupBefore: z.boolean(),
  })
  .strict();
// A selected empty pack may legitimately have no content/world paths to wipe.
const modpackReplacement = replacement.extend({
  expectedDeletePaths: z.array(z.string()).max(1000),
});
const sourceId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const minecraftContentCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('verify') }).strict(),
  z
    .object({
      kind: z.literal('world-import'),
      archiveRef: z.uuid(),
      targetWorld: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
      replace: replacement.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('world-select'),
      world: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('world-remove'),
      world: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
      confirm: z.literal(true),
      backupBefore: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('properties'), changes: properties }).strict(),
  z
    .object({
      kind: z.literal('player'),
      list: z.enum(['operators', 'whitelist']),
      action: z.enum(['add', 'remove']),
      name: playerName,
      expectedUuid: minecraftStoredPlayerSchema.shape.uuid.optional(),
      operatorLevel: z.number().int().min(1).max(4).optional(),
      bypassesPlayerLimit: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('install'),
      provider: z.enum(['modrinth', 'curseforge']),
      projectId: sourceId,
      versionId: sourceId,
    })
    .strict(),
  z
    .object({
      kind: z.literal('remove'),
      provider: z.enum(['modrinth', 'curseforge']),
      projectId: sourceId,
    })
    .strict(),
  z
    .object({
      kind: z.literal('modpack'),
      provider: z.literal('modrinth'),
      projectId: sourceId,
      versionId: sourceId,
      replace: modpackReplacement.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('modpack-upload'),
      archiveRef: z.uuid(),
      replace: modpackReplacement.optional(),
    })
    .strict(),
]);
export type MinecraftContentCommand = z.infer<typeof minecraftContentCommandSchema>;
export interface MinecraftPreparedContent {
  combinationId: string;
  command: MinecraftContentCommand;
  backupBefore: boolean;
  /** Exact persisted pack selection approved during preparation; null means none. */
  previousModpack?: Exclude<
    z.infer<typeof minecraftConfigurationSchema>['modpack'],
    undefined
  > | null;
  contentPlan?: ContentPlan;
  archivePath?: string;
  archiveRef?: string;
  archiveSha256?: string;
  planDigest?: string;
  deletePaths?: string[];
  /** Target runtime data version, when known; imported metadata is observed separately. */
  world?: { archiveSha256?: string; dataVersion?: number; existing: boolean };
}

/** Removing an inactive world is a file operation, independent of process state.
 * Its current selected-world/path checks run at dispatch, under the server lock.
 * A requested whole-server backup retains the existing stopped-state workflow. */
export function minecraftContentRemovesInactiveWorld(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const plan = input as Partial<MinecraftPreparedContent>;
  const command = minecraftContentCommandSchema.safeParse(plan.command);
  return (
    command.success &&
    command.data.kind === 'world-remove' &&
    command.data.backupBefore === false &&
    plan.backupBefore === false &&
    plan.world?.existing === true
  );
}

/** Derived from a trusted prepared plan, never a client-controlled online flag. */
export function minecraftContentAllowsOnline(input: unknown): boolean {
  if (minecraftContentRemovesInactiveWorld(input)) return true;
  if (!input || typeof input !== 'object') return false;
  const plan = input as Partial<MinecraftPreparedContent>;
  const command = minecraftContentCommandSchema.safeParse(plan.command);
  return (
    command.success &&
    command.data.kind === 'world-import' &&
    command.data.replace === undefined &&
    plan.world?.existing === false &&
    plan.backupBefore === false &&
    Array.isArray(plan.deletePaths) &&
    plan.deletePaths.length === 0
  );
}
