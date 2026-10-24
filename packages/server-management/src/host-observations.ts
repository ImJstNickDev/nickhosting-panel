import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '@nickhosting/core';
import { type Database, getSettings } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';
import {
  type DB,
  type Environment,
  hostObservationFingerprint,
  hostSnapshotSchema,
  observeLocalHost,
} from './admission.js';
import { resolveHostOverride } from './configuration.js';
import { createHostResourceSampler } from './host-resources.js';

const collectors = new WeakMap<Kysely<Database>, ReturnType<typeof createHostResourceSampler>>();
export type RefreshHostObservationsOptions = {
  serverId?: string;
  /** Periodic producer: collect at most once per second, regardless of request freshness. */
  force?: boolean;
  sampler?: ReturnType<typeof createHostResourceSampler>['sample'];
};

/** Independent from provider configuration: unavailable credentials must not stop observation. */
export async function refreshHostObservations(
  db: Kysely<Database>,
  env: Environment,
  options: RefreshHostObservationsOptions = {},
) {
  if (!env.NH_OBSERVER_ID) return;
  const hosts = options.serverId
    ? await db
        .selectFrom('physical_hosts as host')
        .innerJoin('managed_nodes as node', 'node.physical_host_id', 'host.id')
        .innerJoin('managed_servers as server', 'server.node_id', 'node.id')
        .selectAll('host')
        .where('server.id', '=', options.serverId)
        .execute()
    : await db.selectFrom('physical_hosts').selectAll().execute();
  const { values: config } = await getSettings(db, env);
  const maxAge = options.force ? 900 : Math.min(4, config.observationMaxAgeSeconds) * 1000;
  let collector = collectors.get(db);
  if (!collector) {
    collector = createHostResourceSampler();
    collectors.set(db, collector);
  }
  const sample = options.sampler ?? collector.sample;
  async function fresh(connection: DB, hostId: string, observerId: string, diskPath: string) {
    const row = await connection
      .selectFrom('host_observations')
      .selectAll()
      .where('host_id', '=', hostId)
      .executeTakeFirst();
    const parsed = hostSnapshotSchema.safeParse(row?.snapshot);
    const age = row ? Date.now() - row.observed_at.getTime() : Infinity;
    return (
      row?.observer_id === observerId &&
      parsed.success &&
      parsed.data.sourceFingerprint === hostObservationFingerprint(hostId, observerId, diskPath) &&
      age >= 0 &&
      age <= maxAge &&
      new Date(parsed.data.observedAt).getTime() === row.observed_at.getTime() &&
      parsed.data.availableMemoryMiB <= parsed.data.totalMemoryMiB
    );
  }
  const results = await Promise.allSettled(
    hosts.map(async (stored) => {
      const host = resolveHostOverride(stored, env);
      if (!host.enabled || host.observer_id !== env.NH_OBSERVER_ID) return;
      if (await fresh(db, host.id, host.observer_id, host.local_disk_path)) return;
      // Sampling never holds the global admission lock. A separate per-host lock
      // deduplicates API/worker producers across connections and processes.
      const deadline = Date.now() + 600;
      do {
        const done = await db.transaction().execute(async (tx) => {
          const lock = await sql<{
            acquired: boolean;
          }>`select pg_try_advisory_xact_lock(hashtextextended(${`host-observation:${host.id}`}, 0)) as acquired`.execute(
            tx,
          );
          if (!lock.rows[0]?.acquired) return false;
          const current = await tx
            .selectFrom('physical_hosts')
            .selectAll()
            .where('id', '=', host.id)
            .forShare()
            .executeTakeFirst();
          if (!current) return true;
          const effective = resolveHostOverride(current, env);
          if (!effective.enabled || effective.observer_id !== env.NH_OBSERVER_ID) return true;
          if (await fresh(tx, host.id, effective.observer_id, effective.local_disk_path))
            return true;
          await tx
            .deleteFrom('host_observations')
            .where('host_id', '=', host.id)
            .where('observed_at', '>', new Date())
            .execute();
          // Empty managed credits deliberately keep other workloads counted.
          await observeLocalHost(tx, host.id, effective.observer_id, {}, env, sample);
          return true;
        });
        if (done || options.force) return;
        if (await fresh(db, host.id, host.observer_id, host.local_disk_path)) return;
        if (Date.now() >= deadline) throw new DomainError('resources_unavailable');
        await delay(25);
      } while (Date.now() <= deadline);
      throw new DomainError('resources_unavailable');
    }),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
