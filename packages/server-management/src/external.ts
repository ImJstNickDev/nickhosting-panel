import { deleteDnsRow, reconcileAutomaticDns, runDns } from './dns.js';

export {
  assignServerDns,
  deleteServerDns,
  getGameConnectionOptions,
  getServerConnectionOptions,
  listServerDns,
  previewServerDns,
  updateServerDns,
} from './dns.js';

import { createHash, randomUUID } from 'node:crypto';
import {
  type AuthContext,
  assertAuthContext,
  DomainError,
  type PlatformConfig,
  type SecretCodec,
} from '@nickhosting/core';
import {
  assertStoragePolicyIdle,
  type Database,
  getSecret,
  getSettings,
  recordAudit,
} from '@nickhosting/database';
import {
  type CloudflareDnsProvider,
  generateSftpPassword,
  type SftpCredentialRef,
  type SftpCredentialRequest,
  SftpGoAdapter,
} from '@nickhosting/external-services';
import { type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources } from './admission.js';
import { currentInteractiveContext } from './interactive-context.js';
import { authorizeServer, parse } from './registry.js';
import { serverStorageLimitBytes } from './storage-capacity.js';

type SftpRow = Selectable<Database['external_sftp_credentials']>;
type SftpProvider = Pick<
  SftpGoAdapter,
  'ensureCredential' | 'inspectCredential' | 'rotateCredential' | 'revokeCredential' | 'updateQuota'
>;
type DnsProvider = Pick<CloudflareDnsProvider, 'plan' | 'apply' | 'inspectOwned'>;
export interface ExternalServiceOptions {
  codec: SecretCodec;
  env?: Environment;
  /** The runtime corroborates the registered server against the Pterodactyl adapter before new access. */
  verifyServer: (db: Kysely<Database>, serverId: string) => Promise<void>;
  /** Fresh corroborated Wings usage; SFTPGo counters omit game/unlimited writes. */
  readServerDiskUsage?: (db: Kysely<Database>, serverId: string) => Promise<number>;
  sftpFactory?: (config: PlatformConfig, apiKey: string) => SftpProvider;
  dnsFactory?: (config: PlatformConfig, apiToken: string) => DnsProvider;
  now?: () => Date;
}
type CredentialAuthority =
  | { context: AuthContext; service?: never }
  | { context?: never; service: { kind: 'personal-primary'; subjectUserId: string } };
type CredentialIntent = CredentialAuthority & {
  version: 1;
  request: SftpCredentialRequest;
  scope: string;
  action: 'create' | 'rotate' | 'revoke';
  rotationId?: string;
  delivered: boolean;
};
const now = (options: ExternalServiceOptions) => options.now?.() ?? new Date();
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const credentialContext = (id: string) => `external-sftp:${id}`;
function regular(context: AuthContext) {
  assertAuthContext(context);
  if (context.sessionType !== 'regular') throw new DomainError('forbidden');
}
async function currentContext(db: Kysely<Database>, previous: AuthContext): Promise<AuthContext> {
  regular(previous);
  const user = await db
    .selectFrom('user')
    .select('role')
    .where('id', '=', previous.actorUserId)
    .executeTakeFirst();
  if (!user) throw new DomainError('forbidden');
  return { ...previous, role: user.role };
}
const credentialActor = (authority: CredentialAuthority) =>
  authority.context ? authority.context.actorUserId : authority.service.subjectUserId;

/** Background personal access has a subject, never a fabricated browser session.
 * Match server:manage exactly; project ownership alone does not grant membership. */
