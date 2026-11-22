import { createHash } from 'node:crypto';
import type { SecretCodec } from '@nickhosting/core';
import { type Database, getSecret, getSettings } from '@nickhosting/database';
import {
  createNickHostingBridge,
  PROVIDER_SNAPSHOT_BATCH_SIZE,
  type ProviderChange,
  PterodactylError,
} from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import { backupSchemaAvailable } from './provider-backup-events.js';
import { providerCapabilities, providerCredentialBinding } from './provider-capabilities.js';
import {
  invalidateProviderFeedHealth,
  linkProviderFeedServer,
  markProviderFeedHealth,
  refreshLinkedProviderSnapshots,
} from './provider-change-feed.js';

type LinkServer = {
  id: string;
  owner_id: string;
  external_id: string;
  pterodactyl_id: number | null;
  pterodactyl_uuid: string | null;
  pterodactyl_identifier: string | null;
  pterodactyl_node_id: number;
  provider_user_id: number | null;
};

type LinkRetry = { binding: string | null; attempts: number | null; retry_at: Date | null };
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');

async function firstLink(
  db: Kysely<Database>,
  bridge: ReturnType<typeof createNickHostingBridge>,
  instanceId: string,
  credentialBinding: string,
  server: LinkServer,
  retry?: LinkRetry,
) {
  if (!server.pterodactyl_id || !server.pterodactyl_uuid || !server.pterodactyl_identifier)
    return false;
  const identity = {
    providerId: server.pterodactyl_id,
    providerUuid: server.pterodactyl_uuid,
    identifier: server.pterodactyl_identifier,
    externalId: server.external_id,
    nodeId: server.pterodactyl_node_id,
  };
  const binding = digest([credentialBinding, identity, server.owner_id, server.provider_user_id]);
  const sameBinding = retry?.binding === binding;
  if (sameBinding && retry.retry_at && retry.retry_at.getTime() > Date.now()) return false;
  try {
    const snapshot = await bridge.linkServer(
      instanceId,
      identity,
      server.provider_user_id ?? undefined,
    );
    await linkProviderFeedServer(db, instanceId, server.id, snapshot, new Date(), {
      ownerId: server.owner_id,
      providerUserId: server.provider_user_id,
    });
  } catch (error) {
    if (
      !(
        error instanceof PterodactylError &&
        (error.upstreamStatus === 404 || error.upstreamStatus === 409)
      )
    )
      throw error;
    const attempts = sameBinding ? Math.min(2_147_483_647, (retry.attempts ?? 0) + 1) : 1;
    const record = {
      binding,
      attempts,
      retry_at: new Date(Date.now() + Math.min(900, 60 * 2 ** Math.min(4, attempts - 1)) * 1000),
    };
    await db
      .insertInto('provider_feed_link_retries')
      .values({ instance_id: instanceId, server_id: server.id, ...record })
      .onConflict((c) => c.columns(['instance_id', 'server_id']).doUpdateSet(record))
      .execute();
    return false;
  }
  if (retry?.binding)
    await db
      .deleteFrom('provider_feed_link_retries')
      .where('instance_id', '=', instanceId)
      .where('server_id', '=', server.id)
      .execute();
  return true;
}

/** Link one newly provisioned identity immediately so its first installer stream
 * need not wait for the shared feed maintenance interval. */
