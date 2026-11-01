import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '@nickhosting/core';
import { type Database, getSettings } from '@nickhosting/database';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources } from './admission.js';
import { verifyManagedIdentity } from './lifecycle.js';

export type StorageObservationScope = string | { mappingId: string } | { hostId: string };
const scopeSchema = z.union([
  z.uuid(),
  z.object({ mappingId: z.uuid() }).strict(),
  z.object({ hostId: z.uuid() }).strict(),
]);

/** On-demand admission observations, separate from lifecycle reconciliation. No
 * server lock is acquired: callers may already own one on this pinned connection.
 * All provider reads finish before the short shared resource-lock transaction. */
export async function refreshStorageObservations(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  env: Environment = {},
  scope?: StorageObservationScope,
) {
  if (scope !== undefined && !scopeSchema.safeParse(scope).success)
    throw new DomainError('validation_failed');
  const settings = await getSettings(db, env);
  const maxAgeMs = settings.values.observationMaxAgeSeconds * 1000;
  let hostId: string | undefined;
  if (typeof scope === 'string') {
    const target = await db
      .selectFrom('managed_servers as s')
      .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
      .select('n.physical_host_id')
      .where('s.id', '=', scope)
      .where('s.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!target) throw new DomainError('not_found');
    hostId = target.physical_host_id;
  } else if (scope && 'mappingId' in scope) {
    const target = await db
      .selectFrom('runtime_egg_mappings as m')
      .innerJoin('managed_nodes as n', 'n.id', 'm.node_id')
      .select('n.physical_host_id')
      .where('m.id', '=', scope.mappingId)
      .executeTakeFirst();
    if (!target) throw new DomainError('not_found');
    hostId = target.physical_host_id;
  } else if (scope && 'hostId' in scope) {
    const target = await db
      .selectFrom('physical_hosts')
      .select('id')
      .where('id', '=', scope.hostId)
      .executeTakeFirst();
    if (!target) throw new DomainError('not_found');
    hostId = target.id;
  }
  let query = db
    .selectFrom('managed_servers as s')
    .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
    .selectAll('s')
    .select('n.physical_host_id')
    .where('s.deleted_at', 'is', null)
    .where('s.pterodactyl_id', 'is not', null)
    .where(sql<number>`(s.limits->>'disk')::numeric`, '=', 0)
    .orderBy('s.id');
  if (hostId) query = query.where('n.physical_host_id', '=', hostId);
  const servers = await query.execute();
  if (!servers.length) return { observed: 0 };
  function stableBinding(server: (typeof servers)[number]) {
    return {
      id: server.id,
      ownerId: server.owner_id,
      projectId: server.project_id,
      nodeId: server.node_id,
      physicalHostId: server.physical_host_id,
      mappingId: server.mapping_id,
      providerUserId: server.provider_user_id,
      providerId: server.pterodactyl_id,
      providerUuid: server.pterodactyl_uuid,
      providerIdentifier: server.pterodactyl_identifier,
      externalId: server.external_id,
      limits: server.limits,
      installationState: server.installation_state,
      activeOperationId: server.active_operation_id,
      intent: server.intent,
      connectionMode: server.connection_mode,
      deletedAt: server.deleted_at,
    };
  }
  type Measurement = {
    server: (typeof servers)[number];
    remote: Awaited<ReturnType<PterodactylAdapter['getApplicationServer']>>;
    observedAt: Date;
    memory: number;
    cpu: number;
    disk: number;
    backup: number;
    rx: number;
    tx: number;
  };
  const measurements: Measurement[] = [];
  const errors: unknown[] = [];
  let next = 0;
  // Four servers, at most eight resources/backup reads in flight. Drain every
  // sibling before returning an error or releasing a caller-owned connection.
  await Promise.all(
    Array.from({ length: Math.min(4, servers.length) }, async () => {
      for (;;) {
        const server = servers[next++];
        if (!server) return;
        try {
          if (!server.pterodactyl_id || !server.pterodactyl_identifier || !server.pterodactyl_uuid)
            throw new DomainError('integration_unavailable');
          const remote = await adapter.getApplicationServer(server.pterodactyl_id);
          await verifyManagedIdentity(db, server, remote);
          const observedAt = new Date();
          const pair = await Promise.allSettled([
            adapter.getResources(server.pterodactyl_identifier),
            adapter.listBackups(server.pterodactyl_identifier),
          ]);
          const resources = pair[0],
            backups = pair[1];
          if (resources.status === 'rejected' || backups.status === 'rejected')
            throw new DomainError('integration_unavailable');
          const value = resources.value.resources;
          const bytes = [
            value.memory_bytes,
            value.disk_bytes,
            value.network_rx_bytes,
            value.network_tx_bytes,
          ];
          if (
            bytes.some((n) => !Number.isSafeInteger(n) || n < 0) ||
            !Number.isFinite(value.cpu_absolute) ||
            value.cpu_absolute < 0
          )
            throw new DomainError('integration_unavailable');
          const completed = backups.value;
          if (
            new Set(completed.map((b) => b.uuid)).size !== completed.length ||
            completed.some(
              (b) =>
                !b.completed_at ||
                !Number.isFinite(Date.parse(b.completed_at)) ||
                !Number.isSafeInteger(b.bytes) ||
                b.bytes < 0,
            )
          )
            throw new DomainError('integration_unavailable');
          const backup = completed.reduce((sum, item) => sum + item.bytes, 0);
          if (!Number.isSafeInteger(backup) || Date.now() - observedAt.getTime() > maxAgeMs)
            throw new DomainError('integration_unavailable');
          measurements.push({
            server,
            remote,
            observedAt,
            memory: value.memory_bytes,
            cpu: value.cpu_absolute,
            disk: value.disk_bytes,
            backup,
            rx: value.network_rx_bytes,
            tx: value.network_tx_bytes,
          });
        } catch (error) {
          errors.push(error);
        }
      }
    }),
  );
  if (errors.length) throw new DomainError('integration_unavailable');
  await db.transaction().execute(async (connection) => {
    await lockResources(connection);
    const currentSettings = await getSettings(connection, env);
    if (currentSettings.values.pterodactylBaseUrl !== settings.values.pterodactylBaseUrl)
      throw new DomainError('integration_unavailable');
    for (const sample of measurements) {
      const current = await connection
        .selectFrom('managed_servers as s')
        .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
        .selectAll('s')
        .select('n.physical_host_id')
        .where('s.id', '=', sample.server.id)
        .executeTakeFirst();
      // Reject changed identity/configuration or active operations, while routine
      // runtime/readiness telemetry updates do not invalidate the storage proof.
      if (
        !current ||
        !isDeepStrictEqual(stableBinding(current), stableBinding(sample.server)) ||
        Date.now() - sample.observedAt.getTime() >
          Math.min(maxAgeMs, currentSettings.values.observationMaxAgeSeconds * 1000) ||
        sample.observedAt.getTime() > Date.now()
      )
        throw new DomainError('integration_unavailable');
      await verifyManagedIdentity(connection, current, sample.remote);
      await connection
        .insertInto('server_metrics')
        .values({
          server_id: current.id,
          observed_at: sample.observedAt,
          memory_bytes: String(sample.memory),
          cpu_percent: sample.cpu,
          disk_bytes: String(sample.disk),
          backup_bytes: String(sample.backup),
          network_rx_bytes: String(sample.rx),
          network_tx_bytes: String(sample.tx),
        })
        .onConflict((c) =>
          c.columns(['server_id', 'observed_at']).doUpdateSet({
            memory_bytes: String(sample.memory),
            cpu_percent: sample.cpu,
            disk_bytes: String(sample.disk),
            backup_bytes: String(sample.backup),
            network_rx_bytes: String(sample.rx),
            network_tx_bytes: String(sample.tx),
          }),
        )
        .execute();
    }
  });
  return { observed: measurements.length };
}