async function authorizeCredential(
  db: Kysely<Database>,
  authority: CredentialAuthority,
  serverId: string,
) {
  if (authority.context)
    return authorizeServer(
      db,
      await currentContext(db, authority.context),
      serverId,
      'server:manage',
    );
  const actorId = authority.service.subjectUserId;
  const server = await db
    .selectFrom('managed_servers as server')
    .innerJoin('user as actor', (join) => join.on('actor.id', '=', actorId))
    .selectAll('server')
    .where('server.id', '=', serverId)
    .where('server.deleted_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('actor.id', '=', eb.ref('server.owner_id')),
        eb('actor.role', '=', 'owner'),
        eb.exists(
          eb
            .selectFrom('project_members')
            .select('user_id')
            .whereRef('project_id', '=', 'server.project_id')
            .where('user_id', '=', actorId)
            .where('role', '=', 'manager'),
        ),
      ]),
    )
    .executeTakeFirst();
  if (!server) throw new DomainError('forbidden');
  return server;
}
async function credentialAudit(
  db: Kysely<Database>,
  authority: CredentialAuthority,
  action: string,
  metadata: Record<string, unknown>,
) {
  if (authority.context) return recordAudit(db, authority.context, action, metadata);
  await db
    .insertInto('audit_events')
    .values({
      id: randomUUID(),
      actor_user_id: null,
      subject_user_id: authority.service.subjectUserId,
      action,
      correlation_id: randomUUID(),
      metadata: { ...metadata, source: 'personal-primary-reconciliation' },
    })
    .execute();
}
export async function locked<T>(
  db: Kysely<Database>,
  serverId: string,
  work: (connection: Kysely<Database>) => Promise<T>,
): Promise<T> {
  parse(z.uuid(), serverId);
  return db.connection().execute(async (connection) => {
    const key = `:nickhosting:server:${serverId}`;
    const result = await sql<{
      acquired: boolean;
    }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${key},0)) as acquired`.execute(
      connection,
    );
    if (!result.rows[0]?.acquired) throw new DomainError('conflict');
    try {
      return await work(connection);
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${key},0))`.execute(
        connection,
      );
    }
  });
}
export async function dnsLocked<T>(db: Kysely<Database>, work: () => Promise<T>): Promise<T> {
  const result = await sql<{
    acquired: boolean;
  }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ':external:dns',0)) as acquired`.execute(
    db,
  );
  if (!result.rows[0]?.acquired) throw new DomainError('conflict');
  try {
    return await work();
  } finally {
    await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ':external:dns',0))`.execute(
      db,
    );
  }
}
async function sftpProvider(db: Kysely<Database>, options: ExternalServiceOptions) {
  const { values: config } = await getSettings(db, options.env);
  const key = await getSecret(db, options.codec, 'sftpgoApiKey', options.env);
  if (!config.sftpgoBaseUrl || !config.sftpgoInstanceId || !config.sftpgoDataRoot || !key)
    throw new DomainError('configuration_invalid');
  return {
    config,
    scope: fingerprint([config.sftpgoBaseUrl, config.sftpgoInstanceId, config.sftpgoDataRoot]),
    provider:
      options.sftpFactory?.(config, key) ??
      new SftpGoAdapter({
        baseURL: config.sftpgoBaseUrl,
        instanceId: config.sftpgoInstanceId,
        dataRoot: config.sftpgoDataRoot,
        auth: { apiKey: key },
      }),
  };
}
function credentialIntent(row: SftpRow, options: ExternalServiceOptions): CredentialIntent {
  try {
    const value = JSON.parse(
      options.codec.decrypt(row.envelope, credentialContext(row.id)),
    ) as CredentialIntent;
    if (
      value.version !== 1 ||
      value.request.credentialId !== row.id ||
      value.request.serverId !== row.server_id ||
      (value.context
        ? value.service !== undefined || value.context.actorUserId !== row.actor_id
        : value.service?.kind !== 'personal-primary' ||
          value.service.subjectUserId !== row.actor_id ||
          row.kind !== 'primary') ||
      (row.kind === 'primary'
        ? value.request.username !== row.primary_username || value.request.expiresAt !== 0
        : value.request.expiresAt === 0)
    )
      throw new Error();
    return value;
  } catch {
    throw new DomainError('secret_invalid');
  }
}
const publicCredential = (row: SftpRow) => ({
  id: row.id,
  serverId: row.server_id,
  actorId: row.actor_id,
  kind: row.kind,
  label: row.label,
  state: row.state,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  username: (row.provider_ref as SftpCredentialRef | null)?.username ?? row.primary_username,
});
async function saveIntent(
  db: Kysely<Database>,
  row: SftpRow,
  intent: CredentialIntent,
  options: ExternalServiceOptions,
  state: SftpRow['state'],
) {
  await db
    .updateTable('external_sftp_credentials')
    .set({
      envelope: JSON.stringify(
        options.codec.encrypt(JSON.stringify(intent), credentialContext(row.id)),
      ),
      state,
      expires_at: intent.request.expiresAt === 0 ? null : new Date(intent.request.expiresAt),
    })
    .where('id', '=', row.id)
    .execute();
}
async function runCredential(
  db: Kysely<Database>,
  row: SftpRow,
  options: ExternalServiceOptions,
): Promise<SftpRow> {
  const intent = credentialIntent(row, options);
  const { provider, scope } = await sftpProvider(db, options);
  if (scope !== intent.scope) throw new DomainError('configuration_invalid');
  if (intent.request.expiresAt !== 0 && intent.request.expiresAt <= now(options).getTime()) {
    intent.action = 'revoke';
    await saveIntent(db, row, intent, options, 'revoking');
  }
  if (intent.action !== 'revoke') {
    try {
      await authorizeCredential(db, intent, row.server_id);
    } catch (error) {
      // Revocation is driven only by an authoritative permission denial. A database
      // outage or corrupt encrypted intent must not masquerade as removed access.
      if (
        !(error instanceof DomainError) ||
        !['forbidden', 'not_found', 'unauthenticated'].includes(error.code)
      )
        throw error;
      intent.action = 'revoke';
      await db.transaction().execute(async (tx) => {
        await saveIntent(tx, row, intent, options, 'revoking');
        await credentialAudit(tx, intent, 'server.sftp.access_revoked', {
          serverId: row.server_id,
          credentialId: row.id,
          reason: 'issuer_permission_removed',
        });
      });
    }
    // A storage transition fences issuance and rotation, but cannot defer
    // removing credentials after an authoritative loss of permission.
    if (intent.action !== 'revoke') {
      await db.transaction().execute(async (tx) => {
        await lockResources(tx);
        await assertStoragePolicyIdle(tx);
      });
    }
  }
  try {
    let ref = row.provider_ref as SftpCredentialRef | null;
    if (intent.action === 'revoke') {
      ref ??= await provider.inspectCredential(intent.request);
      if (ref) {
        await db
          .updateTable('external_sftp_credentials')
          .set({ provider_ref: JSON.stringify(ref) })
          .where('id', '=', row.id)
          .execute();
        await provider.revokeCredential(ref);
      }
      intent.request.password = '';
      intent.delivered = true;
      await saveIntent(db, row, intent, options, 'revoked');
    } else {
      const server = await authorizeCredential(db, intent, row.server_id);
      if (
        server.active_operation_id ||
        server.pterodactyl_uuid !== intent.request.externalServerUuid
      )
        throw new DomainError('conflict');
      await options.verifyServer(db, row.server_id);
      const fresh = await authorizeCredential(db, intent, row.server_id);
      if (fresh.active_operation_id || fresh.pterodactyl_uuid !== intent.request.externalServerUuid)
        throw new DomainError('conflict');
      if (intent.action === 'create') ref = await provider.ensureCredential(intent.request);
      else {
        if (!ref) throw new DomainError('conflict');
        ref = await provider.rotateCredential(ref, {
          password: intent.request.password,
          expiresAt: intent.request.expiresAt,
        });
      }
      await db
        .updateTable('external_sftp_credentials')
        .set({ provider_ref: JSON.stringify(ref), state: 'active' })
        .where('id', '=', row.id)
        .execute();
    }
  } catch (error) {
    await db
      .updateTable('external_sftp_credentials')
      .set({ state: intent.action === 'revoke' ? 'revoking' : 'uncertain' })
      .where('id', '=', row.id)
      .execute();
    throw error;
  }
  return db
    .selectFrom('external_sftp_credentials')
    .selectAll()
    .where('id', '=', row.id)
    .executeTakeFirstOrThrow();
}
async function deliverCredential(
  db: Kysely<Database>,
  row: SftpRow,
  context: AuthContext,
  options: ExternalServiceOptions,
) {
  const intent = credentialIntent(row, options);
  const result = publicCredential(row);
  if (intent.delivered || row.state !== 'active') return { ...result, password: undefined };
  if (row.expires_at && row.expires_at <= now(options)) throw new DomainError('conflict');
  if (row.actor_id !== context.actorUserId) throw new DomainError('forbidden');
  await authorizeServer(
    db,
    await currentInteractiveContext(db, context, options.env ?? {}),
    row.server_id,
    'server:manage',
  );
  const password = intent.request.password;
  intent.delivered = true;
  // Do not decrypt for GET. Commit delivery before returning; explicit password
  // retrieval can recover a lost response without changing delivery idempotency.
  await saveIntent(db, row, intent, options, 'active');
  return { ...result, password };
}
export async function createSftpCredential(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  input: unknown,
  options: ExternalServiceOptions,
) {
  regular(context);
  const { credentialId, kind, label } = parse(
    z
      .object({
        credentialId: z.uuid(),
        kind: z.enum(['primary', 'auxiliary']).default('auxiliary'),
        label: z.string().trim().min(1).max(80).optional(),
      })
      .strict(),
    input,
  );
  if (kind === 'primary' && label !== undefined) throw new DomainError('validation_failed');
  return locked(db, serverId, async (connection) => {
    const verified = await currentInteractiveContext(connection, context, options.env ?? {});
    const row = await ensureCredential(
      connection,
      { context: verified },
      serverId,
      { credentialId, kind, label },
      options,
    );
    return deliverCredential(connection, row, verified, options);
  });
}
/** Shared durable issuance; caller holds the per-server advisory lock. */
async function ensureCredential(
  connection: Kysely<Database>,
  authority: CredentialAuthority,
  serverId: string,
  input: { credentialId: string; kind: 'primary' | 'auxiliary'; label?: string },
  options: ExternalServiceOptions,
) {
  const { credentialId, kind, label } = input;
  const actorId = credentialActor(authority);
  const server = await authorizeCredential(connection, authority, serverId);
  if (!server.pterodactyl_uuid || server.deleted_at || server.active_operation_id)
    throw new DomainError('conflict');
  await connection.transaction().execute(async (tx) => {
    await lockResources(tx);
    await assertStoragePolicyIdle(tx);
  });
  let row = await connection
    .selectFrom('external_sftp_credentials')
    .selectAll()
    .where('id', '=', credentialId)
    .executeTakeFirst();
  if (
    row &&
    (row.server_id !== serverId ||
      row.actor_id !== actorId ||
      row.kind !== kind ||
      row.label !== (label ?? null) ||
      row.state === 'revoked' ||
      row.state === 'revoking')
  )
    throw new DomainError('conflict');
  if (!row && kind === 'primary') {
    row = await connection
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('actor_id', '=', actorId)
      .where('kind', '=', 'primary')
      .where('state', '!=', 'revoked')
      .executeTakeFirst();
    if (row?.state === 'revoking') throw new DomainError('conflict');
  }
  if (!row) {
    const { config, scope } = await sftpProvider(connection, options);
    const existing = await connection
      .selectFrom('external_sftp_credentials')
      .select('id')
      .where('server_id', '=', serverId)
      .where('actor_id', '=', actorId)
      .where('kind', '=', 'auxiliary')
      .where('state', '!=', 'revoked')
      .execute();
    if (kind === 'auxiliary' && existing.length >= config.sftpAuxiliaryLimit)
      throw new DomainError('conflict');
    let username: string | undefined;
    if (kind === 'primary') {
      const user = await connection
        .selectFrom('user')
        .select('username')
        .where('id', '=', actorId)
        .executeTakeFirstOrThrow();
      username = `${user.username}-${serverId.slice(0, 8)}`;
      const collision = await connection
        .selectFrom('external_sftp_credentials')
        .select('id')
        .where('primary_username', '=', username)
        .where('state', '!=', 'revoked')
        .executeTakeFirst();
      if (collision) throw new DomainError('conflict');
    }
    const expiresAt =
      kind === 'primary' ? 0 : now(options).getTime() + config.sftpCredentialTtlSeconds * 1000;
    const intent: CredentialIntent = {
      version: 1,
      ...authority,
      scope,
      action: 'create',
      delivered: false,
      request: {
        serverId,
        externalServerUuid: server.pterodactyl_uuid,
        credentialId,
        ...(username ? { username } : {}),
        password: generateSftpPassword(),
        expiresAt,
        quotaBytes: serverStorageLimitBytes(server.limits.disk) ?? 0,
      },
    };
    row = await connection
      .transaction()
      .execute(async (tx) => {
        await lockResources(tx);
        await assertStoragePolicyIdle(tx);
        const inserted = await tx
          .insertInto('external_sftp_credentials')
          .values({
            id: credentialId,
            server_id: serverId,
            actor_id: actorId,
            kind,
            label: label ?? null,
            primary_username: username ?? null,
            envelope: JSON.stringify(
              options.codec.encrypt(JSON.stringify(intent), credentialContext(credentialId)),
            ),
            provider_ref: null,
            expires_at: expiresAt === 0 ? null : new Date(expiresAt),
            state: 'pending',
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await credentialAudit(tx, authority, 'server.sftp.issued', { serverId, credentialId });
        return inserted;
      })
      .catch((error: unknown) => {
        // Different servers can share the truncated UUID portion. The unique
        // reservation prevents concurrent creation from claiming the same login.
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23505'
        )
          throw new DomainError('conflict');
        throw error;
      });
  }
  if (row.state !== 'active') row = await runCredential(connection, row, options);
  return row;
}
export async function listSftpCredentials(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
) {
  await authorizeServer(db, context, serverId, 'server:manage');
  return (
    await db
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('actor_id', '=', context.actorUserId)
      .orderBy('kind', 'desc')
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute()
  ).map(publicCredential);
}
/** Explicit issuer-only disclosure of the retained encrypted password. */
export async function revealSftpCredential(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  credentialId: string,
  input: unknown,
  options: ExternalServiceOptions,
) {
  regular(context);
  parse(z.uuid(), credentialId);
  parse(z.object({}).strict(), input);
  return locked(db, serverId, async (connection) => {
    const verified = await currentInteractiveContext(connection, context, options.env ?? {});
    await authorizeServer(connection, verified, serverId, 'server:manage');
    const row = await connection
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('id', '=', credentialId)
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!row) throw new DomainError('not_found');
    if (row.actor_id !== verified.actorUserId) throw new DomainError('forbidden');
    if (row.state !== 'active' || (row.expires_at && row.expires_at <= now(options)))
      throw new DomainError('conflict');
    const intent = credentialIntent(row, options);
    if (
      !['create', 'rotate'].includes(intent.action) ||
      typeof intent.request.password !== 'string' ||
      !intent.request.password ||
      !Number.isSafeInteger(intent.request.expiresAt) ||
      intent.request.expiresAt < 0 ||
      intent.request.expiresAt !== (row.expires_at?.getTime() ?? 0)
    )
      throw new DomainError('secret_invalid');
    await recordAudit(connection, verified, 'server.sftp.password_revealed', {
      serverId,
      credentialId,
    });
    return { ...publicCredential(row), password: intent.request.password };
  });
}
export async function rotateSftpCredential(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  credentialId: string,
  input: unknown,
  options: ExternalServiceOptions,
) {
  regular(context);
  parse(z.uuid(), credentialId);
  const { rotationId } = parse(z.object({ rotationId: z.uuid() }).strict(), input);
  return locked(db, serverId, async (connection) => {
    const verified = await currentInteractiveContext(connection, context, options.env ?? {});
    const server = await authorizeServer(connection, verified, serverId, 'server:manage');
    if (server.active_operation_id) throw new DomainError('conflict');
    await connection.transaction().execute(async (tx) => {
      await lockResources(tx);
      await assertStoragePolicyIdle(tx);
    });
    let row = await connection
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('id', '=', credentialId)
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!row) throw new DomainError('not_found');
    if (row.actor_id !== context.actorUserId) throw new DomainError('forbidden');
    const intent = credentialIntent(row, options);
    if (intent.rotationId !== rotationId) {
      if (row.state !== 'active') throw new DomainError('conflict');
      const { config, scope } = await sftpProvider(connection, options);
      if (scope !== intent.scope) throw new DomainError('configuration_invalid');
      intent.action = 'rotate';
      intent.rotationId = rotationId;
      intent.delivered = false;
      intent.request.password = generateSftpPassword();
      intent.request.expiresAt =
        row.kind === 'primary'
          ? 0
          : now(options).getTime() + config.sftpCredentialTtlSeconds * 1000;
      const previous = row;
      await connection.transaction().execute(async (tx) => {
        await lockResources(tx);
        await assertStoragePolicyIdle(tx);
        await saveIntent(tx, previous, intent, options, 'pending');
        await recordAudit(tx, verified, 'server.sftp.rotated', {
          serverId,
          credentialId,
          rotationId,
        });
      });
      row = await connection
        .selectFrom('external_sftp_credentials')
        .selectAll()
        .where('id', '=', credentialId)
        .executeTakeFirstOrThrow();
    }
    if (row.state !== 'active') row = await runCredential(connection, row, options);
    return deliverCredential(connection, row, verified, options);
  });
}
/** Called after authoritative Wings readback by the storage-policy transition.
 * Keeps credential identity and one-time delivery state; never creates or rotates users.
 */
