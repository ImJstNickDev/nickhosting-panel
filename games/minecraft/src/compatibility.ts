import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';

export const minecraftProfiles = ['vanilla', 'paper', 'folia', 'fabric', 'forge'] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/);
export const minecraftCombinationSchema = z
  .object({
    release: identifier,
    releaseType: z.enum(['release', 'snapshot', 'old_alpha', 'old_beta']),
    protocolId: z.number().int().nonnegative().max(2147483647).nullable(),
    family: z.enum(['netty', 'legacy', 'unknown']),
    transfer: z.boolean().optional(),
    profile: z.enum(minecraftProfiles),
    buildId: identifier.optional(),
    loaderVersion: identifier.optional(),
    installerVersion: identifier.optional(),
    javaMajor: z.number().int().min(8).max(99),
    runtimeDigest: digest,
    protocolSource: z.object({ url: z.string().url(), sha256: digest }).strict(),
  })
  .strict();
export type MinecraftCombination = z.infer<typeof minecraftCombinationSchema>;

export const minecraftVerificationChecks = [
  'installation',
  'status',
  'intentionalJoin',
  'sleepingResponse',
  'wakingResponse',
  'blockedResponse',
  'manualStop',
  'transparentLogin',
  'readiness',
  'playerIdle',
  'wakeAdmission',
  'gracefulSave',
] as const;
export const minecraftEvidenceSchema = z
  .object({
    runId: z.uuid(),
    kind: z.enum(['protocol-fixture', 'installation-bootstrap', 'real-server']),
    combinationDigest: digest,
    choiceDigest: digest,
    mappingDigest: digest,
    recordedAt: z.iso.datetime({ offset: true }),
    server: z
      .object({
        uuid: z.uuid(),
        externalId: z.string().min(1).max(255),
        artifactSha256: digest,
        imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        javaMajor: z.number().int().min(8).max(99),
        installedFiles: z
          .array(
            z
              .object({
                path: z.string().min(1).max(1024),
                sha256: digest,
                size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
                // Signed exception only for Fabric's installer-generated launch JAR.
                // Its raw receipt remains recorded, while ZIP timestamps may differ.
                role: z.literal('fabric-launcher').optional(),
                jarEntriesSha256: digest.optional(),
                minecraftServerPath: z
                  .string()
                  .min(1)
                  .max(1024)
                  .regex(/^[A-Za-z0-9_./-]+$/)
                  .optional(),
              })
              .strict()
              .refine(
                (file) =>
                  (file.role === 'fabric-launcher') === (file.jarEntriesSha256 !== undefined) &&
                  (file.role === 'fabric-launcher') === (file.minecraftServerPath !== undefined),
              ),
          )
          .max(20000)
          .optional(),
        supportedProperties: z.array(z.string().min(1).max(80)).max(1000).optional(),
        worldDataVersion: z.number().int().nonnegative().max(2147483647).optional(),
      })
      .strict()
      .optional(),
    client: z
      .object({
        implementation: identifier,
        version: identifier,
        protocolId: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    checks: z.record(z.enum(minecraftVerificationChecks), z.boolean()),
    evidenceSha256: digest,
  })
  .strict();
export type MinecraftEvidence = z.infer<typeof minecraftEvidenceSchema>;

/** Stable digest shared by trusted test runners and the immutable registry. */
export function minecraftDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return input;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export function minecraftSupport(
  combination: MinecraftCombination,
  mappingDigest: string,
  choiceDigest: string,
  evidence: readonly MinecraftEvidence[],
  now = new Date(),
): 'verified' | 'experimental' | 'unverified' | 'unsupported' {
  if (combination.family !== 'netty' || combination.protocolId === null) return 'unsupported';
  const matching = evidence.filter(
    (report) =>
      report.combinationDigest === minecraftDigest(combination) &&
      report.mappingDigest === mappingDigest &&
      report.choiceDigest === choiceDigest &&
      Date.parse(report.recordedAt) <= now.getTime() &&
      now.getTime() - Date.parse(report.recordedAt) <= 180 * 86400000,
  );
  const ordered = [...matching].sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
  const latest = ordered[0];
  // Conflicting simultaneous results cannot establish a newer successful run.
  if (
    !latest ||
    (ordered[1] && Date.parse(ordered[1].recordedAt) === Date.parse(latest.recordedAt))
  )
    return 'unverified';
  if (
    latest.kind === 'real-server' &&
    latest.server &&
    latest.client &&
    latest.server.javaMajor === combination.javaMajor &&
    latest.client.protocolId === combination.protocolId &&
    minecraftVerificationChecks.every((check) => latest.checks[check])
  )
    return 'verified';
  // A real installation/probe run can bootstrap private validation without
  // claiming gateway, player or full client compatibility. Ordinary users cannot select it.
  if (
    latest.kind === 'installation-bootstrap' &&
    latest.server &&
    latest.client &&
    latest.server.javaMajor === combination.javaMajor &&
    latest.client.protocolId === combination.protocolId &&
    latest.checks.installation &&
    latest.checks.status &&
    latest.checks.readiness
  )
    return 'experimental';
  if (
    latest.kind === 'protocol-fixture' &&
    latest.checks.status &&
    latest.checks.intentionalJoin &&
    latest.checks.readiness
  )
    return 'experimental';
  return 'unverified';
}

/** Owner availability and test evidence are deliberately independent authorities. */
export function assertMinecraftChoice(
  input: {
    combination: MinecraftCombination;
    enabled: boolean;
    mappingDigest: string;
    choiceDigest: string;
    evidence: readonly MinecraftEvidence[];
    privateTester: boolean;
  },
  now = new Date(),
): void {
  const support = minecraftSupport(
    input.combination,
    input.mappingDigest,
    input.choiceDigest,
    input.evidence,
    now,
  );
  if (
    !input.enabled ||
    (support !== 'verified' && !(input.privateTester && support === 'experimental'))
  )
    throw new DomainError('integration_unavailable');
}

/** No protocol numbers or support-matrix state in the ordinary creation catalog. */
export function publicMinecraftChoice(id: string, combination: MinecraftCombination) {
  return {
    id,
    version: combination.release,
    runtime: combination.profile,
    ...(combination.buildId ? { build: combination.buildId } : {}),
    ...(combination.loaderVersion ? { loaderVersion: combination.loaderVersion } : {}),
  };
}
