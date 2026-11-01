import {
  type AuthContext,
  assertConfigWritable,
  contentPolicyOverrideSchema,
  DomainError,
  dnsGamePoliciesSchema,
  type PlatformConfig,
  resolveConfig,
  resolveContentPolicy,
} from '@nickhosting/core';
import { type Database, getSettings, recordAudit } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';
import { type DB, type Environment, lockResources } from './admission.js';
import { trustedGameModules } from './game-modules.js';
import { currentInteractiveContext } from './interactive-context.js';
import { ownerOnly, parse } from './registry.js';

type Config = ReturnType<typeof resolveConfig>;

function knownGame(gameId: string) {
  const game = trustedGameModules.get(gameId);
  if (!game) throw new DomainError('not_found');
  return game;
}

function domains(config: Config) {
  const values = config.values;
  return values.dnsDomains.length
    ? values.dnsDomains
    : values.dnsBaseDomain && values.cloudflareZoneId
      ? [{ id: 'legacy', hostname: values.dnsBaseDomain, enabled: true }]
      : [];
}

function domainView(config: Config, gameId: string) {
  return {
    gameId,
    policy: config.values.dnsGamePolicies[gameId] ?? { selection: 'all' as const, domainIds: [] },
    domains: domains(config).map(({ id, hostname, enabled }) => ({ id, hostname, enabled })),
    inheritedDefaultDomainId: config.values.dnsDefaultDomainId ?? null,
    locked: config.lockedKeys.includes('dnsGamePolicies'),
  };
}

/** Merge within the same settings lock used by global configuration writes.
 * A tab edits one integration; it never sends a stale copy of other games. */
async function updateIntegrationSetting<T>(
  db: Kysely<Database>,
  context: AuthContext,
  gameId: string,
  env: Environment,
  action: string,
  patchFor: (config: Config) => Partial<PlatformConfig>,
  view: (config: Config, gameId: string) => T,
  admissionPolicy = false,
) {
  return db.transaction().execute(async (tx) => {
    if (admissionPolicy) await lockResources(tx);
    await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':settings', 0))`.execute(
      tx,
    );
    const current = await currentInteractiveContext(tx, context, env);
    ownerOnly(current);
    knownGame(gameId);
    const previous = await tx
      .selectFrom('platform_settings')
      .select('value')
      .where('key', '=', 'platform')
      .executeTakeFirst();
    const config = resolveConfig(previous?.value ?? {}, env);
    const patch = patchFor(config);
    assertConfigWritable(patch, config);
    const next = { ...previous?.value, ...patch };
    const resolved = resolveConfig(next, env);
    await tx
      .insertInto('platform_settings')
      .values({ key: 'platform', value: next })
      .onConflict((c) => c.column('key').doUpdateSet({ value: next, updated_at: new Date() }))
      .execute();
    await recordAudit(tx, current, action, { gameId });
    return view(resolved, gameId);
  });
}

function contentView(config: Config, gameId: string) {
  return {
    gameId,
    policy: config.values.gameContentPolicies[gameId] ?? {},
    effective: resolveContentPolicy(config, gameId),
    locked: config.lockedKeys.includes('gameContentPolicies'),
  };
}

export async function getGameContentPolicy(
  db: DB,
  context: AuthContext,
  gameId: string,
  env: Environment = {},
) {
  ownerOnly(await currentInteractiveContext(db, context, env));
  knownGame(gameId);
  return contentView(await getSettings(db, env), gameId);
}

export async function setGameContentPolicy(
  db: Kysely<Database>,
  context: AuthContext,
  gameId: string,
  input: unknown,
  env: Environment = {},
) {
  return updateIntegrationSetting(
    db,
    context,
    gameId,
    env,
    'game.content_policy.updated',
    (config) => ({
      gameContentPolicies: {
        ...config.values.gameContentPolicies,
        [gameId]: parse(contentPolicyOverrideSchema, input),
      },
    }),
    contentView,
    true,
  );
}

export async function getGameDomainPolicy(
  db: DB,
  context: AuthContext,
  gameId: string,
  env: Environment = {},
) {
  ownerOnly(await currentInteractiveContext(db, context, env));
  knownGame(gameId);
  return domainView(await getSettings(db, env), gameId);
}

export async function setGameDomainPolicy(
  db: Kysely<Database>,
  context: AuthContext,
  gameId: string,
  input: unknown,
  env: Environment = {},
) {
  return updateIntegrationSetting(
    db,
    context,
    gameId,
    env,
    'game.domain_policy.updated',
    (config) => {
      const policy = parse(dnsGamePoliciesSchema, { [gameId]: input })[gameId];
      if (!policy) throw new DomainError('validation_failed');
      const configured = domains(config);
      const ids = new Set(policy.domainIds);
      const preferred = configured.find((domain) => domain.id === policy.defaultDomainId);
      if (
        knownGame(gameId).manifest.connection.mode === 'static-host-port' ||
        ids.size !== policy.domainIds.length ||
        policy.domainIds.some((id) => !configured.some((domain) => domain.id === id)) ||
        (policy.sharedLabel && knownGame(gameId).manifest.connection.mode !== 'shared-host') ||
        (policy.defaultDomainId &&
          (!preferred?.enabled ||
            (policy.selection === 'allow' && !ids.has(policy.defaultDomainId)) ||
            (policy.selection === 'deny' && ids.has(policy.defaultDomainId))))
      )
        throw new DomainError('validation_failed');
      return { dnsGamePolicies: { ...config.values.dnsGamePolicies, [gameId]: policy } };
    },
    domainView,
  );
}
