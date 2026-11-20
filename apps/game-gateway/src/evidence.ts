import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '@nickhosting/core';
import { type GatewayRoute, gatewaySnapshotSchema } from '@nickhosting/game-sdk';
import {
  gatewayReachabilityProofSchema,
  gatewaySafetyContextSchema,
  safetyProviderAllocationSchema,
  safetyProviderNodeSchema,
  safetyProviderServerSchema,
} from '@nickhosting/gateway-safety';
import { z } from 'zod';

export const gatewayEvidenceSchema = z
  .object({
    observedAt: z.number().int().nonnegative(),
    configuration: z.record(z.string(), z.unknown()),
    snapshot: gatewaySnapshotSchema,
    contexts: z
      .array(
        z.object({
          routeId: z.uuid(),
          routeRevision: z.number().int().positive(),
          context: gatewaySafetyContextSchema,
          proof: gatewayReachabilityProofSchema.nullable(),
        }),
      )
      .max(10000),
    nodes: z.array(safetyProviderNodeSchema).max(1000),
    allocations: z
      .array(
        z.object({
          nodeId: z.number().int().positive(),
          allocations: z.array(safetyProviderAllocationSchema).max(100000),
        }),
      )
      .max(1000),
    servers: z.array(safetyProviderServerSchema).max(10000),
  })
  .strict();

type Evidence = z.infer<typeof gatewayEvidenceSchema>;

/** No sliding TTL: every consumer sees the original source-read timestamp. */
export function createEvidenceCache(maximumAgeMs: number, now = Date.now) {
  let value: Evidence | undefined;
  let routes = new Map<string, GatewayRoute>();
  let contexts = new Map<string, Evidence['contexts'][number]>();
  let servers = new Map<number, Evidence['servers'][number]>();
  let allocations = new Map<number, Evidence['allocations'][number]['allocations']>();
  const current = () =>
    value &&
    value.observedAt <= now() &&
    now() - value.observedAt <= maximumAgeMs &&
    Date.parse(value.snapshot.expiresAt) > now()
      ? value
      : undefined;
  return {
    current,
    route(route: GatewayRoute) {
      return current() && isDeepStrictEqual(routes.get(route.id), route)
        ? contexts.get(route.id)
        : undefined;
    },
    server(id: number) {
      return current() && servers.get(id);
    },
    allocations(nodeId: number) {
      return current() && allocations.get(nodeId);
    },
    serversForRoutes(routeIds: readonly string[]) {
      const snapshot = current();
      if (!snapshot) return undefined;
      const ids = new Set<number>();
      for (const routeId of routeIds) {
        const entry = contexts.get(routeId);
        if (!entry) return undefined;
        ids.add(entry.context.providerServerId);
      }
      return snapshot.servers.filter((server) => ids.has(server.id));
    },
    replace(input: unknown) {
      const next = gatewayEvidenceSchema.parse(input);
      const nextRoutes = new Map(next.snapshot.routes.map((route) => [route.id, route]));
      const nextContexts = new Map(next.contexts.map((entry) => [entry.routeId, entry]));
      const nextServers = new Map(next.servers.map((server) => [server.id, server]));
      const nextAllocations = new Map(
        next.allocations.map((node) => [node.nodeId, node.allocations]),
      );
      if (
        nextRoutes.size !== next.snapshot.routes.length ||
        nextContexts.size !== next.contexts.length ||
        nextContexts.size !== nextRoutes.size ||
        nextServers.size !== next.servers.length ||
        new Set(next.nodes.map((node) => node.id)).size !== next.nodes.length ||
        nextAllocations.size !== next.allocations.length ||
        next.contexts.some(
          (entry) =>
            nextRoutes.get(entry.routeId)?.revision !== entry.routeRevision ||
            !nextServers.has(entry.context.providerServerId),
        ) ||
        next.observedAt > now() ||
        now() - next.observedAt > maximumAgeMs ||
        Date.parse(next.snapshot.expiresAt) <= now()
      )
        throw new DomainError('integration_unavailable');
      value = next;
      routes = nextRoutes;
      contexts = nextContexts;
      servers = nextServers;
      allocations = nextAllocations;
      return next;
    },
  };
}