export async function reconcileServerStorageQuota(
  db: Kysely<Database>,
  serverId: string,
  diskMiB: number,
  options: ExternalServiceOptions,
  locks: { assumeServerLock?: boolean } = {},
): Promise<{ reconciled: number }> {
  const quotaBytes = serverStorageLimitBytes(diskMiB) ?? 0;
  parse(z.uuid(), serverId);
  const reconcile = async (connection: Kysely<Database>) => {
    const rows = await connection
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('state', '!=', 'revoked')
      .execute();
    if (!rows.length) return { reconciled: 0 };
    const server = await connection
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!server?.pterodactyl_uuid) throw new DomainError('not_found');
    await options.verifyServer(connection, serverId);
    const { provider, scope } = await sftpProvider(connection, options);
    let reconciled = 0;
    for (const row of rows) {
      const intent = credentialIntent(row, options);
      if (intent.scope !== scope || intent.request.externalServerUuid !== server.pterodactyl_uuid)
        throw new DomainError('configuration_invalid');
      let ref = row.provider_ref as SftpCredentialRef | null;
      if (!ref) ref = await provider.inspectCredential(intent.request);
      if (ref) {
        if (
          ref.serverId !== serverId ||
          ref.externalServerUuid !== server.pterodactyl_uuid ||
          ref.credentialId !== row.id
        )
          throw new DomainError('conflict');
        if (quotaBytes > 0 && !options.readServerDiskUsage)
          throw new DomainError('configuration_invalid');
        const usedBytes =
          quotaBytes > 0 ? await options.readServerDiskUsage?.(connection, serverId) : undefined;
        ref = await provider.updateQuota(ref, quotaBytes, usedBytes);
      } else if (row.state === 'active') {
        throw new DomainError('conflict');
      }
      // A pending creation with no provider user receives the new quota in its
      // existing encrypted intent. Its worker may create it after the policy commits.
      intent.request.quotaBytes = quotaBytes;
      await connection.transaction().execute(async (tx) => {
        await saveIntent(tx, row, intent, options, row.state);
        await tx
          .updateTable('external_sftp_credentials')
          .set({ provider_ref: ref ? JSON.stringify(ref) : null })
          .where('id', '=', row.id)
          .execute();
      });
      reconciled++;
    }
    return { reconciled };
  };
  return locks.assumeServerLock ? reconcile(db) : locked(db, serverId, reconcile);
}