export async function ensureInstallationFeedLink(
  db: Kysely<Database>,
  codec: SecretCodec,
  env: Readonly<Record<string, string | undefined>>,
  serverId: string,
  coordinator?: Parameters<typeof createNickHostingBridge>[0]['coordinator'],
) {
  const existing = await db
    .selectFrom('provider_server_projections')
    .select(['server_id', 'identity_invalidated'])
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (existing?.identity_invalidated) throw new Error('Provider identity invalidated');
  if (existing) return;
  const [{ values }, applicationKey, server] = await Promise.all([
    getSettings(db, env),
    getSecret(db, codec, 'pterodactylApplicationKey', env),
    db
      .selectFrom('managed_servers as s')
      .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
      .select([
        's.id',
        's.owner_id',
        's.pterodactyl_id',
        's.pterodactyl_uuid',
        's.pterodactyl_identifier',
        's.provider_user_id',
        's.external_id',
        'n.pterodactyl_node_id',
      ])
      .where('s.id', '=', serverId)
      .where('s.deleted_at', 'is', null)
      .executeTakeFirst(),
  ]);
  if (
    !applicationKey ||
    !values.pterodactylBaseUrl ||
    !server?.pterodactyl_id ||
    !server.pterodactyl_uuid ||
    !server.pterodactyl_identifier
  )
    return;
  const feed = await db
    .selectFrom('provider_change_feeds')
    .select('instance_id')
    .where('enabled', '=', true)
    .where('provider_url', '=', values.pterodactylBaseUrl.replace(/\/$/, ''))
    .executeTakeFirst();
  if (!feed) return;
  const bridge = createNickHostingBridge({
    baseURL: values.pterodactylBaseUrl,
    applicationKey,
    coordinator,
  });
  const retry = await db
    .selectFrom('provider_feed_link_retries')
    .selectAll()
    .where('instance_id', '=', feed.instance_id)
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (
    !(await firstLink(
      db,
      bridge,
      feed.instance_id,
      digest([values.pterodactylBaseUrl, applicationKey]),
      server,
      retry,
    ))
  )
    throw new Error('Provider feed link deferred');
}

async function refreshExistingLinks(
  db: Kysely<Database>,
  bridge: ReturnType<typeof createNickHostingBridge>,
  instanceId: string,
  targets: { id: string; providerUuid: string; revision: string }[],
  batchSupported: boolean,
) {
  for (let offset = 0; offset < targets.length; offset += PROVIDER_SNAPSHOT_BATCH_SIZE) {
    const batch = targets.slice(offset, offset + PROVIDER_SNAPSHOT_BATCH_SIZE);
    let snapshots: ProviderChange[] = [];
    if (batchSupported) {
      const result = await bridge.getLinkedServerSnapshots(
        instanceId,
        batch.map((entry) => entry.providerUuid),
      );
      snapshots = result.servers;
    } else {
      for (const entry of batch) {
        try {
          snapshots.push(await bridge.getServer(instanceId, entry.providerUuid));
        } catch (error) {
          if (!(error instanceof PterodactylError && error.reason === 'not_found')) throw error;
        }
      }
    }
    await refreshLinkedProviderSnapshots(db, instanceId, batch, snapshots);
  }
}

