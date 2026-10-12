import { randomUUID } from 'node:crypto';
import { DomainError, type SecretCodec } from '@nickhosting/core';
import { type Database, getSecret, getSettings } from '@nickhosting/database';
import { createNickHostingBridge } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import type { UploadTiming } from './upload-timing.js';

type Environment = Readonly<Record<string, string | undefined>>;
const normalize = (url: string) => url.replace(/\/$/, '');
const context = (userId: string, instanceId: string, operationId: string) =>
  `provider-client:${instanceId}:${userId}:${operationId}`;

/** Bounded recovery loop. Auth transactions only enqueue; remote requests use durable identities. */
export async function ensureProviderAccounts(
  db: Kysely<Database>,
  codec: SecretCodec,
  env: Environment = {},
  options: Pick<Parameters<typeof createNickHostingBridge>[0], 'fetcher' | 'coordinator'> & {
    batchSize?: number;
  } = {},
) {
  const result = { ready: 0, failed: 0 };
  const exists = await sql<{
    relation: string | null;
  }>`select to_regclass(current_schema() || '.provider_accounts')::text as relation`.execute(db);
  if (!exists.rows[0]?.relation) return result;
  const { values } = await getSettings(db, env);
  if (!values.pterodactylBaseUrl) return result;
  const providerUrl = normalize(values.pterodactylBaseUrl);
  const feed = await db
    .selectFrom('provider_change_feeds')
    .selectAll()
    .where('provider_url', '=', providerUrl)
    .where('enabled', '=', true)
    .executeTakeFirst();
  const applicationKey = await getSecret(db, codec, 'pterodactylApplicationKey', env);
  if (!feed || !applicationKey) return result;
  const bridge = createNickHostingBridge({ baseURL: providerUrl, applicationKey, ...options });
  const count = Math.max(1, Math.min(options.batchSize ?? 5, 20));
  for (let index = 0; index < count; index++) {
    const claimed = await db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('provider_accounts')
        .selectAll()
        .where('status', '!=', 'ready')
        .where('retry_at', '<=', new Date())
        .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<', new Date())]))
        .where((eb) =>
          eb.or([eb('instance_id', 'is', null), eb('instance_id', '=', feed.instance_id)]),
        )
        .orderBy('retry_at')
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return;
      const token = randomUUID();
      return tx
        .updateTable('provider_accounts')
        .set({
          instance_id: feed.instance_id,
          provider_url: providerUrl,
          lease_token: token,
          lease_until: new Date(Date.now() + 120_000),
          status: 'provisioning',
          attempts: row.attempts + 1,
          updated_at: new Date(),
        })
        .where('user_id', '=', row.user_id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    if (!claimed) break;
    try {
      const identity = await bridge.provisionUser(feed.instance_id, claimed.user_id);
      if (
        identity.externalId !== `nh:${feed.instance_id}:${claimed.user_id}` ||
        (claimed.provider_id !== null &&
          (identity.providerId !== claimed.provider_id ||
            identity.providerUuid !== claimed.provider_uuid ||
            identity.externalId !== claimed.external_id))
      )
        throw new DomainError('conflict');
      const identitySaved = await db
        .updateTable('provider_accounts')
        .set({
          provider_id: identity.providerId,
          provider_uuid: identity.providerUuid,
          external_id: identity.externalId,
        })
        .where('user_id', '=', claimed.user_id)
        .where('lease_token', '=', claimed.lease_token)
        .executeTakeFirst();
      if (!identitySaved.numUpdatedRows) continue;
      const key = await bridge.issueKey(
        feed.instance_id,
        claimed.user_id,
        claimed.key_operation_id,
      );
      if (key.operationId !== claimed.key_operation_id) throw new DomainError('conflict');
      const envelope = codec.encrypt(
        key.key,
        context(claimed.user_id, feed.instance_id, claimed.key_operation_id),
      );
      const changed = await db
        .updateTable('provider_accounts')
        .set({
          provider_id: identity.providerId,
          provider_uuid: identity.providerUuid,
          external_id: identity.externalId,
          key_identifier: key.identifier,
          key_envelope: envelope,
          status: 'ready',
          last_error: null,
          lease_token: null,
          lease_until: null,
          updated_at: new Date(),
        })
        .where('user_id', '=', claimed.user_id)
        .where('lease_token', '=', claimed.lease_token)
        .executeTakeFirst();
      if (changed.numUpdatedRows) result.ready++;
    } catch {
      // Never persist upstream payloads: these can contain credentials or personal data.
      await db
        .updateTable('provider_accounts')
        .set({
          status: 'failed',
          last_error: 'provider_enrollment_failed',
          retry_at: new Date(
            Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(claimed.attempts, 6)),
          ),
          lease_token: null,
          lease_until: null,
          updated_at: new Date(),
        })
        .where('user_id', '=', claimed.user_id)
        .where('lease_token', '=', claimed.lease_token)
        .execute();
      result.failed++;
    }
  }
  return result;
}

/** Internal-only credential resolver. The caller must authorize the actor separately. */
export async function resolveProviderCredential(
  db: Kysely<Database>,
  codec: SecretCodec,
  target: { userId?: string; serverId?: string },
  providerUrl: string,
  timing?: Pick<UploadTiming, 'measure' | 'measureSync'>,
) {
  const timed = <T>(name: string, work: () => Promise<T>) =>
    timing ? timing.measure(name, work) : work();
  if (Boolean(target.userId) === Boolean(target.serverId))
    throw new DomainError('validation_failed');
  const targetServerId = target.serverId;
  const server = targetServerId
    ? await timed('url.ownerRead', () =>
        db
          .selectFrom('managed_servers')
          .select(['owner_id', 'provider_user_id'])
          .where('id', '=', targetServerId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst(),
      )
    : undefined;
  if (target.serverId && !server) throw new DomainError('not_found');
  const userId = server?.owner_id ?? target.userId;
  if (!userId) throw new DomainError('validation_failed');
  const row = await timed('url.accountRead', () =>
    db
      .selectFrom('provider_accounts as a')
      .innerJoin('provider_change_feeds as f', 'f.instance_id', 'a.instance_id')
      .selectAll('a')
      .where('a.user_id', '=', userId)
      .where('a.provider_url', '=', normalize(providerUrl))
      .where('f.provider_url', '=', normalize(providerUrl))
      .where('f.enabled', '=', true)
      .where('a.status', '=', 'ready')
      .executeTakeFirst(),
  );
  if (
    !row?.instance_id ||
    !row.provider_id ||
    !row.provider_uuid ||
    !row.external_id ||
    !row.key_envelope ||
    !row.key_identifier ||
    (server && server.provider_user_id !== row.provider_id)
  )
    throw new DomainError('integration_unavailable');
  const envelope = row.key_envelope;
  const encryptionContext = context(userId, row.instance_id, row.key_operation_id);
  const decrypt = () => codec.decrypt(envelope, encryptionContext);
  return {
    userId,
    providerUserId: row.provider_id,
    providerUserUuid: row.provider_uuid,
    externalId: row.external_id,
    clientApiKey: timing ? timing.measureSync('url.decrypt', decrypt) : decrypt(),
    credentialRevision: `${row.key_operation_id}:${row.key_identifier}`,
  };
}
