import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
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
function unicastDirectAddress(value: string) {
  if (isIP(value) === 4) {
    const parts = value.split('.').map(Number);
    const a = parts[0] ?? 0,
      b = parts[1] ?? 0;
    return a > 0 && a < 224 && a !== 127 && !(a === 169 && b === 254);
  }
  return isIP(value) === 6 && (/^[23][0-9a-f]{3}:/.test(value) || privateBackendAddress(value));
}
export const directEndpointSchema = z
  .object({
    hostname: z
      .union([z.hostname(), z.ipv4(), z.ipv6()])
      .transform((value) =>
        isIP(value) ? canonicalAllocationAddress(value) : value.toLowerCase().replace(/\.$/, ''),
      )
      .refine((value) => (isIP(value) ? unicastDirectAddress(value) : value !== 'localhost')),
    port: z.number().int().min(1).max(65535),
  })
  .strict();
const loopbackRemapSchema = z
  .object({
    wingsVersion: z.literal('1.11.13'),
    networkMode: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/)
      .refine((value) => !['host', 'none', 'container', 'service'].includes(value.toLowerCase())),
    networkDriver: z.literal('bridge'),
    gatewayMode: z.literal('nat'),
    interfaceAddress: z
      .string()
      .refine((value) => isIP(value) === 4 && privateBackendAddress(value)),
    ispn: z.literal(false),
    verifiedEggs: z
      .array(
        z
          .object({
            nestId: z.number().int().positive(),
            eggId: z.number().int().positive(),
            forceOutgoingIp: z.literal(false),
          })
          .strict(),
      )
      .min(1)
      .max(1000)
      .refine(
        (eggs) => new Set(eggs.map((egg) => `${egg.nestId}:${egg.eggId}`)).size === eggs.length,
      ),
  })
  .strict();
/** Provider identity and effective Wings/Docker host binding are different for exact loopback. */
export function backendAllocationAddress(pin: { address: string; backendAddress?: string }) {
  return pin.backendAddress ?? pin.address;
}
export const backendAllocationPoolSchema = z
  .object({
    allocations: z
      .array(
        z
          .object({
            allocationId: z.number().int().positive(),
            address: exactAddress,
            backendAddress: exactAddress.optional(),
            delivery: z.enum(['backend', 'direct']).optional(),
            directEndpoint: directEndpointSchema.optional(),
            port: z.number().int().min(1).max(65535),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
    gatewayBindAddresses: z.array(exactAddress).max(32),
    loopbackRemap: loopbackRemapSchema.optional(),
  })
  .strict()
  .refine(
    (pool) =>
      new Set(pool.allocations.map((item) => item.allocationId)).size === pool.allocations.length &&
      new Set(pool.allocations.map((item) => `${backendAllocationAddress(item)}:${item.port}`))
        .size === pool.allocations.length &&
      new Set(pool.gatewayBindAddresses).size === pool.gatewayBindAddresses.length &&
      (pool.gatewayBindAddresses.length > 0 ||
        pool.allocations.every((pin) => pin.directEndpoint)) &&
      new Set(
        pool.allocations
          .filter((pin) => pin.directEndpoint)
          .map((pin) => `${pin.directEndpoint?.hostname}:${pin.directEndpoint?.port}`),
      ).size === pool.allocations.filter((pin) => pin.directEndpoint).length &&
      pool.allocations.every(
        (pin) =>
          (pin.delivery === 'direct'
            ? Boolean(pin.directEndpoint) && unicastDirectAddress(pin.address)
            : pin.address === '127.0.0.1' || privateBackendAddress(pin.address)) &&
          (pin.address === '127.0.0.1'
            ? pool.loopbackRemap !== undefined &&
              pin.backendAddress === pool.loopbackRemap.interfaceAddress
            : pin.backendAddress === undefined || pin.backendAddress === pin.address) &&
          (pin.delivery === 'direct' ||
            pool.gatewayBindAddresses.every(
              (gateway) => !allocationAddressesOverlap(backendAllocationAddress(pin), gateway),
            )),
      ),
  );
export type BackendAllocationPool = z.infer<typeof backendAllocationPoolSchema>;
export type BackendAllocation = Allocation & {
  backendAddress: string;
  delivery?: 'backend' | 'direct';
  directEndpoint?: { hostname: string; port: number };
};
export function poolAllowsLoopbackEgg(
  pool: BackendAllocationPool,
  mapping: { nest_id: number; egg_id: number },
) {
  return (
    pool.loopbackRemap?.verifiedEggs.some(
      (egg) => egg.nestId === mapping.nest_id && egg.eggId === mapping.egg_id,
    ) === true
  );
}
/** Unknown loopback semantics are not evidence of a disjoint host binding. */
function effectiveInventoryAddress(address: string, pool: BackendAllocationPool): string | null {
  const canonical = canonicalAllocationAddress(address);
  if (!canonical) return null;
  if (canonical === '127.0.0.1') return pool.loopbackRemap?.interfaceAddress ?? null;
  if (canonical === '::1' || /^127\./.test(canonical) || /^::ffff:7f[0-9a-f]{2}:/.test(canonical))
    return null;
  return canonical;
}
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
  const selected: BackendAllocation[] = [];
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
          (effectiveInventoryAddress(other.ip, pool) === null ||
            allocationAddressesOverlap(
              effectiveInventoryAddress(other.ip, pool) ?? '',
              backendAllocationAddress(pin),
            )),
      )
    )
      throw new DomainError('allocation_unavailable');
    selected.push({
      ...allocation,
      backendAddress: backendAllocationAddress(pin),
      delivery: pin.delivery,
      directEndpoint: pin.directEndpoint,
    });
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
    .select(['id', 'node_id', 'mapping_id', 'connection_mode'])
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
            allocation.backendAddress === claim.backend_address &&
            allocation.port === claim.port &&
            (server.connection_mode === 'direct'
              ? isDeepStrictEqual(allocation.directEndpoint ?? null, claim.direct_endpoint) &&
                claim.direct_endpoint !== null
              : allocation.delivery !== 'direct'),
        ),
    )
  )
    throw new DomainError('allocation_unavailable');
  const mapping = await db
    .selectFrom('runtime_egg_mappings')
    .select(['nest_id', 'egg_id'])
    .where('id', '=', server.mapping_id)
    .executeTakeFirstOrThrow();
  if (
    claims.some((claim) => claim.address === '127.0.0.1') &&
    !poolAllowsLoopbackEgg(pool, mapping)
  )
    throw new DomainError('allocation_unavailable');
  return claims.map((claim) => {
    const allocation = allocations.find((entry) => entry.id === claim.pterodactyl_allocation_id);
    if (!allocation) throw new DomainError('allocation_unavailable');
    return allocation;
  });
}

