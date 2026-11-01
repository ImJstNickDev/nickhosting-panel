import {
  type AuthContext,
  assertConfigWritable,
  autoWakeUserAccessSchema,
  DomainError,
  gameAutoWakePolicySchema,
  type PlatformConfig,
  resolveConfig,
} from '@nickhosting/core';
import {
  type Database,
  getSettings,
  notifyGatewayChange,
  recordAudit,
} from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { type DB, type Environment, lockResources } from './admission.js';
import { trustedGameModules } from './game-modules.js';
import { type GatewayPolicyContext, loadGatewayPolicyContext } from './gateway-policy-context.js';
import { currentInteractiveContext } from './interactive-context.js';
import { authorizeServer, ownerOnly, parse } from './registry.js';

type WakeState = {
  auto_wake_override?: boolean | null;
  owner_auto_wake_override?: boolean | null;
  owner_auto_wake_user_access?: z.infer<typeof autoWakeUserAccessSchema> | null;
};
/** Pure precedence resolver; disabling wake never changes sleep, intent or lifecycle. */
export function resolveAutoWakeValues(
  values: Pick<
    PlatformConfig,
    'defaultAutoWakeEnabled' | 'autoWakeUserAccess' | 'gameAutoWakePolicies'
  >,
  gameId: string,
  runtimeId: string,
  state: WakeState | null,
) {
  const game = values.gameAutoWakePolicies[gameId];
  const runtime = game?.runtimeEnabled[runtimeId];
  const inheritedEnabled = runtime ?? game?.gameEnabled ?? values.defaultAutoWakeEnabled;
  const inheritedSource =
    runtime !== undefined ? 'runtime' : game?.gameEnabled != null ? 'game' : 'default';
  const inheritedUserAccess =
    game?.runtimeUserAccess[runtimeId] ?? game?.userAccess ?? values.autoWakeUserAccess;
  const userAccess = state?.owner_auto_wake_user_access ?? inheritedUserAccess;
  const ownerOverrideEnabled = state?.owner_auto_wake_override ?? null;
  const ownerBaselineEnabled = ownerOverrideEnabled ?? inheritedEnabled;
  const overrideEnabled = state?.auto_wake_override ?? null;
  const applied =
    userAccess !== 'hidden' &&
    overrideEnabled !== null &&
    (userAccess === 'editable' || !overrideEnabled);
  return {
    effectiveEnabled: applied ? overrideEnabled : ownerBaselineEnabled,
    source: applied || ownerOverrideEnabled !== null ? 'server' : inheritedSource,
    inheritedEnabled,
    inheritedUserAccess,
    overrideEnabled,
    userAccess,
    ownerBaselineEnabled,
    ownerOverrideEnabled,
    ownerUserAccessOverride: state?.owner_auto_wake_user_access ?? null,
  };
}
export async function resolveAutoWake(
  db: DB,
  serverId: string,
  state: WakeState | null,
  env: Environment = {},
  inputs?: GatewayPolicyContext,
) {
  const { mapping, values } = inputs ?? (await loadGatewayPolicyContext(db, serverId, env));
  return resolveAutoWakeValues(values, mapping.game_id, mapping.runtime_id, state);
}

