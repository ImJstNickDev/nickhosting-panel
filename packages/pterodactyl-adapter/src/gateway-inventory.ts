import { isIP } from 'node:net';
import { z } from 'zod';
import { type createTransport, PterodactylError, parseInput } from './transport.js';
import { applicationServerSchema } from './types.js';

const id = z.number().int().positive();
const allocation = z
  .object({
    id,
    ip: z
      .string()
      .max(64)
      .refine((value) => isIP(value) !== 0),
    port: z.number().int().min(1).max(65535),
    assigned: z.boolean(),
  })
  .strict();
const identity = applicationServerSchema.pick({
  id: true,
  uuid: true,
  identifier: true,
  external_id: true,
  user: true,
  node: true,
  allocation: true,
  nest: true,
  egg: true,
  suspended: true,
});
export type GatewayInventoryServer = z.infer<typeof identity> &
  Pick<z.infer<typeof applicationServerSchema>, 'relationships'>;
const server = identity
  .extend({
    relationships: z
      .object({
        allocations: z
          .object({
            object: z.literal('list'),
            data: z.array(z.object({ attributes: allocation }).strict()).max(65536),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const inventory = z
  .object({
    schemaVersion: z.literal(1),
    nodes: z.array(z.object({ id, uuid: z.uuid() }).strict()).max(10000),
    allocations: z
      .array(z.object({ nodeId: id, allocations: z.array(allocation).max(65536) }).strict())
      .max(256),
    servers: z.array(server).max(10000),
  })
  .strict();
const request = z.object({
  nodeIds: z.array(id).max(256),
  serverUuids: z.array(z.uuid()).max(10000),
});
function matches<T>(returned: T[], requested: T[]) {
  const values = new Set(returned);
  return (
    values.size === returned.length &&
    returned.length === requested.length &&
    requested.every((key) => values.has(key))
  );
}
export async function readGatewayInventory(
  transport: ReturnType<typeof createTransport>,
  nodeIds: number[],
  serverUuids: string[],
) {
  const input = parseInput(request, { nodeIds, serverUuids });
  const value = await transport.json(
    'application',
    'extensions/nickhosting/gateway-inventory',
    inventory,
    'POST',
    input,
    false,
    { readOnly: true },
  );
  const invalid = (): never => {
    throw new PterodactylError('invalid_response', 'application', 'rejected');
  };
  const nodes = new Set(value.nodes.map((n) => n.id));
  if (
    nodes.size !== value.nodes.length ||
    new Set(value.nodes.map((n) => n.uuid)).size !== nodes.size ||
    !matches(
      value.allocations.map((group) => group.nodeId),
      nodeIds,
    ) ||
    !matches(
      value.servers.map((s) => s.uuid),
      serverUuids,
    ) ||
    new Set(value.servers.map((s) => s.id)).size !== value.servers.length
  )
    invalid();
  const all = new Map<number, z.infer<typeof allocation> & { nodeId: number }>();
  const scopedNodes = new Set(nodeIds);
  for (const group of value.allocations) {
    if (!nodes.has(group.nodeId)) invalid();
    for (const item of group.allocations) {
      if (all.has(item.id) || all.size >= 65536) invalid();
      all.set(item.id, { ...item, nodeId: group.nodeId });
    }
  }
  const owned = new Set<number>();
  for (const remote of value.servers) {
    if (!nodes.has(remote.node)) invalid();
    const claims = remote.relationships.allocations.data;
    if (!claims.some(({ attributes }) => attributes.id === remote.allocation)) invalid();
    for (const { attributes: item } of claims) {
      if (!item.assigned || owned.has(item.id) || owned.size >= 65536) invalid();
      owned.add(item.id);
      const known = all.get(item.id);
      if (
        (scopedNodes.has(remote.node) || known) &&
        (!known ||
          known.nodeId !== remote.node ||
          !known.assigned ||
          known.ip !== item.ip ||
          known.port !== item.port)
      )
        invalid();
    }
  }
  return value;
}
