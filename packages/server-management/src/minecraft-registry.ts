import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, getSettings, recordAudit } from '@nickhosting/database';
import { evaluateGameAccess } from '@nickhosting/game-sdk';
import {
  assertMinecraftChoice,
  fetchMinecraftProtocols,
  minecraftCombinationSchema,
  minecraftDigest,
  minecraftEvidenceSchema,
  minecraftSupport,
  publicMinecraftChoice,
} from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import {
  createRuntimeMetadataClient,
  minecraftRuntimeMappingSchema,
  minecraftRuntimeRequestSchema,
  type RuntimeMetadataClient,
  resolveMinecraftRuntime,
  validateMinecraftRuntimeMapping,
} from '../../../games/minecraft/src/runtime.js';
import { type DB, type Environment, lockResources } from './admission.js';
import { currentInteractiveContext } from './interactive-context.js';
import { ownerOnly, parse } from './registry.js';

type Mapping = Selectable<Database['runtime_egg_mappings']>;
export function minecraftMappingDigest(mapping: Mapping): string {
  const { enabled: _enabled, ...identity } = mapping;
  return minecraftDigest(identity);
}
function verificationKey(env: Environment): Buffer | undefined {
  const value = env.NH_MINECRAFT_EVIDENCE_KEY;
  if (value === undefined) return;
  if (!/^[a-f0-9]{64}$/.test(value)) throw new DomainError('configuration_invalid');
  return Buffer.from(value, 'hex');
}
/** Signing is reserved for the trusted integration runner, not Owner form fields. */
export function signMinecraftEvidence(report: unknown, env: Environment): string {
  const key = verificationKey(env);
  if (!key) throw new DomainError('configuration_invalid');
  return createHmac('sha256', key)
    .update(minecraftDigest(minecraftEvidenceSchema.parse(report)))
    .digest('hex');
}
function validSignature(report: unknown, signature: string, env: Environment): boolean {
  if (!verificationKey(env) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const parsed = minecraftEvidenceSchema.safeParse(report);
  return (
    parsed.success &&
    timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(signMinecraftEvidence(parsed.data, env), 'hex'),
    )
  );
}

export async function registerMinecraftCombination(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  context: AuthContext,
  input: unknown,
  env: Environment = {},
  options: { metadata?: RuntimeMetadataClient; protocols?: typeof fetchMinecraftProtocols } = {},
) {
  ownerOnly(context);
  const value = parse(
    z
      .object({
        mappingId: z.uuid(),
        runtime: minecraftRuntimeRequestSchema,
        binding: minecraftRuntimeMappingSchema,
      })
      .strict(),
    input,
  );
  const mapping = await db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', value.mappingId)
    .executeTakeFirst();
  if (mapping?.game_id !== 'minecraft-java' || mapping.runtime_id !== value.runtime.profile)
    throw new DomainError('validation_failed');
  const { values } = await getSettings(db, env);
  const metadata =
    options.metadata ??
    createRuntimeMetadataClient({ userAgent: values.minecraftMetadataUserAgent ?? '' });
  const runtime = await resolveMinecraftRuntime(value.runtime, metadata);
  const protocols = await (options.protocols ?? fetchMinecraftProtocols)(
    values.minecraftProtocolSource,
  );
  const protocol = protocols.releases.get(runtime.release);
  const egg = await adapter.getEgg(mapping.nest_id, mapping.egg_id);
  const declared =
    egg.relationships?.variables?.data.map((entry) => entry.attributes.env_variable) ?? [];
  if (
    value.binding.image !== mapping.docker_image ||
    value.binding.profile !== mapping.runtime_id ||
    value.binding.declaredEggVariables.some((name) => !declared.includes(name))
  )
    throw new DomainError('configuration_invalid');
  // Image availability is a deployment prerequisite, not protocol incompatibility.
  // A pending Owner egg/image update leaves this immutable choice unavailable until tested.
  validateMinecraftRuntimeMapping(runtime, value.binding);
  const combination = minecraftCombinationSchema.parse({
    release: runtime.release,
    releaseType: runtime.releaseType,
    protocolId: protocol?.protocolId ?? null,
    family: protocol?.family ?? 'unknown',
    transfer: protocol?.transfer ?? false,
    profile: runtime.profile,
    buildId: runtime.buildId?.toString(),
    loaderVersion: runtime.loaderVersion,
    installerVersion: runtime.installerVersion,
    javaMajor: runtime.javaMajor,
    runtimeDigest: minecraftDigest({
      ...runtime,
      evidence: runtime.evidence.map(({ url, sha256 }) => ({ url, sha256 })),
    }),
    protocolSource: protocols.source,
  });
  const identity = minecraftDigest({ combination, binding: value.binding });
  const mappingDigest = minecraftMappingDigest(mapping);
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const current = await currentInteractiveContext(tx, context, env);
    ownerOnly(current);
    const latest = await tx
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', mapping.id)
      .executeTakeFirstOrThrow();
    if (minecraftMappingDigest(latest) !== mappingDigest) throw new DomainError('conflict');
    const existing = await tx
      .selectFrom('minecraft_combinations')
      .select('id')
      .where('mapping_id', '=', mapping.id)
      .where('identity_digest', '=', identity)
      .executeTakeFirst();
    if (existing) return existing;
    const id = randomUUID();
    await tx
      .insertInto('minecraft_combinations')
      .values({
        id,
        mapping_id: mapping.id,
        identity_digest: identity,
        combination: JSON.stringify(combination),
        resolved_runtime: JSON.stringify(runtime),
        binding: JSON.stringify(value.binding),
        mapping_digest: mappingDigest,
      })
      .execute();
    await recordAudit(tx, current, 'minecraft.combination.registered', {
      id,
      mappingId: mapping.id,
      identity,
    });
    return { id };
  });
}

