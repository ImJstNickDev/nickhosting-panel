import { randomUUID } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, cpus } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { type AuthContext, assertPermission, DomainError } from '@nickhosting/core';
import { type Database, getSettings, type HostSnapshot, recordAudit } from '@nickhosting/database';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { resolveHostOverride } from './configuration.js';

export type DB = Kysely<Database> | Transaction<Database>;
export type Environment = Readonly<Record<string, string | undefined>>;
const quantity = z.number().finite().nonnegative();
export const hostSnapshotSchema = z
  .object({
    totalMemoryMiB: quantity.positive(),
    availableMemoryMiB: quantity,
    cpuCapacityPercent: quantity.positive(),
    cpuBusyPercent: quantity,
    availableDiskMiB: quantity,
    managed: z.record(z.uuid(), z.object({ memoryMiB: quantity, cpuPercent: quantity }).strict()),
    observedAt: z.iso.datetime(),
  })
  .strict();

/** Host and user locks have one global order across creation/admission/policy updates. */
export async function lockResources(tx: DB) {
  await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':resources',0))`.execute(
    tx,
  );
}

export async function checkedObservation(tx: DB, hostId: string, env: Environment = {}) {
  const stored = await tx
    .selectFrom('physical_hosts')
    .selectAll()
    .where('id', '=', hostId)
    .executeTakeFirst();
  const host = stored ? resolveHostOverride(stored, env) : undefined;
  const observation = await tx
    .selectFrom('host_observations')
    .selectAll()
    .where('host_id', '=', hostId)
    .executeTakeFirst();
  const { values: config } = await getSettings(tx, env);
  const parsed = hostSnapshotSchema.safeParse(observation?.snapshot);
  const age = observation ? Date.now() - observation.observed_at.getTime() : Infinity;
  if (
    !host?.enabled ||
    !observation ||
    observation.observer_id !== host.observer_id ||
    !parsed.success ||
    age < 0 ||
    age > config.observationMaxAgeSeconds * 1000
  )
    throw new DomainError('resources_unavailable');
  if (
    parsed.data.availableMemoryMiB > parsed.data.totalMemoryMiB ||
    new Date(parsed.data.observedAt).getTime() !== observation.observed_at.getTime()
  )
    throw new DomainError('resources_unavailable');
  return { host, snapshot: parsed.data, config };
}

export async function reserveStartInTransaction(
  tx: Transaction<Database>,
  serverId: string,
  jobId: string,
  action: 'start' | 'restart',
  env: Environment = {},
) {
  await lockResources(tx);
  const server = await tx
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!server) throw new DomainError('not_found');
  const node = await tx
    .selectFrom('managed_nodes')
    .selectAll()
    .where('id', '=', server.node_id)
    .executeTakeFirstOrThrow();
  if (!node.enabled) throw new DomainError('resources_unavailable');
  const { host, snapshot, config } = await checkedObservation(tx, node.physical_host_id, env);
  const reservations = await tx.selectFrom('resource_reservations').selectAll().execute();
  const current = reservations.find((r) => r.server_id === serverId);
  const limits = await tx
    .selectFrom('resource_user_limits')
    .selectAll()
    .where('user_id', '=', server.owner_id)
    .executeTakeFirst();
  const activeLimits =
    limits && (!limits.expires_at || limits.expires_at > new Date()) ? limits : undefined;
  const userMemory = activeLimits?.memory_mib ?? config.defaultUserMemoryMiB;
  const userCpu = activeLimits?.cpu_percent ?? config.defaultUserCpuPercent;
  const mine = reservations.filter(
    (r) => r.owner_id === server.owner_id && r.server_id !== serverId,
  );
  if (
    mine.reduce((sum, r) => sum + r.memory_mib, 0) + server.limits.memory > userMemory ||
    mine.reduce((sum, r) => sum + r.cpu_percent, 0) + server.limits.cpu > userCpu
  )
    throw new DomainError('resources_unavailable');
  // The host snapshot already includes ALL processes, including direct Pterodactyl
  // and unrelated services. Add only the unconsumed portion of active reservations.
  const hostReservations = reservations.filter(
    (r) => r.physical_host_id === host.id && r.server_id !== serverId,
  );
  let pendingMemory = 0,
    pendingCpu = 0;
  for (const reservation of hostReservations) {
    const usage = snapshot.managed[reservation.server_id];
    pendingMemory += Math.max(0, reservation.memory_mib - (usage?.memoryMiB ?? 0));
    pendingCpu += Math.max(0, reservation.cpu_percent - (usage?.cpuPercent ?? 0));
  }
  const ownUsage = snapshot.managed[serverId];
  const additionalMemory = Math.max(0, server.limits.memory - (ownUsage?.memoryMiB ?? 0));
  const additionalCpu = Math.max(0, server.limits.cpu - (ownUsage?.cpuPercent ?? 0));
  const freeMemory = Math.min(
    snapshot.availableMemoryMiB,
    host.memory_limit_mib - (snapshot.totalMemoryMiB - snapshot.availableMemoryMiB),
  );
  const freeCpu =
    Math.min(host.cpu_limit_percent, snapshot.cpuCapacityPercent) - snapshot.cpuBusyPercent;
  if (
    freeMemory - host.memory_headroom_mib < pendingMemory + additionalMemory ||
    freeCpu - host.cpu_headroom_percent < pendingCpu + additionalCpu
  )
    throw new DomainError('resources_unavailable');
  if (
    current &&
    current.state !== 'running' &&
    current.operation_id !== jobId &&
    server.active_operation_id !== jobId
  )
    throw new DomainError('conflict');
  await tx
    .insertInto('resource_reservations')
    .values({
      server_id: serverId,
      owner_id: server.owner_id,
      physical_host_id: host.id,
      memory_mib: server.limits.memory,
      cpu_percent: server.limits.cpu,
      operation_id: jobId,
      state: action === 'restart' ? 'restarting' : 'starting',
    })
    .onConflict((c) =>
      c
        .column('server_id')
        .doUpdateSet({
          operation_id: jobId,
          state: action === 'restart' ? 'restarting' : 'starting',
          updated_at: new Date(),
        }),
    )
    .execute();
}

export async function reserveStart(
  db: Kysely<Database>,
  serverId: string,
  jobId: string,
  action: 'start' | 'restart',
  env: Environment = {},
) {
  return db
    .transaction()
    .execute((tx) => reserveStartInTransaction(tx, serverId, jobId, action, env));
}

/** Reservations cover maximum server disk plus every permitted backup slot. */
export async function checkStorage(
  tx: DB,
  ownerId: string,
  hostId: string,
  additionalMiB: number,
  env: Environment = {},
  excludeServerId?: string,
) {
  await lockResources(tx);
  const { host, snapshot, config } = await checkedObservation(tx, hostId, env);
  const rows = await tx
    .selectFrom('managed_servers as s')
    .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
    .innerJoin('runtime_egg_mappings as m', 'm.id', 's.mapping_id')
    .select(['s.id', 's.owner_id', 's.limits', 'm.feature_limits', 'n.physical_host_id'])
    .where('s.deleted_at', 'is', null)
    .execute();
  const active = rows.filter((r) => r.id !== excludeServerId);
  const allowance = (row: (typeof rows)[number]) =>
    row.limits.disk * (1 + row.feature_limits.backups);
  const hostReserved = active
    .filter((r) => r.physical_host_id === hostId)
    .reduce((sum, r) => sum + allowance(r), 0);
  if (
    hostReserved + additionalMiB > Number(host.storage_pool_mib) ||
    additionalMiB > snapshot.availableDiskMiB - Number(host.disk_headroom_mib)
  )
    throw new DomainError('storage_exhausted');
  // Unconsumed disk allowances remain reserved while offline; concurrent creations
  // cannot rely repeatedly on the same free filesystem sample.
  const usage = await tx
    .selectFrom('server_metrics')
    .select(['server_id', 'disk_bytes'])
    .distinctOn('server_id')
    .orderBy('server_id')
    .orderBy('observed_at', 'desc')
    .execute();
  const used = new Map(usage.map((r) => [r.server_id, Number(r.disk_bytes) / 1048576]));
  const unconsumed = active
    .filter((r) => r.physical_host_id === hostId)
    .reduce((sum, r) => sum + Math.max(0, allowance(r) - (used.get(r.id) ?? 0)), 0);
  if (unconsumed + additionalMiB > snapshot.availableDiskMiB - Number(host.disk_headroom_mib))
    throw new DomainError('storage_exhausted');
  if (config.storagePolicy === 'PER_USER_BUDGET') {
    const limits = await tx
      .selectFrom('resource_user_limits')
      .selectAll()
      .where('user_id', '=', ownerId)
      .executeTakeFirst();
    const budget =
      limits && (!limits.expires_at || limits.expires_at > new Date())
        ? Number(limits.storage_mib)
        : config.defaultUserStorageMiB;
    if (
      active.filter((r) => r.owner_id === ownerId).reduce((sum, r) => sum + allowance(r), 0) +
        additionalMiB >
      budget
    )
      throw new DomainError('storage_exhausted');
  }
}

export async function setUserLimits(db: Kysely<Database>, context: AuthContext, input: unknown) {
  assertPermission(context, 'platform:manage');
  if (context.sessionType !== 'regular') throw new DomainError('forbidden');
  const parsed = z
    .object({
      userId: z.string().min(1),
      memoryMiB: z.number().int().positive(),
      cpuPercent: z.number().int().positive(),
      storageMiB: z.number().int().positive(),
      expiresAt: z.iso.datetime().optional(),
      reason: z.string().trim().min(8).max(300),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) throw new DomainError('validation_failed');
  const value = parsed.data;
  if (value.expiresAt && new Date(value.expiresAt) <= new Date())
    throw new DomainError('validation_failed');
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const active = await tx
      .selectFrom('resource_reservations')
      .selectAll()
      .where('owner_id', '=', value.userId)
      .execute();
    if (
      active.reduce((s, r) => s + r.memory_mib, 0) > value.memoryMiB ||
      active.reduce((s, r) => s + r.cpu_percent, 0) > value.cpuPercent
    )
      throw new DomainError('conflict');
    const disks = await tx
      .selectFrom('managed_servers as s')
      .innerJoin('runtime_egg_mappings as m', 'm.id', 's.mapping_id')
      .select(['s.limits', 'm.feature_limits'])
      .where('s.owner_id', '=', value.userId)
      .where('s.deleted_at', 'is', null)
      .execute();
    if (
      disks.reduce((sum, r) => sum + r.limits.disk * (1 + r.feature_limits.backups), 0) >
      value.storageMiB
    )
      throw new DomainError('conflict');
    const row = {
      user_id: value.userId,
      memory_mib: value.memoryMiB,
      cpu_percent: value.cpuPercent,
      storage_mib: String(value.storageMiB),
      expires_at: value.expiresAt ? new Date(value.expiresAt) : null,
      updated_at: new Date(),
    };
    await tx
      .insertInto('resource_user_limits')
      .values(row)
      .onConflict((c) => c.column('user_id').doUpdateSet(row))
      .execute();
    await recordAudit(tx, context, 'resource.user_limits.updated', { ...value });
  });
}

/** Explicit local observer identity prevents silently sampling this host for a remote node. */
export async function observeLocalHost(
  db: Kysely<Database>,
  hostId: string,
  observerId: string,
  managed: HostSnapshot['managed'],
  env: Environment = {},
) {
  const host = resolveHostOverride(
    await db
      .selectFrom('physical_hosts')
      .selectAll()
      .where('id', '=', hostId)
      .executeTakeFirstOrThrow(),
    env,
  );
  if (host.observer_id !== observerId) throw new DomainError('configuration_invalid');
  const before = cpus().map((cpu) => cpu.times);
  await delay(250);
  const after = cpus().map((cpu) => cpu.times);
  let idle = 0,
    total = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const a = after[i],
      b = before[i];
    if (!a || !b) continue;
    idle += a.idle - b.idle;
    total +=
      Object.values(a).reduce((s, v) => s + v, 0) - Object.values(b).reduce((s, v) => s + v, 0);
  }
  const info = await readFile('/proc/meminfo', 'utf8');
  const amount = (name: string) =>
    Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(info)?.[1]) / 1024;
  const disk = await statfs(host.local_disk_path);
  const now = new Date();
  const snapshot = hostSnapshotSchema.parse({
    totalMemoryMiB: amount('MemTotal'),
    availableMemoryMiB: amount('MemAvailable'),
    cpuCapacityPercent: availableParallelism() * 100,
    cpuBusyPercent: total
      ? Math.max(0, (1 - idle / total) * availableParallelism() * 100)
      : availableParallelism() * 100,
    availableDiskMiB: (disk.bavail * disk.bsize) / 1048576,
    managed,
    observedAt: now.toISOString(),
  });
  await db
    .insertInto('host_observations')
    .values({
      host_id: hostId,
      observer_id: observerId,
      snapshot: JSON.stringify(snapshot),
      observed_at: now,
    })
    .onConflict((c) =>
      c
        .column('host_id')
        .doUpdateSet({
          snapshot: JSON.stringify(snapshot),
          observed_at: now,
          observer_id: observerId,
        }),
    )
    .execute();
  return snapshot;
}

export const resourceRunId = () => randomUUID();
