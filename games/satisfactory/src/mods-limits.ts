import { z } from 'zod';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
export const satisfactoryModWorkingHeadroomBytes = 64 * MiB;
const bytes = z
  .number()
  .int()
  .positive()
  .max(16 * GiB);
export const satisfactoryModLimitsSchema = z
  .strictObject({
    outputBytes: bytes,
    archiveBytes: bytes.min(MiB),
    metadataBytes: z
      .number()
      .int()
      .min(MiB)
      .max(256 * MiB),
    maxFiles: z.number().int().min(1).max(1_000_000),
    workingBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (limits) =>
      limits.workingBytes ===
      limits.outputBytes +
        limits.archiveBytes +
        limits.metadataBytes +
        satisfactoryModWorkingHeadroomBytes,
  );
export type SatisfactoryModLimits = z.infer<typeof satisfactoryModLimitsSchema>;

/** One budget drives native preparation and the existing staging reservation.
 * Global/per-owner admission still caps this configured per-operation maximum. */
export function resolveSatisfactoryModLimits(
  env: Readonly<Record<string, string | undefined>> = {},
  options: { outputBytesCap?: number } = {},
): SatisfactoryModLimits {
  const integer = (key: string, fallback: number) => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('satisfactory_mod_limits_invalid');
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error('satisfactory_mod_limits_invalid');
    return value;
  };
  const configuredOutput = bytes.parse(integer('NH_SATISFACTORY_MOD_MAX_BYTES', 2 * GiB));
  const outputBytes =
    options.outputBytesCap === undefined
      ? configuredOutput
      : Math.min(
          configuredOutput,
          z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(options.outputBytesCap),
        );
  const archiveBytes = integer('NH_SATISFACTORY_MOD_ARCHIVE_BYTES', GiB);
  const metadataBytes = integer('NH_SATISFACTORY_MOD_METADATA_BYTES', 64 * MiB);
  return satisfactoryModLimitsSchema.parse({
    outputBytes,
    archiveBytes,
    metadataBytes,
    maxFiles: integer('NH_SATISFACTORY_MOD_MAX_FILES', 100_000),
    workingBytes: outputBytes + archiveBytes + metadataBytes + satisfactoryModWorkingHeadroomBytes,
  });
}

export const satisfactoryModDefaultLimits = Object.freeze(resolveSatisfactoryModLimits());
