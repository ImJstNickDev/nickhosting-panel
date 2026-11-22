import { randomUUID } from 'node:crypto';
import type { Database } from '@nickhosting/database';
import {
  type GatewayHeartbeatRequest,
  type GatewayHeartbeatSections,
  nickHostingExtensionSchema,
  PROVIDER_SNAPSHOT_BATCH_SIZE,
} from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import { markProviderFeedHealth, refreshLinkedProviderSnapshots } from './provider-change-feed.js';

type Connection = Kysely<Database>;
type Target = {
  id: string;
  providerUuid: string;
  revision: string;
  due: boolean;
  instanceId: string;
  generation: string;
  projectionVersion: string;
  managedVersion: string;
};

async function hasGatewayFeedHeartbeat(db: Connection) {
  const { rows } = await sql<{
    available: boolean;
  }>`select to_regclass(current_schema() || '.gateway_feed_heartbeat') is not null as available`.execute(
    db,
  );
  return rows[0]?.available === true;
}

function lockFeed(tx: Connection, instanceId: string) {
  return sql<{
    locked: boolean;
  }>`select pg_try_advisory_xact_lock(hashtextextended(${`blueprint:${instanceId}`},0)) as locked`.execute(
    tx,
  );
}

function supported(raw: unknown) {
  const parsed = nickHostingExtensionSchema.safeParse(raw);
  if (!parsed.success) return false;
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(parsed.data.extensionVersion);
  return (
    version && (Number(version[1]) > 1 || (Number(version[1]) === 1 && Number(version[2]) >= 11))
  );
}

/** Reserve side reads before dispatch. Locks end before the long poll starts.
 * Workers never wait for these reservations and can supersede one at any time. */
