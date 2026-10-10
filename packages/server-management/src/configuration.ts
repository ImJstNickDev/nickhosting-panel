import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources, reservedPhysicalCompute } from './admission.js';
import {
  assertBackendPoolNamespace,
  backendAllocationAddress,
  backendAllocationPoolOverrides,
  backendAllocationPoolSchema,
  effectiveBackendAllocationPool,
  validatedBackendInventory,
} from './allocation-pool.js';
import { ownerOnly, parse } from './registry.js';
import { uploadPolicyOverrides, uploadPolicySchema } from './upload-policy.js';

/** Explicit environment override wins over the Owner's per-node verified bound. */
export function effectiveNodeOverhead(
  node: { memory_overhead_percent: number },
  env: Environment = {},
) {
  const value =
    env.NH_NODE_MEMORY_OVERHEAD_PERCENT === undefined
      ? node.memory_overhead_percent
      : Number(env.NH_NODE_MEMORY_OVERHEAD_PERCENT);
  const parsed = z.number().int().min(100).max(400).safeParse(value);
  if (!parsed.success) throw new DomainError('configuration_invalid');
  return parsed.data;
}

export const hostPolicySchema = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(1).max(100),
    memoryLimitMiB: z.number().int().positive().max(1048576),
    cpuLimitPercent: z.number().int().positive().max(100000),
    storagePoolMiB: z.number().int().positive().max(1073741824),
    memoryHeadroomMiB: z.number().int().min(256),
    cpuHeadroomPercent: z.number().int().nonnegative(),
    diskHeadroomMiB: z.number().int().min(256),
    localDiskPath: z.string().min(1).refine(isAbsolute),
    uploadPolicy: uploadPolicySchema.nullable().optional(),
    observerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine(
    (v) =>
      v.memoryLimitMiB > v.memoryHeadroomMiB &&
      v.cpuLimitPercent > v.cpuHeadroomPercent &&
      v.storagePoolMiB > v.diskHeadroomMiB,
  );

/** Optional explicit host-policy override is resolved over each Owner database row. */
export function resolveHostOverride<
  T extends {
    id: string;
    memory_limit_mib: number;
    cpu_limit_percent: number;
    storage_pool_mib: string;
    memory_headroom_mib: number;
    cpu_headroom_percent: number;
    disk_headroom_mib: string;
    local_disk_path: string;
    observer_id: string;
    enabled: boolean;
  },
>(host: T, env: Environment): T {
  if (env.NH_HOST_POLICIES === undefined) return host;
  let raw: unknown;
  try {
    raw = JSON.parse(env.NH_HOST_POLICIES);
  } catch {
    throw new DomainError('configuration_invalid');
  }
  const parsed = z.record(z.uuid(), hostPolicySchema).safeParse(raw);
  if (
    !parsed.success ||
    Object.values(parsed.data).some((value) => value.uploadPolicy !== undefined)
  )
    throw new DomainError('configuration_invalid');
  const override = parsed.data[host.id];
  if (!override) return host;
  return {
    ...host,
    memory_limit_mib: override.memoryLimitMiB,
    cpu_limit_percent: override.cpuLimitPercent,
    storage_pool_mib: String(override.storagePoolMiB),
    memory_headroom_mib: override.memoryHeadroomMiB,
    cpu_headroom_percent: override.cpuHeadroomPercent,
    disk_headroom_mib: String(override.diskHeadroomMiB),
    local_disk_path: override.localDiskPath,
    observer_id: override.observerId,
    enabled: override.enabled,
  };
}