/** One shared background feed check, never one poll per browser or Start. */
export async function refreshProviderFeeds(
  db: Kysely<Database>,
  codec: SecretCodec,
  env: Readonly<Record<string, string | undefined>>,
  coordinator?: Parameters<typeof createNickHostingBridge>[0]['coordinator'],
) {
  // Rolling upgrades may start the worker before the explicit migration command.
  const available = await sql<{
    present: string | null;
  }>`select to_regclass(current_schema() || '.provider_feed_link_retries')::text as present`.execute(
    db,
  );
  if (!available.rows[0]?.present) return;
  const { values } = await getSettings(db, env);
  const feeds = await db
    .selectFrom('provider_change_feeds')
    .selectAll()
    .where('enabled', '=', true)
    .execute();
  if (!feeds.length) return;
  const applicationKey = await getSecret(db, codec, 'pterodactylApplicationKey', env);
  if (!applicationKey || !values.pterodactylBaseUrl) return;
  const options = { baseURL: values.pterodactylBaseUrl, applicationKey, coordinator };
  const bridge = createNickHostingBridge(options);
  let unavailable = false;
  for (const feed of feeds) {
    try {
      if (feed.provider_url !== values.pterodactylBaseUrl.replace(/\/$/, '')) {
        await invalidateProviderFeedHealth(db, feed.instance_id);
        continue;
      }
      // Advisory lock serializes multiple workers; transaction holds it across this bounded refresh.
      await db.transaction().execute(async (tx) => {
        const locked = await sql<{
          locked: boolean;
        }>`select pg_try_advisory_xact_lock(hashtextextended(${`blueprint:${feed.instance_id}`},0)) as locked`.execute(
          tx,
        );
        if (!locked.rows[0]?.locked) return;
        const servers = await tx
          .selectFrom('managed_servers as s')
          .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
          .leftJoin('provider_server_projections as p', 'p.server_id', 's.id')
          .leftJoin('provider_feed_link_retries as r', (join) =>
            join.onRef('r.server_id', '=', 's.id').on('r.instance_id', '=', feed.instance_id),
          )
          .select([
            's.id',
            's.owner_id',
            'r.binding',
            'r.attempts',
            'r.retry_at',
            'p.synchronized_at',
            'p.valid',
            's.pterodactyl_id',
            's.pterodactyl_uuid',
            's.pterodactyl_identifier',
            's.provider_user_id',
            's.external_id',
            'n.pterodactyl_node_id',
            'p.revision',
          ])
          .where('s.deleted_at', 'is', null)
          .where('s.pterodactyl_id', 'is not', null)
          .where((eb) =>
            eb.or([eb('p.instance_id', 'is', null), eb('p.instance_id', '=', feed.instance_id)]),
          )
          .where((eb) =>
            eb.or([eb('p.server_id', 'is', null), eb('p.identity_invalidated', '=', false)]),
          )
          .execute();
        const binding = providerCredentialBinding(options.baseURL, applicationKey);
        const linked = [];
        const healthTargets: string[] = [];
        for (const server of servers) {
          if (!server.pterodactyl_id || !server.pterodactyl_uuid || !server.pterodactyl_identifier)
            continue;
          if (server.revision !== null) {
            healthTargets.push(server.pterodactyl_uuid);
            if (
              server.valid &&
              server.synchronized_at &&
              server.synchronized_at.getTime() > Date.now() - 60_000
            )
              continue;
            linked.push({
              id: server.id,
              providerUuid: server.pterodactyl_uuid,
              revision: server.revision,
            });
            continue;
          }
          if (await firstLink(db, bridge, feed.instance_id, binding, server, server))
            healthTargets.push(server.pterodactyl_uuid);
        }
        // An empty scopes query is the legacy global-health endpoint. Retire
        // all proofs locally; it cannot authorize any current or future link.
        if (!healthTargets.length) {
          await invalidateProviderFeedHealth(db, feed.instance_id);
          return;
        }
        const { checkedAt, extension } = await providerCapabilities(db, options);
        if (
          (await backupSchemaAvailable(db)) &&
          (!feed.capabilities_checked_at || checkedAt > feed.capabilities_checked_at)
        ) {
          await db
            .updateTable('provider_change_feeds')
            .set({
              backup_events: extension?.capabilities.backupEvents === true,
              capabilities_checked_at: checkedAt,
            })
            .where('instance_id', '=', feed.instance_id)
            .execute();
        }
        await refreshExistingLinks(
          db,
          bridge,
          feed.instance_id,
          linked,
          extension?.capabilities.linkedServerSnapshots === true,
        );
        const cursor = await db
          .selectFrom('provider_change_feeds')
          .select('generation')
          .where('instance_id', '=', feed.instance_id)
          .executeTakeFirstOrThrow();
        // An older extension ignores the query and supplies its single global drain fence.
        // A newer one returns revision evidence only for these managed links.
        const scopes = [];
        for (let offset = 0; ; offset += PROVIDER_SNAPSHOT_BATCH_SIZE) {
          const ids = healthTargets.slice(offset, offset + PROVIDER_SNAPSHOT_BATCH_SIZE);
          const health = await bridge.health(feed.instance_id, ids);
          if (!health.scopes) {
            if (offset !== 0) throw new Error('Inconsistent provider health response');
            await markProviderFeedHealth(db, {
              ...health,
              scopes: undefined,
              expectedGeneration: cursor.generation,
            });
            break;
          }
          for (const scope of health.scopes) scopes.push({ ...scope, checkedAt: health.checkedAt });
          if (offset + ids.length >= healthTargets.length) {
            await markProviderFeedHealth(db, {
              ...health,
              scopes,
              credentialBinding: binding,
              expectedGeneration: cursor.generation,
            });
            break;
          }
        }
      });
    } catch {
      await invalidateProviderFeedHealth(db, feed.instance_id);
      unavailable = true;
    }
  }
  if (unavailable) throw new Error('Provider change feed unavailable');
}
export function startProviderFeedLoop(refresh: () => Promise<void>, failed: () => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      await refresh();
    } catch {
      try {
        failed();
      } catch {
        /* Logging cannot stop recovery. */
      }
    } finally {
      if (!stopped)
        timer = setTimeout(() => {
          pending = tick();
        }, 15000);
    }
  };
  let pending = tick();
  return {
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await pending;
    },
  };
}
