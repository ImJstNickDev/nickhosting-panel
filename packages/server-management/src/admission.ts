import { randomUUID } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, cpus } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { type AuthContext, assertPermission, DomainError } from '@nickhosting/core';
import { type Database, getSettings, type HostSnapshot, recordAudit } from '@nickhosting/database';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { effectiveNodeOverhead, resolveHostOverride } from './configuration.js';

export type DB = Kysely<Database> | Transaction<Database>;
export type Environment = Readonly<Record<string, string | undefined>>;
/** Using binary MiB for the full configured maximum is deliberately conservative
 * against Wings' decimal-byte conversion and its Owner-verified overhead bound. */
export function physicalMemoryMiB(configuredMiB: number, overheadPercent: number): number {
  if (
    !Number.isSafeInteger(configuredMiB) ||
    configuredMiB <= 0 ||
    !Number.isInteger(overheadPercent) ||
    overheadPercent < 100 ||
    overheadPercent > 400
  )
    throw new DomainError('configuration_invalid');
  const value = Math.ceil((configuredMiB * overheadPercent) / 100);
  if (!Number.isSafeInteger(value) || value > 2147483647)
    throw new DomainError('configuration_invalid');
  return value;
}

/** Never lower a durable commitment. An increased runtime override immediately
 * raises accounting for existing reservations, before their next reconciliation. */
export async function reservedPhysicalCompute(
  db: DB,
  hostId: string,
  env: Environment = {},
  exclude: { gameServerId?: string; installationServerId?: string } = {},
) {
  const games = await db
    .selectFrom('resource_reservations as reservation')
    .innerJoin('managed_servers as server', 'server.id', 'reservation.server_id')
    .innerJoin('managed_nodes as node', 'node.id', 'server.node_id')
    .select([
      'reservation.server_id',
      'reservation.memory_mib',
      'reservation.physical_memory_mib',
      'reservation.cpu_percent',
      'node.memory_overhead_percent',
    ])
    .where('reservation.physical_host_id', '=', hostId)
    .execute();
  const installations = await db
    .selectFrom('installation_reservations as reservation')
    .innerJoin('managed_servers as server', 'server.id', 'reservation.server_id')
    .innerJoin('managed_nodes as node', 'node.id', 'server.node_id')
    .select([
      'reservation.server_id',
      'reservation.memory_mib',
      'reservation.cpu_percent',
      'server.limits',
      'node.installer_memory_mib',
      'node.memory_overhead_percent',
    ])
    .where('reservation.physical_host_id', '=', hostId)
    .execute();
  let memoryMiB = 0,
    cpuPercent = 0;
  for (const row of games)
    if (row.server_id !== exclude.gameServerId) {
      memoryMiB += Math.max(
        row.physical_memory_mib,
        physicalMemoryMiB(row.memory_mib, effectiveNodeOverhead(row, env)),
      );
      cpuPercent += row.cpu_percent;
    }
  for (const row of installations)
    if (row.server_id !== exclude.installationServerId) {
      memoryMiB += Math.max(
        row.memory_mib,
        physicalMemoryMiB(
          Math.max(row.limits.memory, row.installer_memory_mib),
          effectiveNodeOverhead(row, env),
        ),
      );
      cpuPercent += row.cpu_percent;
    }
  return { memoryMiB, cpuPercent };
}
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

/** Full durable maxima are charged in addition to sampled host usage: telemetry
 * is not a coherent source of credits for either game or installer containers. */
function assertPhysicalCompute(
  { host, snapshot }: Awaited<ReturnType<typeof checkedObservation>>,
  memoryMiB: number,
  cpuPercent: number,
) {
  const freeMemory = Math.min(
    snapshot.availableMemoryMiB,
    host.memory_limit_mib - (snapshot.totalMemoryMiB - snapshot.availableMemoryMiB),
  );
  const freeCpu =
    Math.min(host.cpu_limit_percent, snapshot.cpuCapacityPercent) - snapshot.cpuBusyPercent;
  if (
    freeMemory - host.memory_headroom_mib < memoryMiB ||
    freeCpu - host.cpu_headroom_percent < cpuPercent
  )
    throw new DomainError('resources_unavailable');
}

