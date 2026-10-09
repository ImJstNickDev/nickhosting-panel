import { randomUUID } from 'node:crypto';
import {
  type AuthContext,
  assertConfigWritable,
  assertPermission,
  DomainError,
  type PlatformConfig,
  resolveConfig,
  type SecretCodec,
} from '@nickhosting/core';
import { evaluateGameAccess, gameManifestSchema, gameRolloutSchema } from '@nickhosting/game-sdk';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';

type DB = Kysely<Database> | Transaction<Database>;
type Environment = Readonly<Record<string, string | undefined>>;

export async function getSettings(db: DB, env: Environment = {}) {
  const row = await db
    .selectFrom('platform_settings')
    .select('value')
    .where('key', '=', 'platform')
    .executeTakeFirst();
  return resolveConfig(row?.value ?? {}, env);
}

function regularOwner(context: AuthContext) {
  assertPermission(context, 'settings:write');
  if (context.sessionType !== 'regular') throw new DomainError('forbidden');
}

export async function recordAudit(
  db: DB,
  context: AuthContext,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await db
    .insertInto('audit_events')
    .values({
      id: randomUUID(),
      actor_user_id: context.actorUserId,
      subject_user_id: context.subjectUserId,
      action,
      correlation_id: context.support?.id ?? randomUUID(),
      metadata,
    })
    .execute();
}

