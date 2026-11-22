import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { type ProviderChange, providerChangeSchema } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';

const MAX_HEALTH_AGE = 30_000;
const MAX_SNAPSHOT_AGE = 120_000;
const fresh = (date: Date, now: Date, age: number) =>
  now.getTime() - date.getTime() >= 0 && now.getTime() - date.getTime() <= age;

export async function registerProviderFeed(
  db: Kysely<Database>,
  input: { instanceId: string; providerUrl: string; callbackUrl: string },
) {
  const url = new URL(input.providerUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new DomainError('configuration_invalid');
  const callback = new URL(input.callbackUrl);
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash)
    throw new DomainError('configuration_invalid');
  const normalized = url.href.replace(/\/$/, '');
  await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('provider_change_feeds')
      .selectAll()
      .where('instance_id', '=', input.instanceId)
      .forUpdate()
      .executeTakeFirst();
    if (
      existing &&
      (existing.provider_url !== normalized || existing.callback_url !== callback.href)
    )
      throw new DomainError('configuration_invalid');
    await trx
      .insertInto('provider_change_feeds')
      .values({
        instance_id: z.string().uuid().parse(input.instanceId),
        provider_url: normalized,
        callback_url: callback.href,
        healthy_at: null,
        generation: '0',
        enabled: true,
      })
      .onConflict((c) =>
        c.column('instance_id').doUpdateSet({
          healthy_at: null,
          generation: sql`provider_change_feeds.generation + 1`,
          enabled: true,
        }),
      )
      .execute();
    if (existing) await clearScopeHealth(trx, input.instanceId);
  });
}

async function managedIdentity(db: Kysely<Database>, serverId: string) {
  return db
    .selectFrom('managed_servers as s')
    .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
    .select([
      's.id',
      's.owner_id',
      's.provider_user_id',
      's.pterodactyl_id',
      's.pterodactyl_uuid',
      's.pterodactyl_identifier',
      's.external_id',
      'n.pterodactyl_node_id',
    ])
    .where('s.id', '=', serverId)
    .where('s.deleted_at', 'is', null)
    .executeTakeFirst();
}
function matches(
  row:
    | Pick<
        NonNullable<Awaited<ReturnType<typeof managedIdentity>>>,
        | 'pterodactyl_id'
        | 'pterodactyl_uuid'
        | 'pterodactyl_identifier'
        | 'external_id'
        | 'pterodactyl_node_id'
      >
    | undefined,
  identity: ProviderChange['server'],
) {
  return (
    row !== undefined &&
    row.pterodactyl_id === identity.providerId &&
    row.pterodactyl_uuid === identity.providerUuid &&
    row.pterodactyl_identifier === identity.identifier &&
    row.external_id === identity.externalId &&
    row.pterodactyl_node_id === identity.nodeId
  );
}

/** An older global drain cannot corroborate a new projection. The same generation
 * also fences a health response whose provider read is still in flight. */
function withdrawGlobalHealth(db: Kysely<Database>, instanceId: string) {
  return db
    .updateTable('provider_change_feeds')
    .set({ healthy_at: null, generation: sql`generation + 1` })
    .where('instance_id', '=', instanceId)
    .execute();
}

/** Only call with an authenticated adapter snapshot after explicit managed-server linking. */
export async function linkProviderFeedServer(
  db: Kysely<Database>,
  instanceId: string,
  serverId: string,
  value: unknown,
  now = new Date(),
  owner?: { ownerId: string; providerUserId: number | null },
) {
  const event = providerChangeSchema.parse(value);
  if (
    event.instanceId !== instanceId ||
    event.type !== 'snapshot' ||
    !fresh(new Date(event.occurredAt), now, MAX_SNAPSHOT_AGE)
  )
    throw new DomainError('configuration_invalid');
  await db.transaction().execute(async (trx) => {
    const feed = await trx
      .selectFrom('provider_change_feeds')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .forUpdate()
      .executeTakeFirst();
    const current = await managedIdentity(trx, serverId);
    if (
      !feed?.enabled ||
      !matches(current, event.server) ||
      (owner &&
        (current?.owner_id !== owner.ownerId || current.provider_user_id !== owner.providerUserId))
    )
      throw new DomainError('provenance_mismatch');
    const existing = await trx
      .selectFrom('provider_server_projections')
      .selectAll()
      .where('server_id', '=', serverId)
      .forUpdate()
      .executeTakeFirst();
    if (
      existing &&
      (existing.instance_id !== instanceId ||
        !isDeepStrictEqual(providerChangeSchema.parse(existing.payload).server, event.server))
    )
      throw new DomainError('provenance_mismatch');
    if (existing?.identity_invalidated) throw new DomainError('provenance_mismatch');
    if (existing && BigInt(existing.revision) > BigInt(event.revision)) return;
    await trx
      .insertInto('provider_server_projections')
      .values({
        server_id: serverId,
        instance_id: instanceId,
        revision: String(event.revision),
        payload: event,
        synchronized_at: new Date(event.occurredAt),
        valid: true,
        identity_invalidated: false,
      })
      .onConflict((c) =>
        c.column('server_id').doUpdateSet({
          scope_healthy_at: null,
          revision: String(event.revision),
          payload: event,
          synchronized_at: new Date(event.occurredAt),
          valid: true,
        }),
      )
      .execute();
    await withdrawGlobalHealth(trx, instanceId);
  });
}

