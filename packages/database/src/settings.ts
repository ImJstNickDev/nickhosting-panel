import { randomUUID } from 'node:crypto';
import {
  type AuthContext,
  assertConfigWritable,
  assertPermission,
  DomainError,
  normalizeLegacyContentSettings,
  type PlatformConfig,
  platformConfigPatchSchema,
  resolveConfig,
  type SecretCodec,
} from '@nickhosting/core';
import { evaluateGameAccess, gameManifestSchema, gameRolloutSchema } from '@nickhosting/game-sdk';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';
import { notifyGatewayChange, requeueOpenworldPublications } from './job-notifications.js';
import { assertStoragePolicyIdle } from './storage-policy.js';

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

async function assertResourceSettingsFit(
  tx: Transaction<Database>,
  previous: Readonly<PlatformConfig>,
  next: Readonly<PlatformConfig>,
) {
  await assertStoragePolicyIdle(tx);
  // Policy changes must validate already committed reservations under the same
  // lock as admission; switching storage modes cannot hide existing use.
  const reservations = await tx.selectFrom('resource_reservations').selectAll().execute();
  const servers = await tx
    .selectFrom('managed_servers as s')
    .innerJoin('runtime_egg_mappings as m', 'm.id', 's.mapping_id')
    .select(['s.owner_id', 's.limits', 'm.feature_limits'])
    .where('s.deleted_at', 'is', null)
    .execute();
  const exceptions = await tx.selectFrom('resource_user_limits').selectAll().execute();
  const storageBudgets = await tx.selectFrom('storage_user_budgets').selectAll().execute();
  if (servers.length > 0 && next.storagePolicy !== previous.storagePolicy)
    throw new DomainError('conflict', 409, { reason: 'storage_policy_transition_required' });
  const owners = new Set([
    ...reservations.map((r) => r.owner_id),
    ...servers.map((s) => s.owner_id),
  ]);
  for (const owner of owners) {
    const exception = exceptions.find(
      (e) => e.user_id === owner && (!e.expires_at || e.expires_at > new Date()),
    );
    const memory = exception?.memory_mib ?? next.defaultUserMemoryMiB;
    const cpu = exception?.cpu_percent ?? next.defaultUserCpuPercent;
    const storageBudget = storageBudgets.find((budget) => budget.user_id === owner);
    const storage = Number(
      storageBudget
        ? (storageBudget.storage_mib ?? next.defaultUserStorageMiB)
        : (exception?.storage_mib ?? next.defaultUserStorageMiB),
    );
    const active = reservations.filter((r) => r.owner_id === owner);
    if (
      active.reduce((s, r) => s + r.memory_mib, 0) > memory ||
      active.reduce((s, r) => s + r.cpu_percent, 0) > cpu ||
      (next.storagePolicy === 'PER_USER_BUDGET' &&
        storage > 0 &&
        servers
          .filter((r) => r.owner_id === owner)
          .reduce((s, r) => s + r.limits.disk * (1 + r.feature_limits.backups), 0) > storage)
    )
      throw new DomainError('conflict');
  }
}

export async function updateSettings(
  db: Kysely<Database>,
  context: AuthContext,
  patch: unknown,
  env: Environment = {},
) {
  regularOwner(context);
  const parsedPatch = platformConfigPatchSchema.safeParse(patch);
  if (!parsedPatch.success) throw new DomainError('configuration_invalid');
  patch = parsedPatch.data;
  const fields = Object.keys(parsedPatch.data);
  const onlyNpmSettings =
    fields.length > 0 && fields.every((field) => field === 'npmApiUrl' || field === 'npmAcmeEmail');
  return db.transaction().execute(async (tx) => {
    if (!onlyNpmSettings)
      await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':resources', 0))`.execute(
        tx,
      );
    await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':settings', 0))`.execute(
      tx,
    );
    const previous = await tx
      .selectFrom('platform_settings')
      .select('value')
      .where('key', '=', 'platform')
      .executeTakeFirst();
    const current = resolveConfig(previous?.value ?? {}, env);
    assertConfigWritable(patch, current);
    const value = {
      ...(normalizeLegacyContentSettings(previous?.value ?? {}) as Partial<PlatformConfig>),
      ...patch,
    };
    // Internal reset requests use undefined; JSON PATCH clients cannot supply
    // it. Remove the stored override before resolving/validating default policy.
    for (const key of Object.keys(value) as Array<keyof PlatformConfig>)
      if (value[key] === undefined) delete value[key];
    const resolved = resolveConfig(value, env);
    if ('npmApiUrl' in patch) {
      const oldUrl = current.values.npmApiUrl;
      const newUrl = resolved.values.npmApiUrl;
      if (
        oldUrl &&
        new URL(oldUrl).origin !== (newUrl && new URL(newUrl).origin) &&
        (env[envName('npmAccessToken', env)] ||
          (await tx
            .selectFrom('encrypted_secrets')
            .select('name')
            .where('name', '=', 'npmAccessToken')
            .executeTakeFirst()))
      )
        throw new DomainError('conflict');
    }
    if (!onlyNpmSettings) await assertResourceSettingsFit(tx, current.values, resolved.values);
    await tx
      .insertInto('platform_settings')
      .values({ key: 'platform', value })
      .onConflict((c) => c.column('key').doUpdateSet({ value, updated_at: new Date() }))
      .execute();
    if (
      'gameIdleTimeouts' in patch ||
      'defaultIdleTimeoutSeconds' in patch ||
      'idleTimeoutUserAccess' in patch
    ) {
      // Generic settings writes share the specialized editor's idle fence.
      await tx.updateTable('gateway_server_states').set({ idle_since: null }).execute();
    }
    if (
      'gameAutoWakePolicies' in patch ||
      'defaultAutoWakeEnabled' in patch ||
      'autoWakeUserAccess' in patch
    )
      await notifyGatewayChange(tx);
    if ('npmApiUrl' in patch || 'npmAcmeEmail' in patch) await requeueOpenworldPublications(tx);
    await recordAudit(tx, context, 'settings.updated', { fields });
    return resolved;
  });
}