export async function inspectMinecraftCombination(db: DB, id: string, env: Environment = {}) {
  const row = await db
    .selectFrom('minecraft_combinations')
    .selectAll()
    .where('id', '=', parse(z.uuid(), id))
    .executeTakeFirst();
  if (!row) throw new DomainError('not_found');
  const mapping = await db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', row.mapping_id)
    .executeTakeFirstOrThrow();
  const reports = await db
    .selectFrom('minecraft_verification_evidence')
    .selectAll()
    .where('combination_id', '=', row.id)
    .execute();
  const evidence = reports
    .filter((report) => validSignature(report.report, report.signature, env))
    .map((report) => minecraftEvidenceSchema.parse(report.report));
  const combination = minecraftCombinationSchema.parse(row.combination);
  const mappingDigest = minecraftMappingDigest(mapping);
  return {
    row,
    mapping,
    combination,
    evidence,
    mappingDigest,
    support: minecraftSupport(combination, mappingDigest, row.identity_digest, evidence),
  };
}

export async function requireMinecraftChoice(
  db: DB,
  context: AuthContext,
  id: string,
  env: Environment = {},
) {
  const choice = await inspectMinecraftCombination(db, id, env);
  const rollout = await db
    .selectFrom('game_rollouts')
    .selectAll()
    .where('integration_id', '=', 'minecraft-java')
    .executeTakeFirst();
  if (
    !rollout ||
    !evaluateGameAccess(
      { gameId: 'minecraft-java', state: rollout.state, allowedUserIds: rollout.allowlist },
      { userId: context.subjectUserId, role: context.role },
    ).canCreate
  )
    throw new DomainError('forbidden');
  assertMinecraftChoice({
    combination: choice.combination,
    enabled: choice.row.enabled && choice.mapping.enabled,
    mappingDigest: choice.mappingDigest,
    choiceDigest: choice.row.identity_digest,
    evidence: choice.evidence,
    privateTester:
      context.sessionType === 'regular' &&
      rollout.state === 'private-testing' &&
      (context.role === 'owner' || rollout.allowlist.includes(context.subjectUserId)),
  });
  return choice;
}

export async function minecraftCatalog(db: DB, context: AuthContext, env: Environment = {}) {
  const rows = await db
    .selectFrom('minecraft_combinations')
    .select('id')
    .where('enabled', '=', true)
    .execute();
  const choices = [];
  for (const row of rows) {
    try {
      const choice = await requireMinecraftChoice(db, context, row.id, env);
      choices.push(publicMinecraftChoice(row.id, choice.combination));
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        !['forbidden', 'integration_unavailable'].includes(error.code)
      )
        throw error;
    }
  }
  return choices;
}

export async function setMinecraftAvailability(
  db: Kysely<Database>,
  context: AuthContext,
  id: string,
  input: unknown,
  env: Environment = {},
) {
  ownerOnly(context);
  const value = parse(z.object({ enabled: z.boolean() }).strict(), input);
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const current = await currentInteractiveContext(tx, context, env);
    ownerOnly(current);
    await inspectMinecraftCombination(tx, id, env);
    await tx.updateTable('minecraft_combinations').set(value).where('id', '=', id).execute();
    await recordAudit(tx, current, 'minecraft.availability.updated', {
      id,
      enabled: value.enabled,
    });
  });
}

/** API accepts only an intact attestation from the separately keyed test runner. */
export async function importMinecraftEvidence(
  db: Kysely<Database>,
  context: AuthContext,
  id: string,
  input: unknown,
  env: Environment = {},
) {
  ownerOnly(context);
  const value = parse(
    z
      .object({ report: minecraftEvidenceSchema, signature: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict(),
    input,
  );
  if (!validSignature(value.report, value.signature, env)) throw new DomainError('forbidden');
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const current = await currentInteractiveContext(tx, context, env);
    ownerOnly(current);
    const choice = await inspectMinecraftCombination(tx, id, env);
    if (
      value.report.combinationDigest !== minecraftDigest(choice.combination) ||
      value.report.choiceDigest !== choice.row.identity_digest ||
      value.report.mappingDigest !== choice.mappingDigest ||
      Date.parse(value.report.recordedAt) > Date.now()
    )
      throw new DomainError('validation_failed');
    await tx
      .insertInto('minecraft_verification_evidence')
      .values({
        id: value.report.runId,
        combination_id: id,
        report: JSON.stringify(value.report),
        signature: value.signature,
      })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
    const stored = await tx
      .selectFrom('minecraft_verification_evidence')
      .selectAll()
      .where('id', '=', value.report.runId)
      .executeTakeFirstOrThrow();
    if (stored.combination_id !== id || stored.signature !== value.signature)
      throw new DomainError('conflict');
    await recordAudit(tx, current, 'minecraft.evidence.imported', {
      id,
      runId: value.report.runId,
      kind: value.report.kind,
    });
  });
}