/** Refresh existing links only. Receiver transactions take the same feed lock first;
 * a newer delivery during provider I/O wins, including over an omitted batch row. */
export async function refreshLinkedProviderSnapshots(
  db: Kysely<Database>,
  instanceId: string,
  targets: { id: string; providerUuid: string; revision: string }[],
  snapshots: ProviderChange[],
  now = new Date(),
) {
  const requested = new Map(targets.map((target) => [target.id, target]));
  const received = new Map(snapshots.map((snapshot) => [snapshot.server.providerUuid, snapshot]));
  const apply = async (tx: Kysely<Database>) => {
    const feed = await tx
      .selectFrom('provider_change_feeds')
      .select('enabled')
      .where('instance_id', '=', instanceId)
      .forUpdate()
      .executeTakeFirst();
    if (!feed?.enabled) return;
    const rows = await tx
      .selectFrom('provider_server_projections as p')
      .innerJoin('managed_servers as s', 's.id', 'p.server_id')
      .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
      .select([
        's.id',
        's.pterodactyl_id',
        's.pterodactyl_uuid',
        's.pterodactyl_identifier',
        's.external_id',
        'n.pterodactyl_node_id',
        'p.revision',
        'p.valid',
        'p.payload',
      ])
      .where('p.instance_id', '=', instanceId)
      .where('p.server_id', 'in', [...requested.keys()])
      .where('s.deleted_at', 'is', null)
      .where('p.identity_invalidated', '=', false)
      .forUpdate('p')
      .execute();
    const updates = [];
    for (const row of rows) {
      const target = requested.get(row.id);
      if (!target) continue;
      const event = received.get(target.providerUuid);
      if (event && BigInt(event.revision) < BigInt(row.revision)) continue;
      const previous = providerChangeSchema.safeParse(row.payload);
      if (
        !event ||
        !previous.success ||
        event.instanceId !== instanceId ||
        !matches(row, event.server) ||
        !isDeepStrictEqual(previous.data.server, event.server) ||
        !fresh(new Date(event.occurredAt), now, MAX_SNAPSHOT_AGE) ||
        event.type === 'limits.updated'
      ) {
        if (row.valid && row.revision === target.revision)
          updates.push({ id: row.id, valid: false });
        continue;
      }
      updates.push({
        id: row.id,
        revision: event.revision,
        payload: event,
        synchronized_at: event.occurredAt,
        valid: event.type === 'snapshot',
        identity_invalidated: event.type === 'identity.invalidated',
      });
    }
    if (updates.length) {
      await sql`
      UPDATE provider_server_projections p
      SET revision = coalesce(u.revision, p.revision), payload = coalesce(u.payload, p.payload),
          scope_healthy_at = CASE WHEN u.valid AND u.revision = p.revision THEN p.scope_healthy_at END,
          synchronized_at = coalesce(u.synchronized_at, p.synchronized_at), valid = u.valid,
          identity_invalidated = coalesce(u.identity_invalidated, p.identity_invalidated)
      FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
        AS u(id uuid, revision bigint, payload jsonb, synchronized_at timestamptz,
             valid boolean, identity_invalidated boolean)
      WHERE p.server_id = u.id AND p.instance_id = ${instanceId}::uuid
    `.execute(tx);
      await withdrawGlobalHealth(tx, instanceId);
    }
  };
  if (db.isTransaction) await apply(db);
  else await db.transaction().execute(apply);
}

/** Caller verifies raw-body HMAC, timestamp and event-ID headers before invoking this transaction.
 * An event can update an existing explicit link only; it can never import a provider server. */
