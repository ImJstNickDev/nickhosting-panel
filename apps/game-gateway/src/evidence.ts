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

/** No sliding TTL: every consumer sees the original source-read timestamp. */
export function createEvidenceCache(maximumAgeMs: number, now = Date.now) {
  let value: z.infer<typeof gatewayEvidenceSchema> | undefined;
  let routes = new Map<string, GatewayRoute>();
  let contexts = new Map<string, z.infer<typeof gatewayEvidenceSchema>['contexts'][number]>();
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
    replace(input: unknown) {
      const next = gatewayEvidenceSchema.parse(input);
      const nextRoutes = new Map(next.snapshot.routes.map((route) => [route.id, route]));
      const nextContexts = new Map(next.contexts.map((entry) => [entry.routeId, entry]));
      const serverIds = new Set(next.servers.map((server) => server.id));
      if (
        nextRoutes.size !== next.snapshot.routes.length ||
        nextContexts.size !== next.contexts.length ||
        nextContexts.size !== nextRoutes.size ||
        serverIds.size !== next.servers.length ||
        new Set(next.nodes.map((node) => node.id)).size !== next.nodes.length ||
        new Set(next.allocations.map((node) => node.nodeId)).size !== next.allocations.length ||
        next.contexts.some(
          (entry) =>
            nextRoutes.get(entry.routeId)?.revision !== entry.routeRevision ||
            !serverIds.has(entry.context.providerServerId),
        ) ||
        next.observedAt > now() ||
        now() - next.observedAt > maximumAgeMs ||
        Date.parse(next.snapshot.expiresAt) <= now()
      )
        throw new DomainError('integration_unavailable');
      value = next;
      routes = nextRoutes;
      contexts = nextContexts;
      return next;
    },
  };
}