function publicPolicy(value: Awaited<ReturnType<typeof resolveAutoWake>>, context: AuthContext) {
  if (context.role === 'owner' && context.sessionType === 'regular')
    return { ...value, overrideEnabled: value.ownerOverrideEnabled };
  if (value.userAccess === 'hidden') return null;
  return {
    effectiveEnabled: value.effectiveEnabled,
    source: value.source,
    overrideEnabled: value.overrideEnabled,
    inheritedEnabled: value.ownerBaselineEnabled,
    userAccess: value.userAccess,
    ownerBaselineEnabled: value.ownerBaselineEnabled,
  };
}
export async function getServerAutoWakePolicy(
  db: DB,
  context: AuthContext,
  serverId: string,
  env: Environment = {},
) {
  const current = await currentInteractiveContext(db, context, env);
  const server = await authorizeServer(db, current, serverId, 'settings.read');
  if (server.connection_mode === 'direct') return null;
  const state = await db
    .selectFrom('gateway_server_states')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (!state) return null;
  return publicPolicy(await resolveAutoWake(db, serverId, state, env), current);
}
export async function setServerAutoWakePolicy(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  input: unknown,
  env: Environment = {},
) {
  const value = parse(
    z.strictObject({
      overrideEnabled: z.boolean().nullable(),
      userAccess: autoWakeUserAccessSchema.nullable().optional(),
    }),
    input,
  );
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const current = await currentInteractiveContext(tx, context, env);
    if (current.sessionType !== 'regular') throw new DomainError('forbidden');
    const server = await authorizeServer(tx, current, serverId, 'settings.write');
    if (server.connection_mode === 'direct') throw new DomainError('integration_unavailable');
    const state = await tx
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!state) throw new DomainError('not_found');
    const owner = current.role === 'owner';
    if (!owner) {
      const policy = await resolveAutoWake(tx, serverId, state, env);
      if (
        value.userAccess !== undefined ||
        policy.userAccess === 'hidden' ||
        (policy.userAccess === 'disable-only' && value.overrideEnabled === true)
      )
        throw new DomainError('forbidden');
    }
    await tx
      .updateTable('gateway_server_states')
      .set(
        owner
          ? {
              owner_auto_wake_override: value.overrideEnabled,
              ...(value.userAccess !== undefined
                ? { owner_auto_wake_user_access: value.userAccess }
                : {}),
              updated_at: new Date(),
            }
          : { auto_wake_override: value.overrideEnabled, updated_at: new Date() },
      )
      .where('server_id', '=', serverId)
      .execute();
    await recordAudit(tx, current, 'server.auto_wake_policy.updated', { serverId, ...value });
    await notifyGatewayChange(tx);
    return getServerAutoWakePolicy(tx, current, serverId, env);
  });
}
function manifestFor(gameId: string) {
  const module = trustedGameModules.get(gameId);
  if (!module) throw new DomainError('not_found');
  return module.manifest;
}
export async function getGameAutoWakePolicy(
  db: DB,
  context: AuthContext,
  gameId: string,
  env: Environment = {},
) {
  ownerOnly(await currentInteractiveContext(db, context, env));
  const manifest = manifestFor(gameId);
  const config = await getSettings(db, env);
  const policy = config.values.gameAutoWakePolicies[gameId];
  return {
    gameId,
    gameEnabled: policy?.gameEnabled ?? null,
    runtimeEnabled: policy?.runtimeEnabled ?? {},
    effectiveGameEnabled: policy?.gameEnabled ?? config.values.defaultAutoWakeEnabled,
    userAccess: policy?.userAccess ?? null,
    runtimeUserAccess: policy?.runtimeUserAccess ?? {},
    effectiveUserAccess: policy?.userAccess ?? config.values.autoWakeUserAccess,
    inheritedGameEnabled: config.values.defaultAutoWakeEnabled,
    inheritedUserAccess: config.values.autoWakeUserAccess,
    runtimes: manifest.runtimes.map((runtime) => ({
      id: runtime.id,
      name: runtime.id,
      nameKey: runtime.nameKey,
    })),
    locked: config.lockedKeys.includes('gameAutoWakePolicies'),
  };
}
export async function setGameAutoWakePolicy(
  db: Kysely<Database>,
  context: AuthContext,
  gameId: string,
  input: unknown,
  env: Environment = {},
) {
  const value = parse(gameAutoWakePolicySchema, input);
  const manifest = manifestFor(gameId);
  if (
    [...Object.keys(value.runtimeEnabled), ...Object.keys(value.runtimeUserAccess)].some(
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
    const patch = {
      gameAutoWakePolicies: { ...config.values.gameAutoWakePolicies, [gameId]: value },
    };
    assertConfigWritable(patch, config);
    const next = { ...previous?.value, ...patch };
    resolveConfig(next, env);
    await tx
      .insertInto('platform_settings')
      .values({ key: 'platform', value: next })
      .onConflict((c) => c.column('key').doUpdateSet({ value: next, updated_at: new Date() }))
      .execute();
    await recordAudit(tx, current, 'game.auto_wake_policy.updated', { gameId, ...value });
    await notifyGatewayChange(tx);
    return getGameAutoWakePolicy(tx, current, gameId, env);
  });
}
export async function assertAutoWakeAllowed(
  db: DB,
  serverId: string,
  state: WakeState,
  env: Environment = {},
) {
  if (!(await resolveAutoWake(db, serverId, state, env)).effectiveEnabled)
    throw new DomainError('forbidden');
}
