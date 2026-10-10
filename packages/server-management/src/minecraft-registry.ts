import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, getSettings, recordAudit } from '@nickhosting/database';
import { evaluateGameAccess } from '@nickhosting/game-sdk';
import {
  assertMinecraftChoice,
  fetchMinecraftProtocols,
  minecraftCombinationSchema,
  minecraftDeclaredCapabilities,
  minecraftDigest,
  minecraftEvidenceSchema,
  minecraftSupport,
  publicMinecraftChoice,
  resolveMinecraftImage,
  vanillaEggBinding,
} from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, type Selectable, sql } from 'kysely';
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
import { getMinecraftMetadataStatus } from './minecraft-metadata.js';
import { ownerOnly, parse } from './registry.js';

type Mapping = Selectable<Database['runtime_egg_mappings']>;
/** Freeze the complete actual egg-variable set and each value. Defaults are an
 * Owner registration input, never a dynamic fallback during provisioning/play. */
export function assertMinecraftDeclaredEnvironment(
  frozen: readonly string[],
  actual: readonly string[],
  environment: Readonly<Record<string, string>>,
  assignedPortVariables: readonly string[] = [],
): void {
  if (
    new Set(actual).size !== actual.length ||
    new Set(frozen).size !== frozen.length ||
    frozen.length !== actual.length ||
    frozen.some((key) => !actual.includes(key)) ||
    actual.some(
      (key) => !Object.hasOwn(environment, key) && !assignedPortVariables.includes(key),
    ) ||
    Object.keys(environment).some((key) => !actual.includes(key)) ||
    assignedPortVariables.some((key) => !actual.includes(key))
  )
    throw new DomainError('configuration_invalid');
}
export function minecraftMappingDigest(mapping: Mapping): string {
  const { enabled: _enabled, image_mode, ...identity } = mapping;
  // Preserve the signed pre-image for every pre-existing static mapping.
  return minecraftDigest(image_mode === 'integration' ? { ...identity, image_mode } : identity);
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
        binding: minecraftRuntimeMappingSchema
          .extend({
            image: minecraftRuntimeMappingSchema.shape.image.optional(),
            imageJavaMajor: minecraftRuntimeMappingSchema.shape.imageJavaMajor.optional(),
          })
          .optional(),
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
  const egg = await adapter.getEgg(mapping.nest_id, mapping.egg_id);
  const suppliedBinding =
    value.binding ??
    vanillaEggBinding({
      runtime,
      variables: egg.relationships?.variables?.data.map((entry) => entry.attributes) ?? [],
      environment: mapping.environment,
      ...(mapping.image_mode === 'static' ? { staticImage: mapping.docker_image } : {}),
    });
  let binding: z.infer<typeof minecraftRuntimeMappingSchema>;
  if (mapping.image_mode === 'integration') {
    const selected = resolveMinecraftImage(runtime);
    if (
      (suppliedBinding.image !== undefined && suppliedBinding.image !== selected.image) ||
      (suppliedBinding.imageJavaMajor !== undefined &&
        suppliedBinding.imageJavaMajor !== runtime.javaMajor)
    )
      throw new DomainError('configuration_invalid');
    binding = parse(minecraftRuntimeMappingSchema, {
      ...suppliedBinding,
      image: selected.image,
      imageJavaMajor: runtime.javaMajor,
    });
  } else binding = parse(minecraftRuntimeMappingSchema, suppliedBinding);
  const protocols = await (options.protocols ?? fetchMinecraftProtocols)(
    values.minecraftProtocolSource,
  );
  const protocol = protocols.releases.get(runtime.release);
  const declared =
    egg.relationships?.variables?.data.map((entry) => entry.attributes.env_variable) ?? [];
  if (
    (mapping.image_mode === 'static' && binding.image !== mapping.docker_image) ||
    (mapping.image_mode === 'integration' &&
      ![egg.docker_image, ...Object.values(egg.docker_images ?? {})].includes(binding.image)) ||
    binding.profile !== mapping.runtime_id ||
    egg.id !== mapping.egg_id ||
    egg.nest !== mapping.nest_id
  )
    throw new DomainError('configuration_invalid');
  // Image availability is a deployment prerequisite, not protocol incompatibility.
  // A pending Owner egg/image update leaves this immutable choice unavailable until tested.
  const variables = validateMinecraftRuntimeMapping(runtime, binding);
  assertMinecraftDeclaredEnvironment(
    binding.declaredEggVariables,
    declared,
    { ...mapping.environment, ...variables },
    mapping.port_roles.flatMap((role) =>
      role.environmentVariable ? [role.environmentVariable] : [],
    ),
  );
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
  const identity = minecraftDigest({ combination, binding });
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
        binding: JSON.stringify(binding),
        mapping_digest: mappingDigest,
        enabled: latest.enabled && minecraftDeclaredCapabilities(combination).installation,
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
  return inspectLoadedCombination(row, mapping, reports, env);
}