export async function prepareGatewayHeartbeat(
  db: Connection,
  url: string,
  binding: string,
  intervalMs = 7500,
) {
  // Schedule before a snapshot crosses 60s between two bounded heartbeats.
  const snapshotAgeMs = 60000 - 2 * Math.max(0, Math.min(intervalMs, 7500));
  const token = randomUUID();
  const plan = await db.transaction().execute(async (tx) => {
    await sql`set local statement_timeout = '100ms'`.execute(tx);
    await sql`set local lock_timeout = '50ms'`.execute(tx);
    const {
      rows: [metadata],
    } = await sql<{
      checked_at: Date;
      extension: unknown;
      instance_id: string | null;
      generation: string | null;
    }>`select d.checked_at, d.extension, f.instance_id, f.generation::text
      from blueprint_capability_discovery d left join provider_change_feeds f on f.enabled and f.provider_url=${url.replace(/\/$/, '')}
      where d.singleton and d.binding = ${binding}`.execute(tx);
    if (!metadata || !supported(metadata.extension)) return;
    const now = Date.now();
    const age = now - metadata.checked_at.getTime();
    if (age < 0 || age >= 60000) return;
    // A bounded wait can take 7.5s; request before the discovery cache expires.
    const capabilities = age >= 44000;
    const request: GatewayHeartbeatRequest = {};
    if (capabilities) request.capabilities = true;
    let targets: Target[] = [];
    const instance = metadata.instance_id;
    if (
      instance &&
      (await hasGatewayFeedHeartbeat(tx)) &&
      (await lockFeed(tx, instance)).rows[0]?.locked
    ) {
      const dueAt = sql`p.synchronized_at + ${snapshotAgeMs}::integer * interval '1 millisecond'`;
      const { rows } = await sql<Target>`
        select s.id, s.pterodactyl_uuid as "providerUuid", p.revision::text,
          (not p.valid or ${dueAt} <= clock_timestamp() or p.synchronized_at > clock_timestamp()) as due,
          p.instance_id as "instanceId", ${metadata.generation}::text as generation,
          p.xmin::text as "projectionVersion", s.provider_identity_revision::text as "managedVersion"
        from provider_server_projections p join managed_servers s on s.id = p.server_id
          left join gateway_feed_heartbeat h using(server_id)
        where p.instance_id = ${instance} and not p.identity_invalidated
          and s.deleted_at is null and s.pterodactyl_id is not null
          and s.pterodactyl_identifier is not null and s.pterodactyl_uuid is not null
          and (h.requested_at is null or h.requested_at <= clock_timestamp() - interval '10 seconds'
            or h.requested_at > clock_timestamp() or ${dueAt} between h.requested_at and clock_timestamp())
        order by h.requested_at nulls first, s.id limit ${PROVIDER_SNAPSHOT_BATCH_SIZE}
      `.execute(tx);
      targets = rows;
      if (targets.length) {
        await sql`
          insert into gateway_feed_heartbeat (server_id, token, requested_at)
          select id, ${token}::uuid, clock_timestamp() from unnest(${targets.map((t) => t.id)}::uuid[]) as ids(id)
          on conflict (server_id) do update set token=excluded.token, requested_at=excluded.requested_at
        `.execute(tx);
        request.instanceId = instance;
        request.health = targets.map((row) => row.providerUuid);
        const due = targets.filter((row) => row.due);
        if (due.length) request.snapshots = due.map((row) => row.providerUuid);
      }
    }
    if (!request.capabilities && !request.health) return;
    return { request, targets, previous: metadata.checked_at };
  });
  if (!plan) return;
  const { request, targets, previous } = plan;
  const requestedAt = Date.now();
  async function publishCapabilities(caps: GatewayHeartbeatSections['capabilities']) {
    if (request.capabilities && caps) {
      const observed = new Date(caps.checkedAt);
      // A delayed reply cannot extend the provider's original observation,
      // overwrite a rotation, or replace a newer standalone discovery.
      if (
        +observed >= requestedAt - 1000 &&
        +observed <= Date.now() &&
        Date.now() - +observed < 60000
      )
        await sql`update blueprint_capability_discovery set checked_at=${observed}, extension=${JSON.stringify(caps.extension)}::jsonb
            where singleton and binding=${binding} and checked_at=${previous} and checked_at<${observed}`.execute(
          db,
        );
    }
  }
  async function publishFeed(sections: GatewayHeartbeatSections | undefined) {
    const first = targets[0];
    if (!first) return;
    await db.transaction().execute(async (tx) => {
      if (!(await lockFeed(tx, first.instanceId)).rows[0]?.locked) return;
      const feed = await tx
        .selectFrom('provider_change_feeds')
        .select(['enabled', 'generation', 'provider_url'])
        .where('instance_id', '=', first.instanceId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !feed?.enabled ||
        feed.provider_url !== url.replace(/\/$/, '') ||
        feed.generation !== first.generation
      )
        return;
      // Local owner changes, unlink/relink, a superseding request or a key
      // rotation during I/O discard the old result. No receipt creates links.
      const { rows } = await sql<{ id: string }>`
          select s.id from gateway_feed_heartbeat h join provider_server_projections p using(server_id)
          join managed_servers s on s.id=p.server_id
          join jsonb_to_recordset(${JSON.stringify(targets)}::jsonb)
            as t(id uuid, "managedVersion" text, "projectionVersion" text)
            on s.id=t.id and s.provider_identity_revision::text=t."managedVersion" and p.xmin::text=t."projectionVersion"
          where h.token=${token} and p.instance_id=${first.instanceId} and not p.identity_invalidated
            and s.deleted_at is null and exists(select from blueprint_capability_discovery where singleton and binding=${binding})
          for update of s,p,h`.execute(tx);
      if (!rows.length) return;
      const currentIds = new Set(rows.map((row) => row.id));
      const current = targets.filter((target) => currentIds.has(target.id));
      const snapshots = current.filter((row) => row.due);
      // A refused identity or native revision conflict withdraws the affected
      // snapshots immediately, even if the separate outbox query succeeded.
      // Invalid projections are also due at the next standalone worker tick.
      const refused =
        sections?.snapshotError !== undefined &&
        [401, 403, 404, 409].includes(sections.snapshotError);
      if (snapshots.length && (sections?.snapshots || refused))
        await refreshLinkedProviderSnapshots(
          tx,
          first.instanceId,
          snapshots,
          sections?.snapshots?.servers ?? [],
        );
      const generation = (
        await tx
          .selectFrom('provider_change_feeds')
          .select('generation')
          .where('instance_id', '=', first.instanceId)
          .executeTakeFirstOrThrow()
      ).generation;
      const health = sections?.health;
      const checked = health && new Date(health.checkedAt);
      const fresh =
        checked &&
        +checked >= requestedAt - 1000 &&
        +checked <= Date.now() &&
        Date.now() - +checked < 30000;
      await markProviderFeedHealth(tx, {
        instanceId: first.instanceId,
        pendingEvents: 0,
        checkedAt: health?.checkedAt ?? new Date().toISOString(),
        expectedGeneration: generation,
        scopes:
          health && fresh
            ? health.scopes.map((scope) => ({ ...scope, checkedAt: health.checkedAt }))
            : [],
        targetUuids: current.map((t) => t.providerUuid),
        credentialBinding: binding,
      });
      await sql`update gateway_feed_heartbeat set checked_at=${health && fresh ? health.checkedAt : null} where token=${token} and server_id=any(${current.map((row) => row.id)}::uuid[])`.execute(
        tx,
      );
    });
  }
  return {
    request,
    async accept(sections: GatewayHeartbeatSections | undefined) {
      await Promise.all([publishCapabilities(sections?.capabilities), publishFeed(sections)]);
    },
  };
}

/** A worker may reuse only a completed, still-current scoped observation.
 * Clearing pending tokens gives this standalone dispatch precedence over older
 * in-flight responses, including failures arriving after the worker succeeds. */
export async function standaloneHealthTargets(
  db: Connection,
  instanceId: string,
  binding: string,
  ids: string[],
) {
  if (!(await hasGatewayFeedHeartbeat(db))) return ids;
  const { rows } = await sql<{ uuid: string }>`
    select s.pterodactyl_uuid as uuid from gateway_feed_heartbeat h join provider_server_projections p using(server_id)
    join managed_servers s on s.id=p.server_id
    where p.instance_id=${instanceId} and h.checked_at=p.scope_healthy_at
      and h.checked_at between clock_timestamp()-interval '15 seconds' and clock_timestamp()
      and p.scope_owner_id=s.owner_id and p.scope_provider_user_id=s.provider_user_id and p.scope_credential=${binding}
      and p.valid and not p.identity_invalidated and s.pterodactyl_uuid=any(${ids}::uuid[])`.execute(
    db,
  );
  const recent = new Set(rows.map((row) => row.uuid));
  const remaining = ids.filter((id) => !recent.has(id));
  if (remaining.length)
    await sql`update gateway_feed_heartbeat h set token=${randomUUID()}, checked_at=null
    from managed_servers s where s.id=h.server_id and s.pterodactyl_uuid=any(${remaining}::uuid[])`.execute(
      db,
    );
  return remaining;
}
