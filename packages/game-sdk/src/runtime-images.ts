import { DomainError } from '@nickhosting/core';
import { z } from 'zod';

const image = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/);
const version = z.string().min(1).max(128);
const rule = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    image,
    versions: z
      .object({ min: version.optional(), max: version.optional() })
      .strict()
      .refine((value) => value.min !== undefined || value.max !== undefined)
      .optional(),
    requirements: z
      .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/), z.string().min(1).max(128))
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.versions !== undefined || Object.keys(value.requirements ?? {}).length > 0,
  );

/** Declarations belong to trusted integrations, not arbitrary executable Owner rules. */
export const runtimeImagePolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), image }).strict(),
  z
    .object({ mode: z.literal('rules'), rules: z.array(rule).min(1).max(128) })
    .strict()
    .refine((value) => new Set(value.rules.map((entry) => entry.id)).size === value.rules.length),
]);
export type RuntimeImagePolicy = z.infer<typeof runtimeImagePolicySchema>;
export interface RuntimeImageContext {
  gameVersion: string;
  /** Values resolved by trusted game metadata code, never accepted as client assertions. */
  requirements: Readonly<Record<string, string>>;
  /** Integration-defined ordering; undefined means this version cannot be compared. */
  compareVersions?: (left: string, right: string) => number | undefined;
}

/** Inclusive bounds, conjunctive requirements, exactly one match. Never guess a fallback. */
export function resolveRuntimeImage(
  policy: RuntimeImagePolicy,
  context: RuntimeImageContext,
): { image: string; ruleId?: string } {
  const parsed = runtimeImagePolicySchema.safeParse(policy);
  if (!parsed.success || !version.safeParse(context.gameVersion).success)
    throw new DomainError('configuration_invalid');
  if (parsed.data.mode === 'fixed') return { image: parsed.data.image };
  const compare = (left: string, right: string) => {
    const result = context.compareVersions?.(left, right);
    if (typeof result !== 'number' || !Number.isFinite(result))
      throw new DomainError('configuration_invalid');
    return result;
  };
  const matching = parsed.data.rules.filter((entry) => {
    if (entry.versions) {
      const { min, max } = entry.versions;
      if (min && max && compare(min, max) > 0) throw new DomainError('configuration_invalid');
      if (min && compare(context.gameVersion, min) < 0) return false;
      if (max && compare(context.gameVersion, max) > 0) return false;
    }
    return Object.entries(entry.requirements ?? {}).every(
      ([key, value]) =>
        Object.hasOwn(context.requirements, key) && context.requirements[key] === value,
    );
  });
  const selected = matching[0];
  if (matching.length !== 1 || !selected) throw new DomainError('configuration_invalid');
  return { image: selected.image, ruleId: selected.id };
}
