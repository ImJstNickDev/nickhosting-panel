import { createHash } from 'node:crypto';
import type { SecretCodec } from '@nickhosting/core';
import { type Database, getSecret, getSettings } from '@nickhosting/database';
import {
  createNickHostingBridge,
  discoverNickHostingExtension,
  type NickHostingExtension,
  PROVIDER_SNAPSHOT_BATCH_SIZE,
  type ProviderChange,
  PterodactylError,
} from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import { backupSchemaAvailable } from './provider-backup-events.js';
import {
  invalidateProviderFeedHealth,
  linkProviderFeedServer,
  markProviderFeedHealth,
  refreshLinkedProviderSnapshots,
} from './provider-change-feed.js';

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
  const snapshot = await bridge.linkServer(
    feed.instance_id,
    {
      providerId: server.pterodactyl_id,
      providerUuid: server.pterodactyl_uuid,
      identifier: server.pterodactyl_identifier,
      externalId: server.external_id,
      nodeId: server.pterodactyl_node_id,
    },
    server.provider_user_id ?? undefined,
  );
  await linkProviderFeedServer(db, feed.instance_id, serverId, snapshot);
}

const discoveryByDatabase = new WeakMap<
  Kysely<Database>,
  { binding: string; checkedAt: Date; extension: NickHostingExtension | null }
>();

async function feedCapabilities(
  db: Kysely<Database>,
  options: Parameters<typeof discoverNickHostingExtension>[0],
) {
  const binding = createHash('sha256')
    .update(JSON.stringify([options.baseURL, options.applicationKey]))
    .digest('hex');
  const previous = discoveryByDatabase.get(db);
  if (previous?.binding === binding && Date.now() - previous.checkedAt.getTime() < 60_000)
    return previous;
  const extension = await discoverNickHostingExtension(options);
  const discovery = { binding, checkedAt: new Date(), extension };
  discoveryByDatabase.set(db, discovery);
  return discovery;
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
  }>`select to_regclass(current_schema() || '.provider_change_feeds')::text as present`.execute(db);
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
          .select([
            's.id',
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
            eb.or([
              eb('p.server_id', 'is', null),
              eb.and([
                eb('p.identity_invalidated', '=', false),
                eb('p.synchronized_at', '<=', new Date(Date.now() - 60_000)),
              ]),
            ]),
          )
          .execute();
        const { checkedAt, extension } = await feedCapabilities(db, options);
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
        const linked = [];
        for (const server of servers) {
          if (!server.pterodactyl_id || !server.pterodactyl_uuid || !server.pterodactyl_identifier)
            continue;
          if (server.revision !== null) {
            linked.push({
              id: server.id,
              providerUuid: server.pterodactyl_uuid,
              revision: server.revision,
            });
            continue;
          }
          // First links still require the complete managed identity and the expected owner.
          try {
            const snapshot = await bridge.linkServer(
              feed.instance_id,
              {
                providerId: server.pterodactyl_id,
                providerUuid: server.pterodactyl_uuid,
                identifier: server.pterodactyl_identifier,
                externalId: server.external_id,
                nodeId: server.pterodactyl_node_id,
              },
              server.provider_user_id ?? undefined,
            );
            await linkProviderFeedServer(db, feed.instance_id, server.id, snapshot);
          } catch (error) {
            // A deleted or mismatched new identity has no projection and cannot poison its peers.
            if (
              !(
                error instanceof PterodactylError &&
                (error.upstreamStatus === 404 || error.upstreamStatus === 409)
              )
            )
              throw error;
          }
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
        const health = await bridge.health(feed.instance_id);
        if (health.instanceId !== feed.instance_id) throw new Error('identity mismatch');
        await markProviderFeedHealth(db, { ...health, expectedGeneration: cursor.generation });
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
