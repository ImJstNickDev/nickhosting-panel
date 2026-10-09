import { isIP } from 'node:net';
import { DomainError } from '@nickhosting/core';
import type { Allocation, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { z } from 'zod';
import type { DB, Environment } from './admission.js';

export function canonicalAllocationAddress(address: string): string {
  if (!isIP(address) || address.includes('%')) return '';
  try {
    return isIP(address) === 6 ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address;
  } catch {
    return '';
  }
}
export function allocationAddressesOverlap(first: string, second: string) {
  const bindingAddress = (value: string) => {
    const canonical = canonicalAllocationAddress(value);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
    if (!mapped) return canonical;
    const high = Number.parseInt(mapped[1] ?? '', 16),
      low = Number.parseInt(mapped[2] ?? '', 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  };
  const a = bindingAddress(first),
    b = bindingAddress(second);
  return !a || !b || a === b || ['0.0.0.0', '::'].includes(a) || ['0.0.0.0', '::'].includes(b);
}

function privateBackendAddress(value: string) {
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return (
      a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168)
    );
  }
  return isIP(value) === 6 && /^(fc|fd)/.test(value) && canonicalAllocationAddress(value) === value;
}
const exactAddress = z
  .string()
  .refine(
    (value) =>
      Boolean(isIP(value)) &&
      canonicalAllocationAddress(value) === value &&
      !['0.0.0.0', '::'].includes(value) &&
      !value.startsWith('::ffff:'),
  );
export const backendAllocationPoolSchema = z
  .object({
    allocations: z
      .array(
        z
          .object({
            allocationId: z.number().int().positive(),
            address: z.string().refine(privateBackendAddress),
            port: z.number().int().min(1).max(65535),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
    gatewayBindAddresses: z.array(exactAddress).min(1).max(32),
  })
  .strict()
  .refine(
    (pool) =>
      new Set(pool.allocations.map((item) => item.allocationId)).size === pool.allocations.length &&
      new Set(pool.allocations.map((item) => `${item.address}:${item.port}`)).size ===
        pool.allocations.length &&
      new Set(pool.gatewayBindAddresses).size === pool.gatewayBindAddresses.length &&
      pool.allocations.every((allocation) =>
        pool.gatewayBindAddresses.every(
          (gateway) => !allocationAddressesOverlap(allocation.address, gateway),
        ),
      ),
  );
export type BackendAllocationPool = z.infer<typeof backendAllocationPoolSchema>;
const overridesSchema = z.record(z.uuid(), backendAllocationPoolSchema.nullable());
export function backendAllocationPoolOverrides(env: Environment = {}) {
  if (env.NH_BACKEND_ALLOCATION_POOLS === undefined) return {};
  try {
    return overridesSchema.parse(JSON.parse(env.NH_BACKEND_ALLOCATION_POOLS));
  } catch {
    throw new DomainError('configuration_invalid');
  }
}
export function effectiveBackendAllocationPool(
  node: { id: string; backend_allocation_pool: BackendAllocationPool | null },
  env: Environment = {},
): BackendAllocationPool | null {
  const overrides = backendAllocationPoolOverrides(env);
  const value = Object.hasOwn(overrides, node.id)
    ? overrides[node.id]
    : node.backend_allocation_pool;
  const result = backendAllocationPoolSchema.nullable().safeParse(value);
  if (!result.success) throw new DomainError('configuration_invalid');
  return result.data;
}
/** IDs are scoped to the requested node; every pinned address/port must still match. */
export async function validatedBackendInventory(
  adapter: PterodactylAdapter,
  node: {
    id: string;
    pterodactyl_node_id: number;
    backend_allocation_pool: BackendAllocationPool | null;
  },
  env: Environment = {},
) {
  const pool = effectiveBackendAllocationPool(node, env);
  if (!pool) throw new DomainError('allocation_unavailable');
  const remote = await adapter.getNode(node.pterodactyl_node_id);
  if (remote.id !== node.pterodactyl_node_id) throw new DomainError('allocation_unavailable');
  const inventory = await adapter.listAllocations(node.pterodactyl_node_id);
  const selected: Allocation[] = [];
  for (const pin of pool.allocations) {
    const matches = inventory.filter((allocation) => allocation.id === pin.allocationId);
    const allocation = matches[0];
    if (
      matches.length !== 1 ||
      !allocation ||
      canonicalAllocationAddress(allocation.ip) !== pin.address ||
      allocation.port !== pin.port
    )
      throw new DomainError('allocation_unavailable');
    if (
      inventory.some(
        (other) =>
          other.id !== allocation.id &&
          other.assigned &&
          other.port === allocation.port &&
          (!canonicalAllocationAddress(other.ip) ||
            allocationAddressesOverlap(other.ip, allocation.ip)),
      )
    )
      throw new DomainError('allocation_unavailable');
    selected.push(allocation);
  }
  return { pool, allocations: selected };
}
/** Recheck the effective configured pool and immutable claim before a provisioning effect. */
export async function assertServerBackendAllocations(
  db: DB,
  adapter: PterodactylAdapter,
  serverId: string,
  env: Environment = {},
) {
  const server = await db
    .selectFrom('managed_servers')
    .select(['id', 'node_id'])
    .where('id', '=', serverId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!server) throw new DomainError('not_found');
  const node = await db
    .selectFrom('managed_nodes')
    .selectAll()
    .where('id', '=', server.node_id)
    .executeTakeFirstOrThrow();
  const { pool, allocations } = await validatedBackendInventory(adapter, node, env);
  await assertBackendPoolNamespace(db, node, pool, env);
  const claims = await db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', server.id)
    .execute();
  if (
    !claims.length ||
    new Set(claims.map((claim) => claim.pterodactyl_allocation_id)).size !== claims.length ||
    claims.some(
      (claim) =>
        claim.node_id !== node.id ||
        !allocations.some(
          (allocation) =>
            !allocation.assigned &&
            allocation.id === claim.pterodactyl_allocation_id &&
            canonicalAllocationAddress(allocation.ip) === claim.address &&
            allocation.port === claim.port,
        ),
    )
  )
    throw new DomainError('allocation_unavailable');
  return claims.map((claim) => {
    const allocation = allocations.find((entry) => entry.id === claim.pterodactyl_allocation_id);
    if (!allocation) throw new DomainError('allocation_unavailable');
    return allocation;
  });
}

/** Owner/environment pool edits cannot overlap another node's backend or gateway namespace. */
export async function assertBackendPoolNamespace(
  db: DB,
  node: { id: string; physical_host_id: string },
  pool: BackendAllocationPool,
  env: Environment = {},
) {
  const siblings = await db
    .selectFrom('managed_nodes')
    .selectAll()
    .where('physical_host_id', '=', node.physical_host_id)
    .where('id', '!=', node.id)
    .execute();
  for (const sibling of siblings) {
    const other = effectiveBackendAllocationPool(sibling, env);
    if (
      other &&
      (pool.allocations.some((pin) =>
        other.allocations.some(
          (entry) =>
            entry.port === pin.port && allocationAddressesOverlap(entry.address, pin.address),
        ),
      ) ||
        pool.allocations.some((pin) => other.gatewayBindAddresses.includes(pin.address)) ||
        other.allocations.some((pin) => pool.gatewayBindAddresses.includes(pin.address)))
    )
      throw new DomainError('allocation_unavailable');
  }
}
