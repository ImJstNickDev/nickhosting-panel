import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  type AuthContext,
  assertAuthContext,
  DomainError,
  type PlatformConfig,
  type SecretCodec,
} from '@nickhosting/core';
import { type Database, getSecret, getSettings, recordAudit } from '@nickhosting/database';
import {
  CloudflareDnsProvider,
  type ConnectionPlan,
  type DnsOwnership,
  generateSftpPassword,
  type OwnedDnsRecord,
  planConnection,
  type SftpCredentialRef,
  type SftpCredentialRequest,
  SftpGoAdapter,
} from '@nickhosting/external-services';
import { gameManifestSchema } from '@nickhosting/game-sdk';
import { type Kysely, type Selectable, sql } from 'kysely';
import { z } from 'zod';
import type { Environment } from './admission.js';
import { currentInteractiveContext } from './interactive-context.js';
import { authorizeServer, parse } from './registry.js';

type SftpRow = Selectable<Database['external_sftp_credentials']>;
type DnsRow = Selectable<Database['dns_assignments']>;
type SftpProvider = Pick<
  SftpGoAdapter,
  'ensureCredential' | 'inspectCredential' | 'rotateCredential' | 'revokeCredential'
>;
type DnsProvider = Pick<CloudflareDnsProvider, 'plan' | 'apply' | 'inspectOwned'>;
export interface ExternalServiceOptions {
  codec: SecretCodec;
  env?: Environment;
  /** The runtime corroborates the registered server against the Pterodactyl adapter before new access. */
  verifyServer: (db: Kysely<Database>, serverId: string) => Promise<void>;
  sftpFactory?: (config: PlatformConfig, apiKey: string) => SftpProvider;
  dnsFactory?: (config: PlatformConfig, apiToken: string) => DnsProvider;
  now?: () => Date;
}
interface CredentialIntent {
  version: 1;
  context: AuthContext;
  request: SftpCredentialRequest;
  scope: string;
  action: 'create' | 'rotate' | 'revoke';
  rotationId?: string;
  delivered: boolean;
}
interface DnsIntent {
  version: 1;
  context: AuthContext;
  zoneId: string;
  instanceId: string;
  scope: string;
  connection: ConnectionPlan;
  action: 'apply' | 'delete';
}
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
async function locked<T>(
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
async function dnsLocked<T>(db: Kysely<Database>, work: () => Promise<T>): Promise<T> {
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
async function dnsProvider(db: Kysely<Database>, options: ExternalServiceOptions) {
  const { values: config } = await getSettings(db, options.env);
  const key = await getSecret(db, options.codec, 'cloudflareApiToken', options.env);
  if (!config.cloudflareZoneId || !config.dnsInstanceId || !key)
    throw new DomainError('configuration_invalid');
  return {
    config,
    scope: fingerprint([config.cloudflareZoneId, config.dnsInstanceId]),
    provider:
      options.dnsFactory?.(config, key) ??
      new CloudflareDnsProvider({ instanceId: config.dnsInstanceId, apiToken: key }),
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
      value.context.actorUserId !== row.actor_id
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
  state: row.state,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  username: (row.provider_ref as SftpCredentialRef | null)?.username ?? null,
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
      expires_at: new Date(intent.request.expiresAt),
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
  if (intent.request.expiresAt <= now(options).getTime()) {
    intent.action = 'revoke';
    await saveIntent(db, row, intent, options, 'revoking');
  }
  if (intent.action !== 'revoke') {
    try {
      await authorizeServer(
        db,
        await currentContext(db, intent.context),
        row.server_id,
        'server:manage',
      );
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
        await recordAudit(tx, intent.context, 'server.sftp.access_revoked', {
          serverId: row.server_id,
          credentialId: row.id,
          reason: 'issuer_permission_removed',
        });
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
      const context = await currentContext(db, intent.context);
      await authorizeServer(db, context, row.server_id, 'server:manage');
      await options.verifyServer(db, row.server_id);
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
  if (row.expires_at <= now(options)) throw new DomainError('conflict');
  if (row.actor_id !== context.actorUserId) throw new DomainError('forbidden');
  await authorizeServer(
    db,
    await currentInteractiveContext(db, context, options.env ?? {}),
    row.server_id,
    'server:manage',
  );
  const password = intent.request.password;
  intent.delivered = true;
  // Do not decrypt for GET. Commit delivery before returning; lost HTTP responses require rotation.
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
  const { credentialId } = parse(z.object({ credentialId: z.uuid() }).strict(), input);
  return locked(db, serverId, async (connection) => {
    const verified = await currentInteractiveContext(connection, context, options.env ?? {});
    const server = await authorizeServer(connection, verified, serverId, 'server:manage');
    if (!server.pterodactyl_uuid || server.deleted_at || server.active_operation_id)
      throw new DomainError('conflict');
    let row = await connection
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('id', '=', credentialId)
      .executeTakeFirst();
    if (
      row &&
      (row.server_id !== serverId ||
        row.actor_id !== context.actorUserId ||
        row.state === 'revoked' ||
        row.state === 'revoking')
    )
      throw new DomainError('conflict');
    if (!row) {
      const existing = await connection
        .selectFrom('external_sftp_credentials')
        .select('id')
        .where('server_id', '=', serverId)
        .where('state', '!=', 'revoked')
        .execute();
      if (existing.length >= 8) throw new DomainError('conflict');
      const { config, scope } = await sftpProvider(connection, options);
      const expiresAt = now(options).getTime() + config.sftpCredentialTtlSeconds * 1000;
      const intent: CredentialIntent = {
        version: 1,
        context: verified,
        scope,
        action: 'create',
        delivered: false,
        request: {
          serverId,
          externalServerUuid: server.pterodactyl_uuid,
          credentialId,
          password: generateSftpPassword(),
          expiresAt,
          quotaBytes: server.limits.disk * 1_048_576,
        },
      };
      row = await connection.transaction().execute(async (tx) => {
        const inserted = await tx
          .insertInto('external_sftp_credentials')
          .values({
            id: credentialId,
            server_id: serverId,
            actor_id: context.actorUserId,
            envelope: JSON.stringify(
              options.codec.encrypt(JSON.stringify(intent), credentialContext(credentialId)),
            ),
            provider_ref: null,
            expires_at: new Date(expiresAt),
            state: 'pending',
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await recordAudit(tx, verified, 'server.sftp.issued', { serverId, credentialId });
        return inserted;
      });
    }
    if (row.state !== 'active') row = await runCredential(connection, row, options);
    return deliverCredential(connection, row, verified, options);
  });
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
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute()
  ).map(publicCredential);
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
      intent.request.expiresAt = now(options).getTime() + config.sftpCredentialTtlSeconds * 1000;
      const previous = row;
      await connection.transaction().execute(async (tx) => {
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
    await recordAudit(connection, verified, 'server.sftp.revoked', { serverId, credentialId });
    return publicCredential(await revokeRow(connection, row, options));
  });
}

const dnsRequest = z
  .object({
    subdomain: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
      .optional(),
    portRole: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .optional(),
  })
  .strict();
async function connectionPlan(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  input: unknown,
  options: ExternalServiceOptions,
) {
  const request = parse(dnsRequest, input);
  const server = await authorizeServer(db, context, serverId, 'server:manage');
  const mapping = await db
    .selectFrom('runtime_egg_mappings')
    .select('game_id')
    .where('id', '=', server.mapping_id)
    .executeTakeFirstOrThrow();
  const game = await db
    .selectFrom('game_integrations')
    .select('manifest')
    .where('id', '=', mapping.game_id)
    .executeTakeFirstOrThrow();
  const manifest = parse(gameManifestSchema, game.manifest);
  const allocations = await db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', serverId)
    .execute();
  const allocation = request.portRole
    ? allocations.find((entry) => entry.role === request.portRole)
    : allocations.find((entry) => entry.is_primary);
  if (!allocation || !manifest.ports.some((entry) => entry.role === allocation.role))
    throw new DomainError('configuration_invalid');
  const { values: config } = await getSettings(db, options.env);
  const configured = (key: string): string => {
    const value = (config as unknown as Record<string, unknown>)[key];
    if (typeof value !== 'string' || !value) throw new DomainError('configuration_invalid');
    return value;
  };
  if (manifest.connection.mode === 'static-host-port') {
    if (request.subdomain) throw new DomainError('validation_failed');
    return planConnection({
      mode: 'static-host-port',
      hostname: configured(manifest.connection.hostnameSettingKey),
      port: allocation.port,
    });
  }
  if (!request.subdomain || !config.dnsTarget) throw new DomainError('configuration_invalid');
  if (manifest.connection.srv && !allocation.protocols.includes(manifest.connection.srv.proto))
    throw new DomainError('configuration_invalid');
  return planConnection({
    mode: 'custom-subdomain',
    zoneName: configured(manifest.connection.zoneSettingKey),
    subdomain: request.subdomain,
    port: allocation.port,
    target: {
      type: isIP(config.dnsTarget) === 4 ? 'A' : isIP(config.dnsTarget) === 6 ? 'AAAA' : 'CNAME',
      content: config.dnsTarget,
    },
    srv: manifest.connection.srv
      ? { service: manifest.connection.srv.service, protocol: manifest.connection.srv.proto }
      : undefined,
  });
}
export async function previewServerDns(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  input: unknown,
  options: ExternalServiceOptions,
) {
  return connectionPlan(db, context, serverId, input, options);
}
function publicDns(row: DnsRow) {
  const intent = row.plan as DnsIntent;
  return {
    id: row.id,
    serverId: row.server_id,
    state: row.state,
    connection: intent.connection,
    updatedAt: row.updated_at,
  };
}
export async function listServerDns(db: Kysely<Database>, context: AuthContext, serverId: string) {
  await authorizeServer(db, context, serverId, 'server:read');
  return (
    await db
      .selectFrom('dns_assignments')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('state', '!=', 'deleted')
      .execute()
  ).map(publicDns);
}
async function runDns(
  db: Kysely<Database>,
  row: DnsRow,
  options: ExternalServiceOptions,
): Promise<DnsRow> {
  const intent = row.plan as DnsIntent;
  const { provider, scope } = await dnsProvider(db, options);
  if (intent.version !== 1 || intent.scope !== scope)
    throw new DomainError('configuration_invalid');
  const ownership: DnsOwnership = {
    instanceId: intent.instanceId,
    serverId: row.server_id,
    assignmentId: row.ownership_token,
  };
  let ledger = row.ledger as OwnedDnsRecord[];
  const persist = async () => {
    await db
      .updateTable('dns_assignments')
      .set({ ledger: JSON.stringify(ledger), updated_at: now(options) })
      .where('id', '=', row.id)
      .execute();
  };
  const callbacks = {
    onRecordCreated: async (entry: OwnedDnsRecord) => {
      ledger = ledger.filter(
        (old) =>
          old.id !== entry.id &&
          !(old.record.name === entry.record.name && old.record.type === entry.record.type),
      );
      ledger.push(entry);
      await persist();
    },
    onRecordDeleted: async (entry: OwnedDnsRecord) => {
      ledger = ledger.filter((old) => old.id !== entry.id);
      await persist();
    },
  };
  try {
    if (intent.action === 'apply') {
      await authorizeServer(
        db,
        await currentContext(db, intent.context),
        row.server_id,
        'server:manage',
      );
      await options.verifyServer(db, row.server_id);
      const changes = await provider.plan({
        zoneId: intent.zoneId,
        ownership,
        desired: intent.connection.records,
        ledger,
      });
      await provider.apply(changes, callbacks);
      const stale = ledger.filter(
        (entry) =>
          !intent.connection.records.some(
            (desired) => desired.name === entry.record.name && desired.type === entry.record.type,
          ),
      );
      await provider.apply(
        stale.map((previous) => ({ action: 'delete', previous, record: previous.record })),
        callbacks,
      );
      await db
        .updateTable('dns_assignments')
        .set({ state: 'active', updated_at: now(options) })
        .where('id', '=', row.id)
        .execute();
    } else {
      // Recover a create whose response was lost without ever creating missing records to delete them.
      for (const recovered of await provider.inspectOwned({
        zoneId: intent.zoneId,
        ownership,
        desired: intent.connection.records,
      })) {
        if (!ledger.some((entry) => entry.id === recovered.id)) {
          ledger.push(recovered);
          await persist();
        }
      }
      await provider.apply(
        ledger.map((previous) => ({ action: 'delete', previous, record: previous.record })),
        callbacks,
      );
      await db
        .updateTable('dns_assignments')
        .set({ state: 'deleted', hostname: `deleted:${row.id}`, updated_at: now(options) })
        .where('id', '=', row.id)
        .execute();
    }
  } catch (error) {
    await db
      .updateTable('dns_assignments')
      .set({
        state: intent.action === 'delete' ? 'deleting' : 'uncertain',
        updated_at: now(options),
      })
      .where('id', '=', row.id)
      .execute();
    throw error;
  }
  return db
    .selectFrom('dns_assignments')
    .selectAll()
    .where('id', '=', row.id)
    .executeTakeFirstOrThrow();
}
export async function assignServerDns(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  input: unknown,
  options: ExternalServiceOptions,
) {
  regular(context);
  const value = parse(dnsRequest.extend({ assignmentId: z.uuid() }), input);
  return locked(db, serverId, (connection) =>
    dnsLocked(connection, async () => {
      const verified = await currentInteractiveContext(connection, context, options.env ?? {});
      const server = await authorizeServer(connection, verified, serverId, 'server:manage');
      if (server.active_operation_id || !server.pterodactyl_uuid) throw new DomainError('conflict');
      const plan = await connectionPlan(
        connection,
        verified,
        serverId,
        { subdomain: value.subdomain, portRole: value.portRole },
        options,
      );
      if (!plan.records.length)
        return { id: null, serverId, state: 'static' as const, connection: plan };
      let row = await connection
        .selectFrom('dns_assignments')
        .selectAll()
        .where('id', '=', value.assignmentId)
        .executeTakeFirst();
      if (row) {
        const old = row.plan as DnsIntent;
        if (
          row.server_id !== serverId ||
          row.state === 'deleted' ||
          row.state === 'deleting' ||
          old.context.actorUserId !== context.actorUserId ||
          fingerprint(old.connection) !== fingerprint(plan)
        )
          throw new DomainError('conflict');
      } else {
        const occupied = await connection
          .selectFrom('dns_assignments')
          .select('id')
          .where('hostname', '=', plan.hostname)
          .executeTakeFirst();
        if (occupied) throw new DomainError('conflict');
        const { config, scope } = await dnsProvider(connection, options);
        if (!config.cloudflareZoneId || !config.dnsInstanceId)
          throw new DomainError('configuration_invalid');
        const intent: DnsIntent = {
          version: 1,
          context: verified,
          zoneId: config.cloudflareZoneId,
          instanceId: config.dnsInstanceId,
          scope,
          connection: plan,
          action: 'apply',
        };
        row = await connection.transaction().execute(async (tx) => {
          const inserted = await tx
            .insertInto('dns_assignments')
            .values({
              id: value.assignmentId,
              server_id: serverId,
              hostname: plan.hostname,
              ownership_token: randomUUID(),
              plan: JSON.stringify(intent),
              ledger: '[]',
              state: 'pending',
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAudit(tx, verified, 'server.dns.assigned', {
            serverId,
            assignmentId: value.assignmentId,
          });
          return inserted;
        });
      }
      if (row.state !== 'active') row = await runDns(connection, row, options);
      return publicDns(row);
    }),
  );
}
export async function updateServerDns(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  assignmentId: string,
  input: unknown,
  options: ExternalServiceOptions,
) {
  regular(context);
  parse(z.uuid(), assignmentId);
  return locked(db, serverId, (connection) =>
    dnsLocked(connection, async () => {
      const verified = await currentInteractiveContext(connection, context, options.env ?? {});
      const server = await authorizeServer(connection, verified, serverId, 'server:manage');
      if (server.active_operation_id) throw new DomainError('conflict');
      const row = await connection
        .selectFrom('dns_assignments')
        .selectAll()
        .where('id', '=', assignmentId)
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      if (!row || row.state === 'deleted') throw new DomainError('not_found');
      if (row.state !== 'active') throw new DomainError('conflict');
      const plan = await connectionPlan(connection, verified, serverId, input, options);
      if (!plan.records.length) throw new DomainError('conflict');
      if (
        await connection
          .selectFrom('dns_assignments')
          .select('id')
          .where('hostname', '=', plan.hostname)
          .where('id', '!=', assignmentId)
          .executeTakeFirst()
      )
        throw new DomainError('conflict');
      const intent: DnsIntent = {
        ...(row.plan as DnsIntent),
        context: verified,
        connection: plan,
        action: 'apply',
      };
      await connection.transaction().execute(async (tx) => {
        await tx
          .updateTable('dns_assignments')
          .set({
            hostname: plan.hostname,
            plan: JSON.stringify(intent),
            state: 'pending',
            updated_at: now(options),
          })
          .where('id', '=', assignmentId)
          .execute();
        await recordAudit(tx, verified, 'server.dns.updated', { serverId, assignmentId });
      });
      return publicDns(
        await runDns(
          connection,
          await connection
            .selectFrom('dns_assignments')
            .selectAll()
            .where('id', '=', assignmentId)
            .executeTakeFirstOrThrow(),
          options,
        ),
      );
    }),
  );
}
async function deleteDnsRow(db: Kysely<Database>, row: DnsRow, options: ExternalServiceOptions) {
  if (row.state === 'deleted') return row;
  const intent: DnsIntent = { ...(row.plan as DnsIntent), action: 'delete' };
  await db
    .updateTable('dns_assignments')
    .set({ plan: JSON.stringify(intent), state: 'deleting' })
    .where('id', '=', row.id)
    .execute();
  return runDns(
    db,
    await db
      .selectFrom('dns_assignments')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow(),
    options,
  );
}
export async function deleteServerDns(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  assignmentId: string,
  options: ExternalServiceOptions,
) {
  parse(z.uuid(), assignmentId);
  return locked(db, serverId, (connection) =>
    dnsLocked(connection, async () => {
      const verified = await currentInteractiveContext(connection, context, options.env ?? {});
      await authorizeServer(connection, verified, serverId, 'server:manage');
      const row = await connection
        .selectFrom('dns_assignments')
        .selectAll()
        .where('id', '=', assignmentId)
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      if (!row) throw new DomainError('not_found');
      await recordAudit(connection, verified, 'server.dns.deleted', { serverId, assignmentId });
      return publicDns(await deleteDnsRow(connection, row, options));
    }),
  );
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
export async function reconcileExternalServices(
  db: Kysely<Database>,
  options: ExternalServiceOptions,
) {
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
    .orderBy('external_sftp_credentials.created_at')
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
  return { recovered, failed };
}
