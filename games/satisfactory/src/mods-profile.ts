import { z } from 'zod';
import {
  type SatisfactoryModLock,
  type SatisfactoryModSelection,
  satisfactoryModLockSchema,
  satisfactoryModReferenceSchema,
  satisfactoryModSelectionSchema,
  satisfactoryModTargetsSchema,
  satisfactoryModVersionSchema,
} from './mods.js';

export const satisfactoryModProfileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (name) =>
      ![...name].some(
        (char) =>
          char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\',
      ),
  );
export const satisfactoryModProfileSchema = z.strictObject({
  name: satisfactoryModProfileNameSchema,
  selection: satisfactoryModSelectionSchema,
  requiredTargets: satisfactoryModTargetsSchema.default(['LinuxServer']),
  vanilla: z.boolean().default(false),
});

// This is SMM3's JSON .smmprofile, not the retired SMM2 ZIP format.
const nativeProfileSchema = z.object({
  profile: z.object({
    name: satisfactoryModProfileNameSchema,
    mods: z
      .record(
        satisfactoryModReferenceSchema,
        z.object({
          version: satisfactoryModVersionSchema,
          enabled: z.boolean(),
        }),
      )
      .refine((mods) => Object.keys(mods).length <= 256),
    required_targets: z
      .array(z.enum(['Windows', 'WindowsServer', 'LinuxServer']))
      .max(3)
      .nullish(),
  }),
  lockfile: satisfactoryModLockSchema.nullish(),
  metadata: z
    .object({ gameVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
    .nullish(),
});

/** Imported download URLs/hashes are untrusted. Preserve intent only and resolve
 * every imported profile through SMR before preview/apply; never seed the CLI
 * from an imported lock, even when the advertised URL happens to look official.
 */
export function importSatisfactoryProfile(input: unknown) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > 2_097_152) throw new Error('satisfactory_profile_too_large');
    input = JSON.parse(input);
  }
  const parsed = nativeProfileSchema.parse(input);
  const selection = satisfactoryModSelectionSchema.parse(
    Object.entries(parsed.profile.mods).map(([reference, mod]) => ({ reference, ...mod })),
  );
  return {
    name: parsed.profile.name,
    selection,
    requiredTargets: satisfactoryModTargetsSchema.parse(
      parsed.profile.required_targets?.length
        ? [...new Set(parsed.profile.required_targets)]
        : ['LinuxServer'],
    ),
    gameVersion: parsed.metadata?.gameVersion ?? null,
  };
}

/** Export a profile and its trusted resolved lock in SMM's native format. A
 * Linux-only export does not claim that the same mods have Windows packages.
 */
export function exportSatisfactoryProfile(input: {
  name: string;
  selection: SatisfactoryModSelection;
  requiredTargets?: z.infer<typeof satisfactoryModTargetsSchema>;
  gameVersion: number;
  lock: SatisfactoryModLock;
}) {
  const name = satisfactoryModProfileNameSchema.parse(input.name);
  const selection = satisfactoryModSelectionSchema.parse(input.selection);
  const requiredTargets = satisfactoryModTargetsSchema.parse(
    input.requiredTargets ?? ['LinuxServer'],
  );
  const gameVersion = z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(input.gameVersion);
  const lockfile = satisfactoryModLockSchema.parse(input.lock);
  return {
    profile: {
      name,
      mods: Object.fromEntries(
        selection.map(({ reference, version, enabled }) => [
          reference,
          {
            version,
            enabled: enabled !== false,
          },
        ]),
      ),
      required_targets: requiredTargets,
    },
    lockfile,
    metadata: { gameVersion },
  };
}
