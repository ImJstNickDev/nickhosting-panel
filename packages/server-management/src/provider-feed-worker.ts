import type { SecretCodec } from '@nickhosting/core';
import { type Database, getSecret, getSettings } from '@nickhosting/database';
import { createNickHostingBridge } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import {
  invalidateProviderFeedHealth,
  linkProviderFeedServer,
  markProviderFeedHealth,
} from './provider-change-feed.js';

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
  const bridge = createNickHostingBridge({
    baseURL: values.pterodactylBaseUrl,
    applicationKey,
    coordinator,
  });
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
            's.external_id',
            'n.pterodactyl_node_id',
            'p.synchronized_at',
          ])
          .where('s.deleted_at', 'is', null)
          .where('s.pterodactyl_id', 'is not', null)
          .execute();
        for (const server of servers) {
          if (server.synchronized_at && Date.now() - server.synchronized_at.getTime() < 60000)
            continue;
          if (!server.pterodactyl_id || !server.pterodactyl_uuid || !server.pterodactyl_identifier)
            continue;
          const snapshot = server.synchronized_at
            ? await bridge.getServer(feed.instance_id, server.pterodactyl_uuid)
            : await bridge.linkServer(feed.instance_id, {
                providerId: server.pterodactyl_id,
                providerUuid: server.pterodactyl_uuid,
                identifier: server.pterodactyl_identifier,
                externalId: server.external_id,
                nodeId: server.pterodactyl_node_id,
              });
          // Projection updates own short transaction so receiver deliveries are not blocked by network I/O.
          await linkProviderFeedServer(db, feed.instance_id, server.id, snapshot);
        }
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
      throw new Error('Provider change feed unavailable');
    }
  }
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