async function revokeRow(db: Kysely<Database>, row: SftpRow, options: ExternalServiceOptions) {
  if (row.state === 'revoked') return row;
  const intent = credentialIntent(row, options);
  intent.action = 'revoke';
  await saveIntent(db, row, intent, options, 'revoking');
  return runCredential(
    db,
    await db
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow(),
    options,
  );
}
export async function revokeSftpCredential(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  credentialId: string,
  options: ExternalServiceOptions,
) {
  parse(z.uuid(), credentialId);
  return locked(db, serverId, async (connection) => {
    const verified = await currentInteractiveContext(connection, context, options.env ?? {});
    await authorizeServer(connection, verified, serverId, 'server:manage');
    const row = await connection
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('id', '=', credentialId)
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!row) throw new DomainError('not_found');
    if (row.actor_id !== context.actorUserId || row.kind === 'primary')
      throw new DomainError('forbidden');
    await recordAudit(connection, verified, 'server.sftp.revoked', { serverId, credentialId });
    return publicCredential(await revokeRow(connection, row, options));
  });
}

/** Internal worker hook after lifecycle authorization. Reentrant on the supplied pinned connection. */
export async function cleanupServerExternalServices(
  db: Kysely<Database>,
  serverId: string,
  options: ExternalServiceOptions,
): Promise<void> {
  await locked(db, serverId, async (connection) => {
    for (const row of await connection
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('state', '!=', 'revoked')
      .execute())
      await revokeRow(connection, row, options);
    await dnsLocked(connection, async () => {
      for (const row of await connection
        .selectFrom('dns_assignments')
        .selectAll()
        .where('server_id', '=', serverId)
        .where('state', '!=', 'deleted')
        .execute())
        await deleteDnsRow(connection, row, options);
    });
  });
}
/** Bounded periodic recovery. Failures retain durable pending/uncertain rows and are counted, never hidden. */
const reconciliationCursors = new WeakMap<
  Kysely<Database>,
  { credential: string; primary: string }