export async function applyProviderChange(db: Kysely<Database>, value: unknown, now = new Date()) {
  const event = providerChangeSchema.parse(value);
  if (event.type === 'snapshot') throw new DomainError('configuration_invalid');
  return db.transaction().execute(async (trx) => {
    const feed = await trx
      .selectFrom('provider_change_feeds')
      .selectAll()
      .where('instance_id', '=', event.instanceId)
      .forUpdate()
      .executeTakeFirst();
    if (!feed?.enabled) throw new DomainError('provenance_mismatch');
    const projection = await trx
      .selectFrom('provider_server_projections as p')
      .innerJoin('managed_servers as s', 's.id', 'p.server_id')
      .select(['p.server_id', 'p.revision', 'p.valid', 'p.payload', 'p.identity_invalidated'])
      .where('p.instance_id', '=', event.instanceId)
      .where('s.pterodactyl_uuid', '=', event.server.providerUuid)
      .forUpdate('p')
      .executeTakeFirst();
    if (!projection) throw new DomainError('provenance_mismatch');
    if (
      !isDeepStrictEqual(providerChangeSchema.parse(projection.payload).server, event.server) ||
      !matches(await managedIdentity(trx, projection.server_id), event.server)
    )
      throw new DomainError('provenance_mismatch');
    if (projection.identity_invalidated && event.type !== 'identity.invalidated')
      throw new DomainError('provenance_mismatch');
    if (BigInt(event.revision) <= BigInt(projection.revision)) return 'duplicate' as const;
    if (projection.identity_invalidated) throw new DomainError('provenance_mismatch');
    const valid =
      projection.valid &&
      event.type !== 'identity.invalidated' &&
      BigInt(event.revision) === BigInt(projection.revision) + 1n &&
      fresh(new Date(event.occurredAt), now, MAX_SNAPSHOT_AGE);
    await trx
      .updateTable('provider_server_projections')
      .set({
        scope_healthy_at: null,
        revision: String(event.revision),
        payload: event,
        synchronized_at: new Date(event.occurredAt),
        valid,
        identity_invalidated:
          projection.identity_invalidated || event.type === 'identity.invalidated',
      })
      .where('server_id', '=', projection.server_id)
      .execute();
    // A delivery proves receipt, not that the remote outbox has drained.
    await trx
      .updateTable('provider_change_feeds')
      .set({ healthy_at: null, generation: sql`generation + 1` })
      .where('instance_id', '=', event.instanceId)
      .execute();
    return valid ? ('applied' as const) : ('invalidated' as const);
  });
}

/** Called only after HMAC verification and a rejected provenance check. A known
 * managed identity waiting for its initial link (or a concurrent relink) retries. */
export async function providerEventBindingRejected(
  db: Kysely<Database>,
  instanceId: string,
  identity: ProviderChange['server'],
) {
  const row = await db
    .selectFrom('provider_change_feeds as f')
    .leftJoin('managed_servers as s', (join) => join.on('s.external_id', '=', identity.externalId))
    .leftJoin('managed_nodes as n', 'n.id', 's.node_id')
    .leftJoin('provider_server_projections as p', 'p.server_id', 's.id')
    .select([
      's.id',
      's.pterodactyl_id',
      's.pterodactyl_uuid',
      's.pterodactyl_identifier',
      's.deleted_at',
      'n.pterodactyl_node_id',
      'p.instance_id',
      'p.payload',
      'p.identity_invalidated',
    ])
    .where('f.instance_id', '=', instanceId)
    .where('f.enabled', '=', true)
    .executeTakeFirst();
  if (!row) return false;
  if (!row.id || row.deleted_at) return true;
  if (
    (row.pterodactyl_uuid !== null && row.pterodactyl_uuid !== identity.providerUuid) ||
    (row.pterodactyl_id !== null && row.pterodactyl_id !== identity.providerId) ||
    (row.pterodactyl_identifier !== null && row.pterodactyl_identifier !== identity.identifier) ||
    row.pterodactyl_node_id !== identity.nodeId
  )
    return true;
  if (!row.instance_id) return false;
  return (
    row.instance_id !== instanceId ||
    row.identity_invalidated ||
    !isDeepStrictEqual(providerChangeSchema.parse(row.payload).server, identity)
  );
}

type ScopeProof = {
  ownerId: number;
  providerUuid: string;
  revision: number;
  valid: boolean;
  pending: boolean;
  checkedAt: string;
};
async function clearScopeHealth(db: Kysely<Database>, instanceId: string) {
  await db
    .updateTable('provider_server_projections')
    .set({ scope_healthy_at: null })
    .where('instance_id', '=', instanceId)
    .where('scope_healthy_at', 'is not', null)
    .execute();
}

/** Generation is read before any authenticated health request. Scoped responses
 * prove only the listed revisions. Omissions and pending scopes lose their proof. */