export async function setPhysicalHost(
  db: Kysely<Database>,
  context: AuthContext,
  input: unknown,
  env: Environment = {},
) {
  ownerOnly(context);
  const value = parse(hostPolicySchema, input);
  if (value.id && env.NH_HOST_POLICIES !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(env.NH_HOST_POLICIES);
    } catch {
      throw new DomainError('configuration_invalid');
    }
    const overrides = z.record(z.uuid(), hostPolicySchema).safeParse(raw);
    if (!overrides.success) throw new DomainError('configuration_invalid');
    if (overrides.data[value.id]) throw new DomainError('conflict');
  }
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const hostId = value.id ?? randomUUID();
    const previous = await tx
      .selectFrom('physical_hosts')
      .selectAll()
      .where('id', '=', hostId)
      .executeTakeFirst();
    const uploadPolicy =
      value.uploadPolicy === undefined ? (previous?.upload_policy ?? null) : value.uploadPolicy;
    const uploadOverrides = uploadPolicyOverrides(env);
    if (
      Object.hasOwn(uploadOverrides, hostId) &&
      value.uploadPolicy !== undefined &&
      !isDeepStrictEqual(value.uploadPolicy, previous?.upload_policy ?? null)
    )
      throw new DomainError('conflict');
    const uploadClaim = await tx
      .selectFrom('upload_ingestion_claims')
      .select('id')
      .where('physical_host_id', '=', hostId)
      .executeTakeFirst();
    if (
      uploadClaim &&
      (!previous ||
        !isDeepStrictEqual(uploadPolicy, previous.upload_policy) ||
        value.observerId !== previous.observer_id ||
        value.localDiskPath !== previous.local_disk_path ||
        value.enabled !== previous.enabled)
    )
      throw new DomainError('conflict');
    const row = {
      id: hostId,
      name: value.name,
      memory_limit_mib: value.memoryLimitMiB,
      cpu_limit_percent: value.cpuLimitPercent,
      storage_pool_mib: String(value.storagePoolMiB),
      memory_headroom_mib: value.memoryHeadroomMiB,
      cpu_headroom_percent: value.cpuHeadroomPercent,
      disk_headroom_mib: String(value.diskHeadroomMiB),
      local_disk_path: value.localDiskPath,
      upload_policy: uploadPolicy === null ? null : JSON.stringify(uploadPolicy),
      observer_id: value.observerId,
      enabled: value.enabled,
      updated_at: new Date(),
    };
    const reserved = await reservedPhysicalCompute(tx, hostId, env);
    if (
      reserved.memoryMiB > value.memoryLimitMiB - value.memoryHeadroomMiB ||
      reserved.cpuPercent > value.cpuLimitPercent - value.cpuHeadroomPercent
    )
      throw new DomainError('conflict');
    const occupied = await tx
      .selectFrom('managed_servers as server')
      .innerJoin('managed_nodes as node', 'node.id', 'server.node_id')
      .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
      .select(['server.limits', 'mapping.feature_limits'])
      .where('node.physical_host_id', '=', hostId)
      .where('server.deleted_at', 'is', null)
      .execute();
    if (
      occupied.reduce(
        (sum, server) => sum + server.limits.disk * (1 + server.feature_limits.backups),
        0,
      ) > value.storagePoolMiB
    )
      throw new DomainError('conflict');
    await tx
      .insertInto('physical_hosts')
      .values(row)
      .onConflict((c) => c.column('id').doUpdateSet(row))
      .execute();
    await tx.deleteFrom('host_observations').where('host_id', '=', hostId).execute();
    await recordAudit(tx, context, 'resource.host.updated', { hostId });
    return { id: hostId };
  });
}

