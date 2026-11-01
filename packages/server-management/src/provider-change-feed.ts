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
  });
}

async function managedIdentity(db: Kysely<Database>, serverId: string) {
  return db
    .selectFrom('managed_servers as s')
    .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
    .select([
      's.id',
      's.pterodactyl_id',
      's.pterodactyl_uuid',
      's.pterodactyl_identifier',
      's.external_id',
      'n.pterodactyl_node_id',
    ])
    .where('s.id', '=', serverId)
    .executeTakeFirst();
}
function matches(
  row: Awaited<ReturnType<typeof managedIdentity>>,
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

/** Only call with an authenticated adapter snapshot after explicit managed-server linking. */
export async function linkProviderFeedServer(
  db: Kysely<Database>,
  instanceId: string,
  serverId: string,
  value: unknown,
  now = new Date(),
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
    if (!feed?.enabled || !matches(await managedIdentity(trx, serverId), event.server))
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
          revision: String(event.revision),
          payload: event,
          synchronized_at: new Date(event.occurredAt),
          valid: true,
        }),
      )
      .execute();
  });
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
    if (BigInt(event.revision) <= BigInt(projection.revision)) return 'duplicate' as const;
    const valid =
      projection.valid &&
      !projection.identity_invalidated &&
      isDeepStrictEqual(providerChangeSchema.parse(projection.payload).server, event.server) &&
      event.type !== 'identity.invalidated' &&
      BigInt(event.revision) === BigInt(projection.revision) + 1n &&
      matches(await managedIdentity(trx, projection.server_id), event.server) &&
      fresh(new Date(event.occurredAt), now, MAX_SNAPSHOT_AGE);
    await trx
      .updateTable('provider_server_projections')
      .set({
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

/** The health request must be authenticated and start before checking this local receipt cursor. */
export async function markProviderFeedHealth(
  db: Kysely<Database>,
  input: {
    instanceId: string;
    pendingEvents: number;
    checkedAt: string;
    expectedGeneration: string;
  },
  now = new Date(),
) {
  const checked = new Date(input.checkedAt);
  const healthy = input.pendingEvents === 0 && fresh(checked, now, MAX_HEALTH_AGE);
  await db
    .updateTable('provider_change_feeds')
    .set({ healthy_at: healthy ? checked : null })
    .where('instance_id', '=', input.instanceId)
    .where('generation', '=', input.expectedGeneration)
    .execute();
}

/** Advisory cache only. Missing, unhealthy, changed identity or stale data must use the normal API. */
export async function cachedProviderStartLimits(
  db: Kysely<Database>,
  serverId: string,
  providerUrl: string,
  now = new Date(),
) {
  const row = await db
    .selectFrom('provider_server_projections as p')
    .innerJoin('provider_change_feeds as f', 'f.instance_id', 'p.instance_id')
    .select([
      'p.payload',
      'p.valid',
      'p.identity_invalidated',
      'p.synchronized_at',
      'f.enabled',
      'f.healthy_at',
      'f.provider_url',
    ])
    .where('p.server_id', '=', serverId)
    .executeTakeFirst()
    .catch((error: unknown) => {
      // Rolling source activation can precede the explicit development migration.
      // Missing optional projection tables must preserve the existing provider path.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01')
        return undefined;
      throw error;
    });
  if (
    !row?.valid ||
    row.identity_invalidated ||
    !row.enabled ||
    !row.healthy_at ||
    row.provider_url !== providerUrl.replace(/\/$/, '') ||
    !fresh(row.healthy_at, now, MAX_HEALTH_AGE) ||
    !fresh(row.synchronized_at, now, MAX_SNAPSHOT_AGE)
  )
    return null;
  const event = providerChangeSchema.safeParse(row.payload);
  if (
    !event.success ||
    event.data.type === 'identity.invalidated' ||
    !matches(await managedIdentity(db, serverId), event.data.server)
  )
    return null;
  return event.data.limits;
}

export async function invalidateProviderFeedHealth(db: Kysely<Database>, instanceId: string) {
  await db
    .updateTable('provider_change_feeds')
    .set({ healthy_at: null, generation: sql`generation + 1` })
    .where('instance_id', '=', instanceId)
    .execute();
}