export async function markProviderFeedHealth(
  db: Kysely<Database>,
  input: {
    instanceId: string;
    pendingEvents: number;
    checkedAt: string;
    expectedGeneration: string;
    scopes?: ScopeProof[];
    credentialBinding?: string;
    targetUuids?: string[];
  },
  now = new Date(),
) {
  const checked = new Date(input.checkedAt);
  const healthy = !input.scopes && input.pendingEvents === 0 && fresh(checked, now, MAX_HEALTH_AGE);
  const apply = async (tx: Kysely<Database>) => {
    const feed = await tx
      .updateTable('provider_change_feeds')
      .set({ healthy_at: healthy ? checked : null })
      .where('instance_id', '=', input.instanceId)
      .where('generation', '=', input.expectedGeneration)
      .where('enabled', '=', true)
      .returning('instance_id')
      .executeTakeFirst();
    if (!feed) return;
    if (!input.scopes || (!input.scopes.length && !input.targetUuids))
      return clearScopeHealth(tx, input.instanceId);
    const proofs = input.scopes.filter((proof) =>
      fresh(new Date(proof.checkedAt), now, MAX_HEALTH_AGE),
    );
    await sql`
      UPDATE provider_server_projections p
      SET scope_healthy_at = CASE WHEN proof.revision = p.revision AND proof.valid AND NOT proof.pending
                                    AND proof."ownerId" = s.provider_user_id
                                    AND p.valid AND NOT p.identity_invalidated THEN proof."checkedAt" END,
          scope_owner_id = s.owner_id, scope_provider_user_id = proof."ownerId", scope_credential = ${input.credentialBinding ?? null},
          valid = p.valid AND NOT coalesce(proof.revision > p.revision OR NOT proof.valid, false)
      FROM managed_servers s LEFT JOIN jsonb_to_recordset(${JSON.stringify(proofs)}::jsonb)
        AS proof("providerUuid" uuid, "ownerId" integer, revision bigint, valid boolean, pending boolean, "checkedAt" timestamptz)
        ON proof."providerUuid" = s.pterodactyl_uuid
      WHERE p.server_id = s.id AND p.instance_id = ${input.instanceId}::uuid
        ${input.targetUuids ? sql`AND s.pterodactyl_uuid = ANY(${input.targetUuids}::uuid[])` : sql``}
    `.execute(tx);
  };
  if (db.isTransaction) await apply(db);
  else await db.transaction().execute(apply);
}

/** Advisory cache only. Missing, unhealthy, changed identity or stale data must use the normal API. */
export async function cachedProviderStartLimits(
  db: Kysely<Database>,
  serverId: string,
  providerUrl: string,
  now = new Date(),
  credentialBinding?: string,
) {
  const row = await db
    .selectFrom('provider_server_projections as p')
    .innerJoin('provider_change_feeds as f', 'f.instance_id', 'p.instance_id')
    .innerJoin('managed_servers as s', 's.id', 'p.server_id')
    .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
    .select([
      's.pterodactyl_id',
      's.pterodactyl_uuid',
      's.pterodactyl_identifier',
      's.external_id',
      'n.pterodactyl_node_id',
      'p.payload',
      'p.valid',
      'p.identity_invalidated',
      'p.synchronized_at',
      'p.scope_healthy_at',
      'p.scope_owner_id',
      'p.scope_provider_user_id',
      'p.scope_credential',
      's.owner_id',
      's.provider_user_id',
      'f.enabled',
      'f.healthy_at',
      'f.provider_url',
    ])
    .where('p.server_id', '=', serverId)
    .where('s.deleted_at', 'is', null)
    .executeTakeFirst()
    .catch((error: unknown) => {
      // Rolling source activation can precede the explicit development migration.
      // Missing optional projection tables must preserve the existing provider path.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === '42P01' || error.code === '42703')
      )
        return undefined;
      throw error;
    });
  if (
    row?.scope_healthy_at &&
    (row.scope_owner_id !== row.owner_id ||
      row.scope_provider_user_id !== row.provider_user_id ||
      !credentialBinding ||
      row.scope_credential !== credentialBinding)
  )
    return null;
  const checked = row?.scope_healthy_at ?? row?.healthy_at;
  if (
    !row?.valid ||
    row.identity_invalidated ||
    !row.enabled ||
    !checked ||
    row.provider_url !== providerUrl.replace(/\/$/, '') ||
    !fresh(checked, now, MAX_HEALTH_AGE) ||
    !fresh(row.synchronized_at, now, MAX_SNAPSHOT_AGE)
  )
    return null;
  const event = providerChangeSchema.safeParse(row.payload);
  if (
    !event.success ||
    event.data.type === 'identity.invalidated' ||
    !matches(row, event.data.server)
  )
    return null;
  return event.data.limits;
}

export async function invalidateProviderFeedHealth(db: Kysely<Database>, instanceId: string) {
  await db.transaction().execute(async (tx) => {
    await withdrawGlobalHealth(tx, instanceId);
    await clearScopeHealth(tx, instanceId);
  });
}
