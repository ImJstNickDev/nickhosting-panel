import {
  type AuthContext,
  assertConfigWritable,
  DomainError,
  gameIdleTimeoutSchema,
  idleTimeoutUserAccessSchema,
  resolveConfig,
} from '@nickhosting/core';
import { type Database, getSettings, recordAudit } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { type DB, type Environment, lockResources } from './admission.js';
import { trustedGameModules } from './game-modules.js';
import { currentInteractiveContext } from './interactive-context.js';
import { ownerOnly, parse } from './registry.js';

const policySchema = z.strictObject({
  gameTimeoutSeconds: gameIdleTimeoutSchema.nullable(),
  runtimeTimeouts: z.record(z.string(), gameIdleTimeoutSchema),
  userAccess: idleTimeoutUserAccessSchema.nullable().default(null),
  runtimeUserAccess: z.record(z.string(), idleTimeoutUserAccessSchema).default({}),
});

/** No implicit sleep until explicitly configured. Disabling sleep never disables wake. */
export async function resolveIdleTimeout(
  db: DB,
  serverId: string,
  state: {
    idle_timeout_inherited: boolean;
    idle_timeout_seconds: number | null;
    owner_idle_timeout_seconds?: number | null;
    owner_idle_timeout_user_access?: 'hidden' | 'editable' | 'shorten-only' | null;
  } | null,
  env: Environment = {},
) {
  const mapping = await db
    .selectFrom('managed_servers as s')
    .innerJoin('runtime_egg_mappings as m', 'm.id', 's.mapping_id')
    .select(['m.game_id', 'm.runtime_id'])
    .where('s.id', '=', serverId)
    .executeTakeFirstOrThrow();
  const { values } = await getSettings(db, env);
  const game = values.gameIdleTimeouts[mapping.game_id];
  const runtime = game?.runtimeTimeouts[mapping.runtime_id];
  const inheritedSeconds = runtime ?? game?.gameTimeoutSeconds ?? values.defaultIdleTimeoutSeconds;
  const inheritedSource =
    runtime !== undefined ? 'runtime' : game?.gameTimeoutSeconds != null ? 'game' : 'default';
  const inheritedUserAccess =
    game?.runtimeUserAccess[mapping.runtime_id] ?? game?.userAccess ?? values.idleTimeoutUserAccess;
  const userAccess = state?.owner_idle_timeout_user_access ?? inheritedUserAccess;
  const ownerOverrideSeconds = state?.owner_idle_timeout_seconds ?? null;
  const ownerBaselineSeconds = ownerOverrideSeconds ?? inheritedSeconds;
  const overrideSeconds =
    state && !state.idle_timeout_inherited ? (state.idle_timeout_seconds ?? -1) : null;
  const ownerSource = ownerOverrideSeconds !== null ? 'server' : inheritedSource;
  let effectiveSeconds = ownerBaselineSeconds;
  let source = ownerSource;
  if (userAccess !== 'hidden' && overrideSeconds !== null) {
    effectiveSeconds =
      userAccess === 'shorten-only' && ownerBaselineSeconds !== -1
        ? overrideSeconds === -1
          ? ownerBaselineSeconds
          : Math.min(overrideSeconds, ownerBaselineSeconds)
        : overrideSeconds;
    if (
      userAccess === 'editable' ||
      ownerBaselineSeconds === -1 ||
      (overrideSeconds !== -1 && overrideSeconds <= ownerBaselineSeconds)
    )
      source = 'server';
  }
  return {
    overrideSeconds,
    effectiveSeconds,
    source,
    inheritedSeconds,
    userAccess,
    inheritedUserAccess,
    ownerBaselineSeconds,
    ownerOverrideSeconds,
    ownerUserAccessOverride: state?.owner_idle_timeout_user_access ?? null,
  };
}

export async function publicIdleTimeout(
  db: DB,
  serverId: string,
  state: Parameters<typeof resolveIdleTimeout>[2],
  context: AuthContext,
  env: Environment = {},
) {
  const value = await resolveIdleTimeout(db, serverId, state, env);
  if (context.role === 'owner' && context.sessionType === 'regular')
    return { ...value, overrideSeconds: value.ownerOverrideSeconds };
  if (value.userAccess === 'hidden') return null;
  return {
    overrideSeconds: value.overrideSeconds,
    effectiveSeconds: value.effectiveSeconds,
    source: value.source,
    inheritedSeconds: value.ownerBaselineSeconds,
    userAccess: value.userAccess,
    ownerBaselineSeconds: value.ownerBaselineSeconds,
  };
}