export async function updateSettings(
  db: Kysely<Database>,
  context: AuthContext,
  patch: unknown,
  env: Environment = {},
) {
  regularOwner(context);
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':settings', 0))`.execute(
      tx,
    );
    const previous = await tx
      .selectFrom('platform_settings')
      .select('value')
      .where('key', '=', 'platform')
      .executeTakeFirst();
    assertConfigWritable(patch, resolveConfig(previous?.value ?? {}, env));
    const value = { ...previous?.value, ...patch };
    const resolved = resolveConfig(value, env);
    await tx
      .insertInto('platform_settings')
      .values({ key: 'platform', value })
      .onConflict((c) => c.column('key').doUpdateSet({ value, updated_at: new Date() }))
      .execute();
    await recordAudit(tx, context, 'settings.updated', { fields: Object.keys(patch) });
    return resolved;
  });
}

export const secretNames = [
  'pterodactylApplicationKey',
  'pterodactylClientKey',
  'discordClientSecret',
  'smtpPassword',
] as const;
export type SecretName = (typeof secretNames)[number];
const secretEnv: Record<SecretName, string> = {
  pterodactylApplicationKey: 'NH_PTERODACTYL_APPLICATION_KEY',
  pterodactylClientKey: 'NH_PTERODACTYL_CLIENT_KEY',
  discordClientSecret: 'DISCORD_CLIENT_SECRET',
  smtpPassword: 'SMTP_PASSWORD',
};

export async function getSecret(
  db: DB,
  codec: SecretCodec,
  name: SecretName,
  env: Environment = {},
) {
  const override = env[secretEnv[name]];
  if (override !== undefined) {
    if (!override.trim()) throw new DomainError('configuration_invalid');
    return override;
  }
  const row = await db
    .selectFrom('encrypted_secrets')
    .select('envelope')
    .where('name', '=', name)
    .executeTakeFirst();
  return row ? codec.decrypt(row.envelope, name) : undefined;
}

/** Only presence/source can be returned to HTTP clients. */
export async function secretStatus(db: DB, env: Environment = {}) {
  const rows = await db.selectFrom('encrypted_secrets').select('name').execute();
  return secretNames.map((name) => ({
    name,
    configured: env[secretEnv[name]] !== undefined || rows.some((r) => r.name === name),
    source: env[secretEnv[name]] !== undefined ? 'environment' : 'database',
    locked: env[secretEnv[name]] !== undefined,
  }));
}

export async function storeSecret(
  db: Kysely<Database>,
  context: AuthContext,
  codec: SecretCodec,
  name: SecretName,
  value: string,
  env: Environment = {},
) {
  regularOwner(context);
  if (env[secretEnv[name]] !== undefined) throw new DomainError('conflict');
  const envelope = codec.encrypt(value, name);
  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('encrypted_secrets')
      .values({ name, envelope })
      .onConflict((c) => c.column('name').doUpdateSet({ envelope, updated_at: new Date() }))
      .execute();
    await recordAudit(tx, context, 'secret.updated', { name });
  });
}

export async function saveBootstrapConfiguration(
  client: PoolClient,
  codec: SecretCodec,
  input: {
    instanceName: string;
    pterodactylBaseURL: string;
    pterodactylApplicationKey: string;
    pterodactylClientKey?: string;
  },
  actorUserId: string,
  env: Environment = {},
) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':settings', 0))",
  );
  const previous = await client.query<{ value: Partial<PlatformConfig> }>(
    "SELECT value FROM platform_settings WHERE key='platform' FOR UPDATE",
  );
  const patch: Partial<PlatformConfig> = {
    ...previous.rows[0]?.value,
    instanceName: input.instanceName,
    pterodactylBaseUrl: input.pterodactylBaseURL,
  };
  // Environment is authoritative even during first run; never persist example defaults.
  const resolved = resolveConfig(patch, env);
  for (const key of ['instanceName', 'pterodactylBaseUrl'] as const) {
    if (resolved.lockedKeys.includes(key)) {
      if (resolved.values[key] !== patch[key]) throw new DomainError('conflict');
      delete patch[key];
    }
  }
  await client.query(
    `INSERT INTO platform_settings(key,value) VALUES ('platform',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`,
    [JSON.stringify(patch)],
  );
  const entries: [SecretName, string | undefined][] = [
    ['pterodactylApplicationKey', input.pterodactylApplicationKey],
    ['pterodactylClientKey', input.pterodactylClientKey],
  ];
  for (const [name, value] of entries) {
    if (value && env[secretEnv[name]] === undefined)
      await client.query(
        'INSERT INTO encrypted_secrets(name,envelope) VALUES ($1,$2) ON CONFLICT(name) DO UPDATE SET envelope=excluded.envelope,updated_at=now()',
        [name, JSON.stringify(codec.encrypt(value, name))],
      );
  }
  await client.query(
    'INSERT INTO audit_events(id,actor_user_id,subject_user_id,action,correlation_id,metadata) VALUES ($1,$2,$2,$3,$4,$5)',
    [
      randomUUID(),
      actorUserId,
      'setup.configured',
      randomUUID(),
      JSON.stringify({ fields: Object.keys(patch) }),
    ],
  );
}

export async function registerGame(
  db: Kysely<Database>,
  context: AuthContext,
  input: unknown,
  rollout: unknown,
) {
  regularOwner(context);
  const parsed = gameManifestSchema.safeParse(input);
  const policy = gameRolloutSchema.safeParse(rollout);
  if (!parsed.success || !policy.success || parsed.data.id !== policy.data.gameId)
    throw new DomainError('validation_failed');
  const manifest = parsed.data;
  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('game_integrations')
      .values({ id: manifest.id, version: manifest.version, manifest })
      .onConflict((c) =>
        c.column('id').doUpdateSet({ version: manifest.version, manifest, updated_at: new Date() }),
      )
      .execute();
    await tx
      .insertInto('game_rollouts')
      .values({
        integration_id: manifest.id,
        state: policy.data.state,
        allowlist: policy.data.allowedUserIds,
      })
      .onConflict((c) =>
        c.column('integration_id').doUpdateSet({
          state: policy.data.state,
          allowlist: policy.data.allowedUserIds,
          updated_at: new Date(),
        }),
      )
      .execute();
    await recordAudit(tx, context, 'game.rollout.updated', {
      gameId: manifest.id,
      state: policy.data.state,
    });
  });
}

export async function gameCatalog(db: DB, context: AuthContext) {
  return (
    await db
      .selectFrom('game_integrations as g')
      .innerJoin('game_rollouts as r', 'r.integration_id', 'g.id')
      .select(['g.id', 'g.version', 'g.manifest', 'r.state', 'r.allowlist'])
      .execute()
  ).flatMap((row) => {
    const access = evaluateGameAccess(
      { gameId: row.id, state: row.state, allowedUserIds: row.allowlist },
      { userId: context.subjectUserId, role: context.role },
    );
    return access.visible
      ? [{ id: row.id, version: row.version, manifest: row.manifest, access }]
      : [];
  });
}
