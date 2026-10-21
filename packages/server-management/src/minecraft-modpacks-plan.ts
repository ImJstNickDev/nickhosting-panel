import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import {
  type MinecraftModpackBlocker,
  type MinecraftModpackSelection,
  minecraftModpackBlockerSchema,
  minecraftModpackPackSchema,
  minecraftModpackPathSchema,
} from '../../../games/minecraft/src/modpack-contracts.js';
import { modpackTargetSchema } from '../../content-providers/src/modpack-catalog.js';

export const modpackFileSchema = z
  .object({
    path: minecraftModpackPathSchema,
    size: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    modifiedAt: z.string().optional(),
  })
  .strict();
export type MinecraftModpackFile = z.infer<typeof modpackFileSchema>;
export const preparedModpackSchema = z
  .object({
    pack: minecraftModpackPackSchema,
    target: modpackTargetSchema,
    /** Private local staging identifier, never included in a browser response. */
    stagingKey: z.string().min(1).max(4096),
    files: z.array(modpackFileSchema).max(20000),
    propertiesMerged: z.literal(true).optional(),
    propertiesSource: z
      .object({ size: z.number().int().nonnegative().safe(), modifiedAt: z.string().min(1) })
      .strict()
      .nullable()
      .optional(),
    blockers: z.array(minecraftModpackBlockerSchema).max(20000).default([]),
  })
  .strict()
  .refine((value) => {
    const paths = new Set(value.files.map((file) => file.path));
    return (
      Number.isSafeInteger(value.files.reduce((sum, file) => sum + file.size, 0)) &&
      (value.propertiesMerged === true
        ? value.propertiesSource !== undefined
        : value.propertiesSource === undefined) &&
      paths.size === value.files.length &&
      [...paths].every((path) => !parents(path).some((parent) => paths.has(parent)))
    );
  });
export type PreparedMinecraftModpack = z.infer<typeof preparedModpackSchema>;
export const modpackReceiptSchema = z
  .object({
    pack: minecraftModpackPackSchema,
    target: modpackTargetSchema,
    files: z.array(modpackFileSchema).max(20000),
  })
  .strict();
export type MinecraftModpackReceipt = z.infer<typeof modpackReceiptSchema>;
export interface MinecraftModpackObservation {
  /** Only candidates and receipt-owned paths need inventory; use one Fileman batch scope. */
  entries: {
    path: string;
    kind: 'file' | 'directory' | 'symlink';
    size: number;
    modifiedAt?: string;
    sha256?: string;
  }[];
  worldRoots: string[];
  protectedPaths: string[];
  /** Reviewed content roots eligible for explicit replacement, excluding runtime/security files. */
  replacePaths: string[];
  combinationId: string;
  mappingId: string;
}
export const modpackRuntimeBindingSchema = z
  .object({
    combinationId: z.uuid(),
    mappingId: z.uuid(),
    target: modpackTargetSchema,
  })
  .strict();
export type MinecraftModpackRuntimeBinding = z.infer<typeof modpackRuntimeBindingSchema>;
const observedEntry = z
  .object({
    path: minecraftModpackPathSchema,
    kind: z.enum(['file', 'directory', 'symlink']),
    size: z.number().int().nonnegative().safe(),
    modifiedAt: z.string().optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const modpackPlanSchema = z
  .object({
    sourceCombinationId: z.uuid(),
    sourceMappingId: z.uuid(),
    previousOperationId: z.uuid().nullable(),
    runtime: modpackRuntimeBindingSchema.nullable(),
    write: z.array(modpackFileSchema).max(20000),
    remove: z.array(minecraftModpackPathSchema).max(20000),
    preserve: z.array(minecraftModpackPathSchema).max(20000),
    retained: z.array(modpackFileSchema).max(20000),
    expected: z
      .array(z.object({ path: minecraftModpackPathSchema, entry: observedEntry.nullable() }))
      .max(40000),
    worldRoots: z.array(minecraftModpackPathSchema).max(1000),
    protectedPaths: z.array(minecraftModpackPathSchema).max(20000),
    blockers: z.array(minecraftModpackBlockerSchema).max(20000),
    propertiesMerged: z.literal(true).optional(),
  })
  .strict();
export type MinecraftModpackPlan = z.infer<typeof modpackPlanSchema>;
export const modpackDigest = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, entry: unknown) =>
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? Object.fromEntries(
              Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)),
            )
          : entry,
      ),
    )
    .digest('hex');
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const overlaps = (left: string, right: string) => under(left, right) || under(right, left);
const unique = (values: string[]) => [...new Set(values)].sort();
const parents = (path: string) => {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'));
};
const alwaysProtected = [
  'server.properties',
  'eula.txt',
  'ops.json',
  'whitelist.json',
  'banned-players.json',
  'banned-ips.json',
  'usercache.json',
  '.nickhosting',
];
const configFile = (path: string) =>
  path === 'server.properties' || ['config', 'defaultconfigs'].some((root) => under(path, root));