type CombinationRow = Selectable<Database['minecraft_combinations']>;
type EvidenceRow = Selectable<Database['minecraft_verification_evidence']>;
function inspectLoadedCombination(
  row: CombinationRow,
  mapping: Mapping,
  reports: readonly EvidenceRow[],
  env: Environment,
  mappingDigest = minecraftMappingDigest(mapping),
) {
  const evidence = reports
    .filter((report) => validSignature(report.report, report.signature, env))
    .map((report) => minecraftEvidenceSchema.parse(report.report));
  const combination = minecraftCombinationSchema.parse(row.combination);
  return {
    row,
    mapping,
    combination,
    evidence,
    mappingDigest,
    capabilities: minecraftDeclaredCapabilities(combination),
    supportAuthority:
      combination.profile === 'vanilla' ? ('integration' as const) : ('signed-evidence' as const),
    support: minecraftSupport(combination, mappingDigest, row.identity_digest, evidence),
  };
}

/** Load related data once for the complete selection. Public declared installation
 * does not need signed diagnostics; undeclared runtimes retain their evidence gate. */
export async function inspectMinecraftCombinations(
  db: DB,
  rows: readonly CombinationRow[],
  env: Environment = {},
  diagnostics = true,
) {
  if (!rows.length) return [];
  const mappings = await db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', 'in', [...new Set(rows.map((row) => row.mapping_id))])
    .execute();
  const byMapping = new Map(mappings.map((mapping) => [mapping.id, mapping]));
  const mappingDigests = new Map(
    mappings.map((mapping) => [mapping.id, minecraftMappingDigest(mapping)]),
  );
  const evidenceIds = rows
    .filter(
      (row) =>
        diagnostics ||
        !minecraftDeclaredCapabilities(minecraftCombinationSchema.parse(row.combination))
          .installation,
    )
    .map((row) => row.id);
  const reports = evidenceIds.length
    ? await db
        .selectFrom('minecraft_verification_evidence')
        .selectAll()
        .where('combination_id', 'in', evidenceIds)
        .execute()
    : [];
  const byChoice = new Map<string, EvidenceRow[]>();
  for (const report of reports) {
    const entries = byChoice.get(report.combination_id) ?? [];
    entries.push(report);
    byChoice.set(report.combination_id, entries);
  }
  return rows.map((row) => {
    const mapping = byMapping.get(row.mapping_id);
    if (!mapping) throw new DomainError('integration_unavailable');
    return inspectLoadedCombination(
      row,
      mapping,
      byChoice.get(row.id) ?? [],
      env,
      mappingDigests.get(mapping.id),
    );
  });
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
  assertLoadedMinecraftChoice(choice, rollout, context);
  return choice;
}

function assertLoadedMinecraftChoice(
  choice: ReturnType<typeof inspectLoadedCombination>,
  rollout: Selectable<Database['game_rollouts']> | undefined,
  context: AuthContext,
) {
  if (
    !rollout ||
    !evaluateGameAccess(
      { gameId: 'minecraft-java', state: rollout.state, allowedUserIds: rollout.allowlist },
      { userId: context.subjectUserId, role: context.role },
    ).canCreate
  )
    throw new DomainError('forbidden');
  // A declaration does not authorize changing the frozen provider/runtime identity.
  if (choice.row.mapping_digest !== choice.mappingDigest)
    throw new DomainError('integration_unavailable');
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
}

export async function minecraftCatalog(db: DB, context: AuthContext, env: Environment = {}) {
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
    return [];
  const rows = await db
    .selectFrom('minecraft_combinations as choice')
    .leftJoin('minecraft_release_metadata as release', (join) =>
      join.on('release.id', '=', sql<string>`choice.combination->>'release'`),
    )
    .selectAll('choice')
    .select('release.release_time as releaseTime')
    .where('choice.enabled', '=', true)
    .execute();
  const dates = new Map(rows.map((row) => [row.id, row.releaseTime?.toISOString() ?? null]));
  const loaded = await inspectMinecraftCombinations(db, rows, env, false);
  const choices = [];
  for (const choice of loaded) {
    try {
      assertLoadedMinecraftChoice(choice, rollout, context);
      choices.push({
        ...publicMinecraftChoice(choice.row.id, choice.combination),
        releaseTime: dates.get(choice.row.id) ?? null,
      });
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        !['forbidden', 'integration_unavailable'].includes(error.code)
      )
        throw error;
    }
  }
  const compare = new Intl.Collator('en', { numeric: true }).compare;
  return choices.sort(
    (left, right) =>
      (left.releaseTime === null ? 1 : 0) - (right.releaseTime === null ? 1 : 0) ||
      (left.releaseTime && right.releaseTime
        ? Date.parse(right.releaseTime) - Date.parse(left.releaseTime)
        : 0) ||
      compare(right.version, left.version) ||
      compare(left.runtime, right.runtime) ||
      compare(left.id, right.id),
  );
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

const minecraftOwnerDetail = (choice: Awaited<ReturnType<typeof inspectMinecraftCombination>>) => ({
  id: choice.row.id,
  mappingId: choice.row.mapping_id,
  enabled: choice.row.enabled,
  combination: choice.combination,
  runtime: choice.row.resolved_runtime,
  binding: choice.row.binding,
  identityDigest: choice.row.identity_digest,
  mappingDigest: choice.mappingDigest,
  support: choice.support,
  supportAuthority: choice.supportAuthority,
  capabilities: choice.capabilities,
  evidence: choice.evidence,
});