export const secretNames = [
  'pterodactylApplicationKey',
  'pterodactylClientKey',
  'discordClientSecret',
  'smtpPassword',
  'sftpgoApiKey',
  'sftpgoEventSecret',
  'viewerSftpgoApiKey',
  'cloudflareApiToken',
  'gatewayControlToken',
  'curseforgeApiKey',
  'metivaAccessToken',
  'npmAccessToken',
] as const;
export type SecretName = (typeof secretNames)[number];
const secretEnv: Record<SecretName, string> = {
  pterodactylApplicationKey: 'NH_PTERODACTYL_APPLICATION_KEY',
  pterodactylClientKey: 'NH_PTERODACTYL_CLIENT_KEY',
  discordClientSecret: 'DISCORD_CLIENT_SECRET',
  smtpPassword: 'SMTP_PASSWORD',
  sftpgoApiKey: 'NH_SFTPGO_API_KEY',
  sftpgoEventSecret: 'NH_SFTPGO_EVENT_SECRET',
  viewerSftpgoApiKey: 'NH_VIEWER_SFTPGO_API_KEY',
  cloudflareApiToken: 'NH_CLOUDFLARE_API_TOKEN',
  gatewayControlToken: 'NH_GATEWAY_CONTROL_TOKEN',
  curseforgeApiKey: 'NH_CURSEFORGE_API_KEY',
  metivaAccessToken: 'NH_METIVA_ACCESS_TOKEN',
  npmAccessToken: 'NH_NPM_ACCESS_TOKEN',
};

export function gameMetivaSecret(gameId: string): `metiva:${string}` {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(gameId)) throw new DomainError('validation_failed');
  return `metiva:${gameId}`;
}

type StoredSecret = SecretName | ReturnType<typeof gameMetivaSecret>;

function envName(name: StoredSecret, env: Environment): string {
  if (name === 'npmAccessToken') {
    if (env.NH_DEPLOYMENT_ENV === 'development') return 'NH_DEV_NPM_ACCESS_TOKEN';
    if (env.NH_DEPLOYMENT_ENV === 'production') return 'NH_PROD_NPM_ACCESS_TOKEN';
    return secretEnv.npmAccessToken;
  }
  if (name !== 'metivaAccessToken' && !name.startsWith('metiva:'))
    return secretEnv[name as SecretName];
  const suffix =
    name === 'metivaAccessToken' ? '' : `_${name.slice(7).toUpperCase().replaceAll('-', '_')}`;
  // The container entrypoint preserves its own deployment's scoped variables.
  // A deployed process must not consume a local or other deployment's credential.
  switch (env.NH_DEPLOYMENT_ENV) {
    case 'development':
      return `NH_DEV_METIVA_ACCESS_TOKEN${suffix}`;
    case 'production':
      return `NH_PROD_METIVA_ACCESS_TOKEN${suffix}`;
    case undefined:
      return `NH_METIVA_ACCESS_TOKEN${suffix}`;
    default:
      throw new DomainError('configuration_invalid');
  }
}

