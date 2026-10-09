import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { type Environment, lockResources } from './admission.js';
import { ownerOnly, parse } from './registry.js';

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
    observerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine(
    (v) => v.memoryLimitMiB > v.memoryHeadroomMiB && v.cpuLimitPercent > v.cpuHeadroomPercent,
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
  if (!parsed.success) throw new DomainError('configuration_invalid');
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
      observer_id: value.observerId,
      enabled: value.enabled,
      updated_at: new Date(),
    };
    const reservations = await tx
      .selectFrom('resource_reservations')
      .selectAll()
      .where('physical_host_id', '=', hostId)
      .execute();
    if (
      reservations.reduce((sum, r) => sum + r.memory_mib, 0) >
        value.memoryLimitMiB - value.memoryHeadroomMiB ||
      reservations.reduce((sum, r) => sum + r.cpu_percent, 0) >
        value.cpuLimitPercent - value.cpuHeadroomPercent
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
) {
  ownerOnly(context);
  const value = parse(
    z
      .object({
        id: z.uuid().optional(),
        physicalHostId: z.uuid(),
        pterodactylNodeId: z.number().int().positive(),
        provisionUserId: z.number().int().positive(),
        enabled: z.boolean().default(true),
      })
      .strict(),
    input,
  );
  await adapter.getNode(value.pterodactylNodeId);
  const users = await adapter.listUsers();
  if (!users.some((u) => u.id === value.provisionUserId))
    throw new DomainError('validation_failed');
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const nodeId = value.id ?? randomUUID();
    if (
      value.id &&
      (await tx
        .selectFrom('managed_servers')
        .select('id')
        .where('node_id', '=', nodeId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst())
    )
      throw new DomainError('conflict');
    const row = {
      id: nodeId,
      physical_host_id: value.physicalHostId,
      pterodactyl_node_id: value.pterodactylNodeId,
      provision_user_id: value.provisionUserId,
      enabled: value.enabled,
    };
    await tx
      .insertInto('managed_nodes')
      .values(row)
      .onConflict((c) => c.column('id').doUpdateSet(row))
      .execute();
    await recordAudit(tx, context, 'resource.node.updated', { nodeId });
    return { id: nodeId };
  });
}