>();
export async function reconcileExternalServices(
  db: Kysely<Database>,
  options: ExternalServiceOptions,
) {
  // Scheduling only: authoritative desired access and every prepared intent are
  // durable in PostgreSQL. A restart safely rescans; cursors let later work pass
  // a repeatedly unavailable server within a running worker's bounded batches.
  const cursor = reconciliationCursors.get(db) ?? { credential: '', primary: '' };
  reconciliationCursors.set(db, cursor);
  const credentials = await db
    .selectFrom('external_sftp_credentials')
    .innerJoin('managed_servers', 'managed_servers.id', 'external_sftp_credentials.server_id')
    .innerJoin('user', 'user.id', 'external_sftp_credentials.actor_id')
    .selectAll('external_sftp_credentials')
    .where('external_sftp_credentials.state', '!=', 'revoked')
    .where((eb) =>
      eb.or([
        eb('external_sftp_credentials.state', '!=', 'active'),
        eb('external_sftp_credentials.expires_at', '<=', now(options)),
        eb('managed_servers.deleted_at', 'is not', null),
        eb.and([
          eb('user.role', '!=', 'owner'),
          eb('external_sftp_credentials.actor_id', '!=', eb.ref('managed_servers.owner_id')),
          eb.not(
            eb.exists(
              eb
                .selectFrom('project_members')
                .select('project_members.user_id')
                .whereRef('project_members.project_id', '=', 'managed_servers.project_id')
                .whereRef('project_members.user_id', '=', 'external_sftp_credentials.actor_id')
                .where('project_members.role', '=', 'manager'),
            ),
          ),
        ]),
      ]),
    )
    .orderBy(sql<boolean>`external_sftp_credentials.id::text > ${cursor.credential}`, 'desc')
    .orderBy('external_sftp_credentials.id')
    .limit(100)
    .execute();
  const assignments = await db
    .selectFrom('dns_assignments')
    .selectAll()
    .where('state', 'not in', ['active', 'deleted'])
    .orderBy('updated_at')
    .limit(100)
    .execute();
  let recovered = 0,
    failed = 0;
  for (const row of credentials) {
    try {
      await locked(db, row.server_id, async (connection) => {
        const current = await connection
          .selectFrom('external_sftp_credentials')
          .selectAll()
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow();
        if (current.state !== 'revoked') await runCredential(connection, current, options);
      });
      recovered++;
    } catch {
      failed++;
    } finally {
      cursor.credential = row.id;
    }
  }
  // Explicitly authorized subjects, not a synthetic interactive Owner. Global
  // Owners have server:manage; project viewers/operators and unrelated users do not.
  const primary = await db
    .selectFrom('managed_servers as server')
    .crossJoin('user as actor')
    .select(['server.id as server_id', 'actor.id as actor_id'])
    .select(sql<string>`server.id::text || ':' || actor.id`.as('cursor_key'))
    .where('server.deleted_at', 'is', null)
    .where('server.pterodactyl_uuid', 'is not', null)
    .where('server.active_operation_id', 'is', null)
    .where((eb) =>
      eb.or([
        eb('actor.id', '=', eb.ref('server.owner_id')),
        eb('actor.role', '=', 'owner'),
        eb.exists(
          eb
            .selectFrom('project_members')
            .select('user_id')
            .whereRef('project_id', '=', 'server.project_id')
            .whereRef('user_id', '=', 'actor.id')
            .where('role', '=', 'manager'),
        ),
      ]),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('external_sftp_credentials as credential')
            .select('credential.id')
            .whereRef('credential.server_id', '=', 'server.id')
            .whereRef('credential.actor_id', '=', 'actor.id')
            .where('credential.kind', '=', 'primary')
            .where('credential.state', '!=', 'revoked'),
        ),
      ),
    )
    .orderBy(sql<boolean>`(server.id::text || ':' || actor.id) > ${cursor.primary}`, 'desc')
    .orderBy('server.id')
    .orderBy('actor.id')
    .limit(100)
    .execute();
  for (const candidate of primary) {
    try {
      await locked(db, candidate.server_id, (connection) =>
        ensureCredential(
          connection,
          { service: { kind: 'personal-primary', subjectUserId: candidate.actor_id } },
          candidate.server_id,
          { credentialId: randomUUID(), kind: 'primary' },
          options,
        ),
      );
      recovered++;
    } catch {
      failed++;
    } finally {
      cursor.primary = candidate.cursor_key;
    }
  }
  for (const row of assignments) {
    try {
      await locked(db, row.server_id, (connection) =>
        dnsLocked(connection, async () => {
          const current = await connection
            .selectFrom('dns_assignments')
            .selectAll()
            .where('id', '=', row.id)
            .executeTakeFirstOrThrow();
          if (current.state !== 'deleted') await runDns(connection, current, options);
        }),
      );
      recovered++;
    } catch {
      failed++;
    }
  }
  const automatic = await reconcileAutomaticDns(db, options);
  return { recovered: recovered + automatic.recovered, failed: failed + automatic.failed };
}