const protectedDefaults = (merged?: true) =>
  alwaysProtected.filter((path) => path !== 'server.properties' || !merged);
function unchanged(
  file: MinecraftModpackFile,
  observed: MinecraftModpackObservation['entries'][number],
) {
  return (
    observed.kind === 'file' &&
    file.size === observed.size &&
    (observed.sha256
      ? file.sha256 === observed.sha256
      : Boolean(file.modifiedAt && observed.modifiedAt === file.modifiedAt))
  );
}
export function sameModpackTarget(
  left: z.infer<typeof modpackTargetSchema>,
  right: z.infer<typeof modpackTargetSchema>,
) {
  return (
    left.minecraftVersion === right.minecraftVersion &&
    left.loader === right.loader &&
    left.loaderVersion === right.loaderVersion
  );
}

/** Pure planning: provenance authorizes removal only while the recorded file remains unchanged. */
export function planMinecraftModpack(input: {
  selection: MinecraftModpackSelection;
  prepared: PreparedMinecraftModpack;
  observation: MinecraftModpackObservation;
  previous: { operationId: string; receipt: MinecraftModpackReceipt } | null;
  runtime: MinecraftModpackRuntimeBinding | null;
}): MinecraftModpackPlan {
  const { selection, prepared, observation, previous, runtime } = input;
  const files = new Map(
    observation.entries.map((entry) => [entry.path, observedEntry.parse(entry)]),
  );
  const owned = new Map(previous?.receipt.files.map((entry) => [entry.path, entry]) ?? []);
  const blockers: MinecraftModpackBlocker[] = [...prepared.blockers];
  const worldRoots = unique(
    observation.worldRoots.map((path) => minecraftModpackPathSchema.parse(path)),
  );
  const protectedPaths = unique([
    ...protectedDefaults(prepared.propertiesMerged),
    ...observation.protectedPaths,
  ]);
  if (selection.mode === 'install' && previous) blockers.push({ reason: 'installed-pack' });
  if (
    selection.mode === 'update' &&
    (!previous ||
      previous.receipt.pack.project.provider !== selection.provider ||
      previous.receipt.pack.project.id !== selection.projectId)
  )
    blockers.push({ reason: 'installed-pack' });
  if (!runtime || !sameModpackTarget(runtime.target, prepared.target))
    blockers.push({ reason: 'runtime' });
  if (
    ['fabric', 'forge', 'neoforge', 'quilt'].includes(prepared.target.loader) &&
    !prepared.target.loaderVersion
  )
    blockers.push({ reason: 'loader-version' });
  const write: MinecraftModpackFile[] = [];
  const remove: string[] = [];
  const preserve: string[] = [];
  const retained: MinecraftModpackFile[] = [];
  const guarded = (path: string) =>
    protectedPaths.some((root) => overlaps(path, root)) ||
    (selection.worldPolicy === 'preserve' && worldRoots.some((root) => overlaps(path, root)));
  const candidatePaths = new Set(prepared.files.map((file) => file.path));
  for (const file of prepared.files) {
    if (protectedPaths.some((root) => overlaps(file.path, root))) {
      // Pack-provided security/settings files never replace the managed server configuration.
      preserve.push(file.path);
      continue;
    }
    if (worldRoots.some((root) => overlaps(file.path, root))) {
      if (selection.worldPolicy === 'preserve') {
        preserve.push(file.path);
        continue;
      }
    }
    const current = files.get(file.path);
    if (file.path === 'server.properties' && prepared.propertiesMerged) {
      const source = prepared.propertiesSource;
      if (
        source === undefined ||
        (source === null
          ? current !== undefined
          : current?.kind !== 'file' ||
            current.size !== source.size ||
            current.modifiedAt !== source.modifiedAt)
      ) {
        blockers.push({ reason: 'conflict', path: file.path });
        continue;
      }
    }
    if (
      current?.kind === 'symlink' ||
      parents(file.path).some((path) => files.has(path) && files.get(path)?.kind !== 'directory')
    ) {
      blockers.push({ reason: 'protected-path', path: file.path });
      continue;
    }
    if (!current) {
      write.push(file);
      continue;
    }
    const old = owned.get(file.path);
    const clean = Boolean(old && unchanged(old, current));
    const decision = selection.fileDecisions[file.path];
    const initialProperties =
      file.path === 'server.properties' &&
      prepared.propertiesMerged === true &&
      selection.mode === 'install' &&
      previous === null;
    if (
      decision === 'keep-local' ||
      (!initialProperties && !clean && configFile(file.path) && decision !== 'use-pack')
    ) {
      preserve.push(file.path);
      if (old) retained.push(old);
      continue;
    }
    if (initialProperties || clean || decision === 'use-pack' || selection.mode === 'replace') {
      if (current.kind !== 'file') {
        blockers.push({ reason: 'conflict', path: file.path });
        continue;
      }
      if (clean && old?.sha256 === file.sha256) {
        preserve.push(file.path);
        retained.push(old);
      } else {
        write.push(file);
        remove.push(file.path);
      }
    } else blockers.push({ reason: old ? 'modified-file' : 'conflict', path: file.path });
  }
  for (const old of owned.values()) {
    if (candidatePaths.has(old.path)) continue;
    const current = files.get(old.path);
    if (!current) continue;
    if (guarded(old.path) || !unchanged(old, current)) {
      preserve.push(old.path);
      // Keep the original fingerprint: local edits must not acquire new pack provenance.
      retained.push(old);
    } else remove.push(old.path);
  }
  if (selection.mode === 'replace') {
    for (const root of observation.replacePaths) {
      minecraftModpackPathSchema.parse(root);
      if (guarded(root)) {
        blockers.push({ reason: 'protected-path', path: root });
        continue;
      }
      // A root containing a locally retained configuration cannot be removed as a whole.
      if (preserve.some((path) => under(path, root))) {
        for (const entry of files.values()) {
          if (entry.kind === 'file' && under(entry.path, root) && !preserve.includes(entry.path))
            remove.push(entry.path);
        }
      } else if (files.has(root)) remove.push(root);
    }
    if (selection.worldPolicy === 'reset')
      for (const root of worldRoots) {
        if (protectedPaths.some((path) => overlaps(root, path)))
          blockers.push({ reason: 'protected-path', path: root });
        else if (files.has(root)) remove.push(root);
      }
  }
  const removals = unique(remove).filter(
    (path, _index, values) => !values.some((parent) => parent !== path && under(path, parent)),
  );
  const touched = unique([...write.map((file) => file.path), ...removals]);
  if (write.length > 10000) blockers.push({ reason: 'publication-limit' });
  const watched = unique([
    ...touched,
    ...touched.flatMap(parents),
    ...[...files.keys()].filter((path) => removals.some((root) => under(path, root))),
  ]);
  return modpackPlanSchema.parse({
    sourceCombinationId: observation.combinationId,
    sourceMappingId: observation.mappingId,
    previousOperationId: previous?.operationId ?? null,
    runtime,
    write,
    remove: removals,
    preserve: unique(preserve),
    retained,
    expected: watched.map((path) => ({ path, entry: files.get(path) ?? null })),
    worldRoots,
    protectedPaths,
    ...(prepared.propertiesMerged ? { propertiesMerged: true as const } : {}),
    blockers,
  });
}