export async function listMinecraftOwnerCombinations(
  db: DB,
  query: Record<string, string>,
  env: Environment = {},
) {
  let selection = db
    .selectFrom('minecraft_combinations as choice')
    .leftJoin('minecraft_release_metadata as release', (join) =>
      join.on('release.id', '=', sql<string>`choice.combination->>'release'`),
    );
  const releaseTime = (value: Date | null) => ({
    releaseTime: value?.toISOString() ?? null,
    releaseTimeStatus: value ? ('available' as const) : ('unknown' as const),
  });
  if (query.view === 'summary') {
    const page = parse(
      z
        .object({
          view: z.literal('summary'),
          page: z.coerce.number().int().min(1).max(100000).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
          search: z.string().max(128).optional(),
          runtime: z.string().max(128).optional(),
          releaseType: z
            .enum(['release', 'snapshot', 'old_alpha', 'old_beta', 'unknown'])
            .optional(),
          availability: z.enum(['enabled', 'disabled']).optional(),
          order: z.enum(['newest', 'oldest', 'name-asc', 'name-desc']).default('newest'),
        })
        .strict(),
      query,
    );
    if (page.search)
      selection = selection.where(
        sql<boolean>`strpos(lower(concat(choice.combination->>'release', ' ', choice.combination->>'profile')), lower(${page.search})) > 0`,
      );
    if (page.runtime)
      selection = selection.where(sql<string>`choice.combination->>'profile'`, '=', page.runtime);
    if (page.releaseType)
      selection = selection.where(
        sql<string>`coalesce(choice.combination->>'releaseType', 'unknown')`,
        '=',
        page.releaseType,
      );
    if (page.availability)
      selection = selection.where('choice.enabled', '=', page.availability === 'enabled');
    const count = await selection
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .executeTakeFirstOrThrow();
    const runtimes = await db
      .selectFrom('minecraft_combinations')
      .select(sql<string>`combination->>'profile'`.as('runtime'))
      .distinct()
      .orderBy('runtime')
      .execute();
    // Natural numeric name order is deterministic across pages, unlike insertion order.
    const naturalName = sql<string>`(select string_agg(case when part[1] ~ '^[0-9]+$' then lpad(part[1], 20, '0') else lower(part[1]) end, '' order by ordinal) from regexp_matches(choice.combination->>'release', '[0-9]+|[^0-9]+', 'g') with ordinality as parts(part, ordinal)) collate "C"`;
    let ordered = selection.selectAll('choice').select('release.release_time as releaseTime');
    if (page.order === 'newest' || page.order === 'oldest')
      ordered = ordered.orderBy(
        sql`release.release_time ${sql.raw(page.order === 'newest' ? 'desc' : 'asc')} nulls last`,
      );
    ordered = ordered
      .orderBy(naturalName, page.order === 'name-asc' || page.order === 'oldest' ? 'asc' : 'desc')
      .orderBy('choice.id', 'asc');
    const rows = await ordered
      .limit(page.pageSize)
      .offset((page.page - 1) * page.pageSize)
      .execute();
    const items = rows.map((row) => {
      const combination = minecraftCombinationSchema.parse(row.combination);
      return {
        id: row.id,
        mappingId: row.mapping_id,
        enabled: row.enabled,
        combination,
        ...releaseTime(row.releaseTime),
        supportAuthority: combination.profile === 'vanilla' ? 'integration' : 'signed-evidence',
        capabilities: minecraftDeclaredCapabilities(combination),
      };
    });
    return {
      items,
      total: Number(count.total),
      page: page.page,
      pageSize: page.pageSize,
      runtimes: runtimes.map((row) => row.runtime),
      metadataStatus: await getMinecraftMetadataStatus(db),
    };
  }
  const page = Object.keys(query).length
    ? parse(
        z
          .object({
            pageSize: z.coerce.number().int().min(1).max(100).default(100),
            after: z.uuid().optional(),
          })
          .strict(),
        query,
      )
    : undefined;
  if (page?.after) selection = selection.where('choice.id', '>', page.after);
  const fetched = await (page
    ? selection.orderBy('choice.id', 'asc').limit(page.pageSize + 1)
    : selection.orderBy('choice.created_at', 'desc').limit(1000)
  )
    .selectAll('choice')
    .select('release.release_time as releaseTime')
    .execute();
  const rows = page ? fetched.slice(0, page.pageSize) : fetched;
  const dates = new Map(rows.map((row) => [row.id, row.releaseTime]));
  const choices = await inspectMinecraftCombinations(db, rows, env);
  const result = choices.map((choice) => ({
    ...minecraftOwnerDetail(choice),
    ...releaseTime(dates.get(choice.row.id) ?? null),
  }));
  const nextCursor = page && fetched.length > page.pageSize ? (rows.at(-1)?.id ?? null) : null;
  return page ? { items: result, nextCursor } : result;
}