export async function setManagedNode(
  db: Kysely<Database>,
  adapter: PterodactylAdapter,
  context: AuthContext,
  input: unknown,
  env: Environment = {},
) {
  ownerOnly(context);
  const value = parse(
    z
      .object({
        id: z.uuid().optional(),
        physicalHostId: z.uuid(),
        pterodactylNodeId: z.number().int().positive(),
        provisionUserId: z.number().int().positive(),
        installerMemoryMiB: z.number().int().positive().max(1048576).default(1024),
        installerCpuPercent: z.number().int().positive().max(100000).default(100),
        memoryOverheadPercent: z.number().int().min(100).max(400).default(115),
        backendAllocationPool: backendAllocationPoolSchema.nullable().optional(),
        enabled: z.boolean().default(true),
      })
      .strict(),
    input,
  );
  if (env.NH_NODE_MEMORY_OVERHEAD_PERCENT !== undefined)
    effectiveNodeOverhead({ memory_overhead_percent: value.memoryOverheadPercent }, env);
  const remoteNode = await adapter.getNode(value.pterodactylNodeId);
  if (remoteNode.id !== value.pterodactylNodeId) throw new DomainError('validation_failed');
  const users = await adapter.listUsers();
  if (!users.some((u) => u.id === value.provisionUserId))
    throw new DomainError('validation_failed');
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const nodeId = value.id ?? randomUUID();
    const host = await tx
      .selectFrom('physical_hosts')
      .select('id')
      .where('id', '=', value.physicalHostId)
      .executeTakeFirst();
    if (!host) throw new DomainError('not_found');
    const previous = value.id
      ? await tx
          .selectFrom('managed_nodes')
          .selectAll()
          .where('id', '=', value.id)
          .executeTakeFirst()
      : undefined;
    const pool =
      value.backendAllocationPool === undefined
        ? (previous?.backend_allocation_pool ?? null)
        : value.backendAllocationPool;
    const poolOverrides = backendAllocationPoolOverrides(env);
    if (
      Object.hasOwn(poolOverrides, nodeId) &&
      value.backendAllocationPool !== undefined &&
      !isDeepStrictEqual(value.backendAllocationPool, previous?.backend_allocation_pool ?? null)
    )
      throw new DomainError('conflict');
    const effectivePool = effectiveBackendAllocationPool(
      { id: nodeId, backend_allocation_pool: pool },
      env,
    );
    const claims = await tx
      .selectFrom('server_allocations')
      .innerJoin('managed_servers', 'managed_servers.id', 'server_allocations.server_id')
      .selectAll('server_allocations')
      .select('managed_servers.connection_mode')
      .where('server_allocations.node_id', '=', nodeId)
      .execute();
    if (
      claims.some(
        (claim) =>
          !effectivePool?.allocations.some(
            (pin) =>
              pin.allocationId === claim.pterodactyl_allocation_id &&
              pin.address === claim.address &&
              (claim.connection_mode !== 'gateway' || pin.delivery !== 'direct') &&
              (claim.direct_endpoint === null ||
                isDeepStrictEqual(pin.directEndpoint ?? null, claim.direct_endpoint)) &&
              backendAllocationAddress(pin) === claim.backend_address &&
              pin.port === claim.port,
          ),
      )
    )
      throw new DomainError('conflict');
    if (effectivePool) {
      const validated = await validatedBackendInventory(
        adapter,
        { id: nodeId, pterodactyl_node_id: value.pterodactylNodeId, backend_allocation_pool: pool },
        env,
      );
      if (
        validated.allocations.some(
          (allocation) =>
            allocation.assigned &&
            !claims.some((claim) => claim.pterodactyl_allocation_id === allocation.id),
        )
      )
        throw new DomainError('allocation_unavailable');
      await assertBackendPoolNamespace(
        tx,
        { id: nodeId, physical_host_id: value.physicalHostId },
        effectivePool,
        env,
      );
    }
    const overhead =
      env.NH_NODE_MEMORY_OVERHEAD_PERCENT === undefined
        ? value.memoryOverheadPercent
        : (previous?.memory_overhead_percent ?? 115);
    if (
      env.NH_NODE_MEMORY_OVERHEAD_PERCENT !== undefined &&
      typeof input === 'object' &&
      input !== null &&
      Object.hasOwn(input, 'memoryOverheadPercent') &&
      value.memoryOverheadPercent !== overhead
    )
      throw new DomainError('conflict');
    if (
      previous &&
      (previous.physical_host_id !== value.physicalHostId ||
        previous.pterodactyl_node_id !== value.pterodactylNodeId ||
        previous.provision_user_id !== value.provisionUserId) &&
      (await tx
        .selectFrom('managed_servers')
        .select('id')
        .where('node_id', '=', nodeId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst())
    )
      throw new DomainError('conflict');
    if (previous && previous.memory_overhead_percent !== overhead) {
      const game = await tx
        .selectFrom('resource_reservations as reservation')
        .innerJoin('managed_servers as server', 'server.id', 'reservation.server_id')
        .select('reservation.server_id')
        .where('server.node_id', '=', nodeId)
        .executeTakeFirst();
      const installer = await tx
        .selectFrom('installation_reservations as reservation')
        .innerJoin('managed_servers as server', 'server.id', 'reservation.server_id')
        .select('reservation.server_id')
        .where('server.node_id', '=', nodeId)
        .executeTakeFirst();
      if (game || installer) throw new DomainError('conflict');
    }
    if (
      previous &&
      (previous.installer_memory_mib !== value.installerMemoryMiB ||
        previous.installer_cpu_percent !== value.installerCpuPercent) &&
      (await tx
        .selectFrom('installation_reservations as installation')
        .innerJoin('managed_servers as server', 'server.id', 'installation.server_id')
        .select('installation.server_id')
        .where('server.node_id', '=', nodeId)
        .executeTakeFirst())
    )
      throw new DomainError('conflict');
    const row = {
      id: nodeId,
      physical_host_id: value.physicalHostId,
      pterodactyl_node_id: value.pterodactylNodeId,
      provision_user_id: value.provisionUserId,
      installer_memory_mib: value.installerMemoryMiB,
      installer_cpu_percent: value.installerCpuPercent,
      memory_overhead_percent: overhead,
      backend_allocation_pool: pool === null ? null : JSON.stringify(pool),
      enabled: value.enabled,
    };
    await tx
      .insertInto('managed_nodes')
      .values(row)
      .onConflict((c) => c.column('id').doUpdateSet(row))
      .execute();
    await recordAudit(tx, context, 'resource.node.updated', {
      nodeId,
      installerMemoryMiB: value.installerMemoryMiB,
      installerCpuPercent: value.installerCpuPercent,
      memoryOverheadPercent: overhead,
      backendPoolConfigured: pool !== null,
      backendAllocationIds: pool?.allocations.map((allocation) => allocation.allocationId) ?? [],
    });
    return { id: nodeId };
  });
}