function manifestFor(gameId: string) {
  const module = trustedGameModules.get(gameId);
  if (!module) throw new DomainError('not_found');
  return module.manifest;
}

export async function getGameSleepPolicy(
  db: DB,
  context: AuthContext,
  gameId: string,
  env: Environment = {},
) {
  ownerOnly(await currentInteractiveContext(db, context, env));
  const manifest = manifestFor(gameId);
  const config = await getSettings(db, env);
  const policy = config.values.gameIdleTimeouts[gameId];
  return {
    gameId,
    gameTimeoutSeconds: policy?.gameTimeoutSeconds ?? null,
    runtimeTimeouts: policy?.runtimeTimeouts ?? {},
    effectiveGameSeconds: policy?.gameTimeoutSeconds ?? config.values.defaultIdleTimeoutSeconds,
    userAccess: policy?.userAccess ?? null,
    runtimeUserAccess: policy?.runtimeUserAccess ?? {},
    effectiveUserAccess: policy?.userAccess ?? config.values.idleTimeoutUserAccess,
    inheritedGameSeconds: config.values.defaultIdleTimeoutSeconds,
    inheritedUserAccess: config.values.idleTimeoutUserAccess,
    runtimes: manifest.runtimes.map((runtime) => ({
      id: runtime.id,
      name: runtime.id,
      nameKey: runtime.nameKey,
    })),
    locked: config.lockedKeys.includes('gameIdleTimeouts'),
  };
}

export async function setGameSleepPolicy(
  db: Kysely<Database>,
  context: AuthContext,
  gameId: string,
  input: unknown,
  env: Environment = {},
) {
  const value = parse(policySchema, input);
  const manifest = manifestFor(gameId);
  if (
    [...Object.keys(value.runtimeTimeouts), ...Object.keys(value.runtimeUserAccess)].some(
      (id) => !manifest.runtimes.some((runtime) => runtime.id === id),
    )
  )
    throw new DomainError('validation_failed');
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':settings', 0))`.execute(
      tx,
    );
    const current = await currentInteractiveContext(tx, context, env);
    ownerOnly(current);
    const previous = await tx
      .selectFrom('platform_settings')
      .select('value')
      .where('key', '=', 'platform')
      .executeTakeFirst();
    const config = resolveConfig(previous?.value ?? {}, env);
    const patch = { gameIdleTimeouts: { ...config.values.gameIdleTimeouts, [gameId]: value } };
    assertConfigWritable(patch, config);
    const next = { ...previous?.value, ...patch };
    resolveConfig(next, env);
    await tx
      .insertInto('platform_settings')
      .values({ key: 'platform', value: next })
      .onConflict((c) => c.column('key').doUpdateSet({ value: next, updated_at: new Date() }))
      .execute();
    await tx
      .updateTable('gateway_server_states')
      .set({ idle_since: null })
      .where(
        'server_id',
        'in',
        tx
          .selectFrom('managed_servers as s')
          .innerJoin('runtime_egg_mappings as m', 'm.id', 's.mapping_id')
          .select('s.id')
          .where('m.game_id', '=', gameId),
      )
      .execute();
    await recordAudit(tx, current, 'game.sleep_policy.updated', { gameId, ...value });
    return getGameSleepPolicy(tx, current, gameId, env);
  });
}

/** Called at the final power handoff, including after a durable handoff receipt. */
export async function assertIdleSleepAllowed(db: DB, serverId: string, env: Environment = {}) {
  const state = await db
    .selectFrom('gateway_server_states')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (!state?.enabled) throw new DomainError('forbidden');
  const timeout = await resolveIdleTimeout(db, serverId, state, env);
  if (
    timeout.effectiveSeconds === -1 ||
    !state.idle_since ||
    !state.last_observed_at ||
    state.last_observed_at.getTime() - state.idle_since.getTime() < timeout.effectiveSeconds * 1000
  )
    throw new DomainError('forbidden');
}