/** Protection covers whole subtrees. Runtime attestation may add a descendant
 * already covered by a protected root without changing that protection. Keep
 * persisted plans untouched and reject unsafe paths before comparing coverage. */
const protectedRoots = (paths: string[]) => {
  const normalized = unique(paths.map((path) => minecraftModpackPathSchema.parse(path)));
  const roots = new Set(normalized);
  return normalized.filter((path) => !parents(path).some((parent) => roots.has(parent)));
};

/** Revalidation uses one new scoped inventory, never downloads or hashes provider artifacts again. */
export function assertMinecraftModpackPlanCurrent(
  plan: MinecraftModpackPlan,
  observation: MinecraftModpackObservation,
) {
  if (
    observation.combinationId !== plan.sourceCombinationId ||
    observation.mappingId !== plan.sourceMappingId ||
    modpackDigest(unique(observation.worldRoots)) !== modpackDigest(plan.worldRoots) ||
    modpackDigest(
      protectedRoots([...protectedDefaults(plan.propertiesMerged), ...observation.protectedPaths]),
    ) !== modpackDigest(protectedRoots(plan.protectedPaths))
  )
    throw new DomainError('conflict');
  const entries = new Map(observation.entries.map((entry) => [entry.path, entry]));
  const expectedPaths = new Set(plan.expected.map((entry) => entry.path));
  if (
    observation.entries.some(
      (entry) =>
        plan.remove.some((root) => under(entry.path, root)) && !expectedPaths.has(entry.path),
    )
  )
    throw new DomainError('conflict');
  for (const { path, entry } of plan.expected) {
    const current = entries.get(path);
    if (
      !entry
        ? current !== undefined
        : !current ||
          current.kind !== entry.kind ||
          current.size !== entry.size ||
          (entry.sha256 ? current.sha256 !== entry.sha256 : current.modifiedAt !== entry.modifiedAt)
    )
      throw new DomainError('conflict');
  }
}