export async function getSecret(
  db: DB,
  codec: SecretCodec,
  name: StoredSecret,
  env: Environment = {},
) {
  const override = env[envName(name, env)];
  if (override !== undefined) {
    if (
      !override.trim() ||
      (name === 'npmAccessToken' && !env[envName(name, env).replace('ACCESS_TOKEN', 'API_URL')])
    )
      throw new DomainError('configuration_invalid');
    return override;
  }
  const row = await db
    .selectFrom('encrypted_secrets')
    .select('envelope')
    .where('name', '=', name)
    .executeTakeFirst();
  if (!row) return;
  if (name === 'npmAccessToken') {
    const { npmApiUrl } = (await getSettings(db, env)).values;
    if (!npmApiUrl) throw new DomainError('configuration_invalid');
    return codec.decrypt(row.envelope, `${name}:${new URL(npmApiUrl).origin}`);
  }
  return codec.decrypt(row.envelope, name);
}

/** Only presence/source can be returned to HTTP clients. */
export async function secretStatus(db: DB, env: Environment = {}) {
  const rows = await db.selectFrom('encrypted_secrets').select('name').execute();
  return secretNames
    .filter((name) => name !== 'pterodactylClientKey')
    .map((name) => ({
      name,
      configured: env[envName(name, env)] !== undefined || rows.some((r) => r.name === name),
      source: env[envName(name, env)] !== undefined ? 'environment' : 'database',
      locked: env[envName(name, env)] !== undefined,
    }));
}

export async function storeSecret(
  db: Kysely<Database>,
  context: AuthContext,
  codec: SecretCodec,
  name: StoredSecret,
  value: string,
  env: Environment = {},
  expectedOrigin?: string,
) {
  regularOwner(context);
  if (env[envName(name, env)] !== undefined) throw new DomainError('conflict');
  if (
    (name === 'metivaAccessToken' || name.startsWith('metiva:')) &&
    !/^mtv_[A-Za-z0-9_-]{1,1024}$/.test(value)
  )
    throw new DomainError('validation_failed');
  if (name === 'npmAccessToken' && !/^[A-Za-z0-9._~-]{10,4096}$/.test(value))
    throw new DomainError('validation_failed');
  await db.transaction().execute(async (tx) => {
    let binding: string = name;
    if (name === 'npmAccessToken') {
      await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':settings', 0))`.execute(
        tx,
      );
      const { npmApiUrl } = (await getSettings(tx, env)).values;
      if (!npmApiUrl || !expectedOrigin || new URL(npmApiUrl).origin !== expectedOrigin)
        throw new DomainError('conflict');
      binding = `${name}:${expectedOrigin}`;
      await requeueOpenworldPublications(tx);
    }
    const envelope = codec.encrypt(value, binding);
    await tx
      .insertInto('encrypted_secrets')
      .values({ name, envelope })
      .onConflict((c) => c.column('name').doUpdateSet({ envelope, updated_at: new Date() }))
      .execute();
    await recordAudit(tx, context, 'secret.updated', { name });
  });
}

export async function clearProviderSecret(
  db: Kysely<Database>,
  context: AuthContext,
  name: 'metivaAccessToken' | 'npmAccessToken' | ReturnType<typeof gameMetivaSecret>,
  env: Environment = {},
) {
  regularOwner(context);
  if (env[envName(name, env)] !== undefined) throw new DomainError('conflict');
  await db.transaction().execute(async (tx) => {
    if (name === 'npmAccessToken') {
      await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':settings', 0))`.execute(
        tx,
      );
      await requeueOpenworldPublications(tx);
    }
    await tx.deleteFrom('encrypted_secrets').where('name', '=', name).execute();
    await recordAudit(tx, context, 'secret.removed', { name });
  });
}

export async function getGameMetivaStatus(
  db: DB,
  context: AuthContext,
  gameId: string,
  env: Environment = {},
) {
  regularOwner(context);
  const name = gameMetivaSecret(gameId);
  const rows = await db
    .selectFrom('encrypted_secrets')
    .select('name')
    .where('name', 'in', [name, 'metivaAccessToken'])
    .execute();
  const configured = (id: StoredSecret) =>
    env[envName(id, env)] !== undefined || rows.some((row) => row.name === id);
  return {
    configured: configured(name),
    inherited: configured('metivaAccessToken'),
    locked: env[envName(name, env)] !== undefined,
  };
}

export async function getGameMetivaToken(
  db: DB,
  codec: SecretCodec,
  gameId: string,
  env: Environment = {},
) {
  return (
    (await getSecret(db, codec, gameMetivaSecret(gameId), env)) ??
    getSecret(db, codec, 'metivaAccessToken', env)
  );
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
  ];
  for (const [name, value] of entries) {
    if (value && env[envName(name, env)] === undefined)
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