/** Direct bindings may share ingress IPs, but never an actual Gateway listener endpoint.
 * Backend-only IP separation and immutable claims still apply across the physical host.
 */
export async function assertBackendPoolNamespace(
  db: DB,
  node: { id: string; physical_host_id: string },
  pool: BackendAllocationPool,
  env: Environment = {},
) {
  const claims = await db
    .selectFrom('server_allocations as allocation')
    .innerJoin('managed_nodes as ownerNode', 'ownerNode.id', 'allocation.node_id')
    .innerJoin('managed_servers as ownerServer', 'ownerServer.id', 'allocation.server_id')
    .select([
      'allocation.node_id',
      'allocation.pterodactyl_allocation_id',
      'allocation.address',
      'allocation.backend_address',
      'allocation.port',
      'ownerServer.connection_mode',
    ])
    .where('ownerNode.physical_host_id', '=', node.physical_host_id)
    .execute();
  for (const claim of claims) {
    if (
      claim.node_id === node.id &&
      claim.address === '127.0.0.1' &&
      pool.loopbackRemap &&
      pool.loopbackRemap.interfaceAddress !== claim.backend_address
    )
      throw new DomainError('allocation_unavailable');
    if (
      claim.connection_mode !== 'direct' &&
      pool.gatewayBindAddresses.some((gateway) =>
        allocationAddressesOverlap(gateway, claim.backend_address),
      )
    )
      throw new DomainError('allocation_unavailable');
    for (const pin of pool.allocations) {
      const sameClaim =
        claim.node_id === node.id && claim.pterodactyl_allocation_id === pin.allocationId;
      if (
        sameClaim &&
        (claim.address !== pin.address ||
          claim.backend_address !== backendAllocationAddress(pin) ||
          claim.port !== pin.port ||
          (claim.connection_mode === 'gateway' && pin.delivery === 'direct'))
      )
        throw new DomainError('allocation_unavailable');
      if (
        !sameClaim &&
        claim.port === pin.port &&
        allocationAddressesOverlap(claim.backend_address, backendAllocationAddress(pin))
      )
        throw new DomainError('allocation_unavailable');
    }
  }
  // Disabled routes retain their endpoint for safe re-enabling; Pterodactyl
  // allocations reserve both transports, independently of the advertised role.
  const routes = await db
    .selectFrom('gateway_routes as route')
    .innerJoin('managed_servers as server', 'server.id', 'route.server_id')
    .innerJoin('managed_nodes as ownerNode', 'ownerNode.id', 'server.node_id')
    .select(['route.public_address', 'route.public_port'])
    .where('ownerNode.physical_host_id', '=', node.physical_host_id)
    .execute();
  if (
    routes.some(
      (route) =>
        pool.allocations.some(
          (pin) =>
            pin.port === route.public_port &&
            allocationAddressesOverlap(backendAllocationAddress(pin), route.public_address),
        ) ||
        claims.some(
          (claim) =>
            claim.port === route.public_port &&
            allocationAddressesOverlap(claim.backend_address, route.public_address),
        ),
    )
  )
    throw new DomainError('allocation_unavailable');
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
            entry.port === pin.port &&
            allocationAddressesOverlap(
              backendAllocationAddress(entry),
              backendAllocationAddress(pin),
            ),
        ),
      ) ||
        pool.allocations.some(
          (pin) =>
            pin.delivery !== 'direct' &&
            other.gatewayBindAddresses.some((gateway) =>
              allocationAddressesOverlap(backendAllocationAddress(pin), gateway),
            ),
        ) ||
        other.allocations.some(
          (pin) =>
            pin.delivery !== 'direct' &&
            pool.gatewayBindAddresses.some((gateway) =>
              allocationAddressesOverlap(backendAllocationAddress(pin), gateway),
            ),
        ))
    )
      throw new DomainError('allocation_unavailable');
  }
}