/** Installation is physical host work, independent of the user's active game quota. */
export async function reserveInstallationInTransaction(
  tx: Transaction<Database>,
  serverId: string,
  jobId: string,
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
  if (server.active_operation_id && server.active_operation_id !== jobId)
    throw new DomainError('conflict');
  const operation = await tx
    .selectFrom('server_operations')
    .select('action')
    .where('job_id', '=', jobId)
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (!operation || !['provision', 'reinstall', 'wipe'].includes(operation.action))
    throw new DomainError('forbidden');
  const node = await tx
    .selectFrom('managed_nodes')
    .selectAll()
    .where('id', '=', server.node_id)
    .executeTakeFirstOrThrow();
  if (!node.enabled) throw new DomainError('resources_unavailable');
  const observed = await checkedObservation(tx, node.physical_host_id, env);
  const installations = await tx
    .selectFrom('installation_reservations')
    .selectAll()
    .where('physical_host_id', '=', node.physical_host_id)
    .execute();
  const current = installations.find((row) => row.server_id === serverId);
  if (current && current.operation_id !== jobId) throw new DomainError('conflict');
  const memoryMiB = Math.max(
    current?.memory_mib ?? 0,
    physicalMemoryMiB(
      Math.max(server.limits.memory, node.installer_memory_mib),
      effectiveNodeOverhead(node, env),
    ),
  );
  const cpuPercent = Math.max(server.limits.cpu, node.installer_cpu_percent);
  const reserved = await reservedPhysicalCompute(tx, node.physical_host_id, env, {
    installationServerId: serverId,
  });
  assertPhysicalCompute(observed, reserved.memoryMiB + memoryMiB, reserved.cpuPercent + cpuPercent);
  await tx
    .insertInto('installation_reservations')
    .values({
      server_id: serverId,
      physical_host_id: node.physical_host_id,
      operation_id: jobId,
      memory_mib: memoryMiB,
      cpu_percent: cpuPercent,
    })
    .onConflict((conflict) =>
      conflict.column('server_id').doUpdateSet({
        memory_mib: memoryMiB,
        cpu_percent: cpuPercent,
        updated_at: new Date(),
      }),
    )
    .execute();
}

export async function reserveInstallation(
  db: Kysely<Database>,
  serverId: string,
  jobId: string,
  env: Environment = {},
) {
  return db
    .transaction()
    .execute((tx) => reserveInstallationInTransaction(tx, serverId, jobId, env));
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
  const observed = await checkedObservation(tx, node.physical_host_id, env);
  const { host, config } = observed;
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
  // The host sample includes all actual workload. Panel telemetry may be cached for
  // twenty seconds and is not coherent with this sample: crediting it can count
  // recently freed memory twice. M2 therefore reserves the FULL configured maximum
  // in addition to measured host usage. This deliberately errs toward admission denial.
  const reserved = await reservedPhysicalCompute(tx, host.id, env, { gameServerId: serverId });
  const physicalMemory = Math.max(
    current?.physical_memory_mib ?? 0,
    physicalMemoryMiB(server.limits.memory, effectiveNodeOverhead(node, env)),
  );
  assertPhysicalCompute(
    observed,
    reserved.memoryMiB + physicalMemory,
    reserved.cpuPercent + server.limits.cpu,
  );
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
      physical_memory_mib: physicalMemory,
      cpu_percent: server.limits.cpu,
      operation_id: jobId,
      state: action === 'restart' ? 'restarting' : 'starting',
    })
    .onConflict((c) =>
      c.column('server_id').doUpdateSet({
        physical_memory_mib: physicalMemory,
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
  // Persisted file telemetry is not a coherent filesystem sample and can be stale
  // after a user removes content. Do not credit it against durable disk allowances.
  if (hostReserved + additionalMiB > snapshot.availableDiskMiB - Number(host.disk_headroom_mib))
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
      c.column('host_id').doUpdateSet({
        snapshot: JSON.stringify(snapshot),
        observed_at: now,
        observer_id: observerId,
      }),
    )
    .execute();
  return snapshot;
}

export const resourceRunId = () => randomUUID();
