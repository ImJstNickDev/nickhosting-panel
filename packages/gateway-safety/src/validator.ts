import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { DomainError } from '@nickhosting/core';
import {
  type GatewayEndpoint,
  type GatewayRoute,
  type GatewaySafety,
  gatewayRouteSchema,
} from '@nickhosting/game-sdk';
import type {
  NetworkObservation,
  NetworkObserver,
  ObservedContainer,
  ObservedNetwork,
} from '@nickhosting/pterodactyl-adapter';
import { z } from 'zod';
import {
  addressesOverlap,
  canonicalAddress,
  endpointsOverlap,
  exactBindableAddress,
  exactEndpoint,
} from './addresses.js';

const numericId = z.number().int().positive();
const privateV4 = (address: string) => {
  const [a, b] = address.split('.').map(Number);
  return (
    isIP(address) === 4 &&
    (a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168))
  );
};
const privateBackend = (address: string) =>
  privateV4(address) ||
  (isIP(address) === 6 && /^(fc|fd)/.test(address) && canonicalAddress(address) === address);

export const gatewaySafetyContextSchema = z
  .object({
    providerServerId: numericId,
    providerServerUuid: z.uuid(),
    externalId: z.string().min(1).max(191),
    providerUserId: numericId,
    providerNodeId: numericId,
    providerAllocationId: numericId,
    nestId: numericId,
    eggId: numericId,
  })
  .strict();
export type GatewaySafetyContext = z.infer<typeof gatewaySafetyContextSchema>;

const networkName = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/)
  .refine((value) => !['host', 'none', 'container', 'service'].includes(value.toLowerCase()));
export const gatewayNetworkPolicySchema = z
  .object({
    nodes: z
      .array(
        z
          .object({
            nodeId: numericId,
            nodeUuid: z.string().min(1).max(128),
            networkMode: networkName,
            loopbackRemap: z
              .object({
                wingsVersion: z.literal('1.11.13'),
                interfaceAddress: z.string().refine(privateV4),
                ispn: z.literal(false),
                verifiedEggs: z
                  .array(
                    z
                      .object({
                        nestId: numericId,
                        eggId: numericId,
                        forceOutgoingIp: z.literal(false),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(1000),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    maximumObservationAgeMs: z.number().int().min(100).max(15000),
  })
  .strict()
  .refine((value) => new Set(value.nodes.map((node) => node.nodeId)).size === value.nodes.length);
export type GatewayNetworkPolicy = z.infer<typeof gatewayNetworkPolicySchema>;

export const gatewayReachabilityProofSchema = z
  .object({
    version: z.literal(1),
    routeId: z.uuid(),
    serverId: z.uuid(),
    allocationId: z.uuid(),
    namespaceId: z.string().regex(/^net:\[\d+\]$/),
    dockerDaemonId: z.string().min(1).max(128),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    verifiedAt: z.number().int().positive(),
  })
  .strict();
export type GatewayReachabilityProof = z.infer<typeof gatewayReachabilityProofSchema>;

/** Core supplies an authenticated, read-only facade; provider API keys never enter Gateway. */
export const safetyProviderNodeSchema = z
  .object({ id: numericId, uuid: z.string().min(1).max(128) })
  .strict();
export const safetyProviderAllocationSchema = z
  .object({
    id: numericId,
    ip: z
      .string()
      .max(45)
      .refine((value) => isIP(value) !== 0),
    port: z.number().int().min(1).max(65535),
    assigned: z.boolean(),
  })
  .strict();
export const safetyProviderServerSchema = z
  .object({
    id: numericId,
    uuid: z.uuid(),
    external_id: z.string().max(191).nullable(),
    user: numericId,
    node: numericId,
    nest: numericId,
    egg: numericId,
    suspended: z.boolean(),
    relationships: z
      .object({
        allocations: z
          .object({
            object: z.literal('list'),
            data: z
              .array(z.object({ attributes: safetyProviderAllocationSchema }).strict())
              .max(10000),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export interface GatewayProviderSource {
  listNodes(): Promise<z.infer<typeof safetyProviderNodeSchema>[]>;
  listAllocations(nodeId: number): Promise<z.infer<typeof safetyProviderAllocationSchema>[]>;
  getApplicationServer(serverId: number): Promise<z.infer<typeof safetyProviderServerSchema>>;
}
export interface GatewaySafetyOptions {
  provider: GatewayProviderSource;
  observer: NetworkObserver;
  policy: GatewayNetworkPolicy;
  resolveContext(route: GatewayRoute): Promise<GatewaySafetyContext>;
  loadProof(route: GatewayRoute): Promise<GatewayReachabilityProof | null>;
  saveProof(route: GatewayRoute, proof: GatewayReachabilityProof): Promise<void>;
  /** Actual game-protocol challenge/readiness response from the Gateway process namespace. */
  probeBackend(route: GatewayRoute): Promise<boolean>;
  /** Fresh nonce challenge response from a configured persistent probe at EXACT backend.address. */
  probeNode(route: GatewayRoute): Promise<boolean>;
  now?: () => number;
}

function unavailable(): never {
  throw new DomainError('allocation_unavailable');
}
function allocationIdentityEqual(first: string, second: string) {
  // Normalize IPv6 spelling, preserving the provider address family. Collision
  // normalization alone would incorrectly adopt IPv4-mapped IPv6 as an IPv4 claim.
  return (
    isIP(first) !== 0 &&
    isIP(first) === isIP(second) &&
    canonicalAddress(first) === canonicalAddress(second)
  );
}
function effectiveAddress(raw: string, node: GatewayNetworkPolicy['nodes'][number]) {
  if (raw === '127.0.0.1') return node.loopbackRemap?.interfaceAddress ?? unavailable();
  const address = canonicalAddress(raw);
  // Other loopback/scoped/unknown semantics cannot prove a safe Wings binding.
  if (!address || /^127\./.test(address) || address === '::1') unavailable();
  return address;
}
function nodeNetwork(observation: NetworkObservation, node: GatewayNetworkPolicy['nodes'][number]) {
  const matches = observation.networks.filter((network) => network.name === node.networkMode);
  const network = matches[0];
  if (
    matches.length !== 1 ||
    !network ||
    network.driver !== 'bridge' ||
    network.scope !== 'local' ||
    network.internal ||
    ![undefined, 'nat'].includes(network.options['com.docker.network.bridge.gateway_mode_ipv4']) ||
    ![undefined, 'nat'].includes(network.options['com.docker.network.bridge.gateway_mode_ipv6']) ||
    network.options['com.docker.network.bridge.enable_ip_masquerade'] === 'false'
  )
    unavailable();
  if (
    node.loopbackRemap &&
    !observation.interfaceAddresses.includes(node.loopbackRemap.interfaceAddress)
  )
    unavailable();
  return network;
}
function safeContainer(
  route: GatewayRoute,
  context: GatewaySafetyContext,
  observation: NetworkObservation,
  network: ObservedNetwork,
) {
  const matches = observation.containers.filter(
    (container) => container.name === `/${context.providerServerUuid}`,
  );
  const container = matches[0];
  if (
    matches.length !== 1 ||
    !container ||
    container.service !== 'Pterodactyl' ||
    container.containerType !== 'server_process' ||
    ![network.name, network.id].includes(container.networkMode)
  )
    unavailable();
  for (const transport of ['tcp', 'udp'] as const) {
    const expected = { address: route.backend.address, port: route.backend.port, transport };
    const matching = container.configuredBindings.filter((binding) =>
      exactEndpoint(binding, expected),
    );
    // Wings publishes both protocols; a wildcard or remap drift is not the claimed exact bind.
    if (
      matching.length !== 1 ||
      container.configuredBindings.some(
        (binding) => endpointsOverlap(binding, expected) && !exactEndpoint(binding, expected),
      )
    )
      unavailable();
    if (
      container.running &&
      container.activeBindings.filter((binding) => exactEndpoint(binding, expected)).length !== 1
    )
      unavailable();
  }
  return container;
}
function identityDigest(
  route: GatewayRoute,
  context: GatewaySafetyContext,
  observation: NetworkObservation,
  container: ObservedContainer,
  network: ObservedNetwork,
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        serverId: route.serverId,
        nodeId: route.nodeId,
        allocationId: route.allocationId,
        backend: route.backend,
        transport: route.public.transport,
        context,
        namespaceId: observation.namespaceId,
        dockerDaemonId: observation.dockerDaemonId,
        container: {
          id: container.id,
          name: container.name,
          networkMode: container.networkMode,
          bindings: [...container.configuredBindings].sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b)),
          ),
        },
        network: {
          ...network,
          options: Object.fromEntries(
            Object.entries(network.options).sort(([a], [b]) => a.localeCompare(b)),
          ),
        },
      }),
    )
    .digest('hex');
}

/** A denial never changes an allocation, container, socket, listener or provider configuration. */
export function createGatewaySafetyValidator(options: GatewaySafetyOptions): GatewaySafety {
  const policy = gatewayNetworkPolicySchema.parse(options.policy);
  const now = options.now ?? Date.now;
  async function inventories() {
    const result = new Map<number, Awaited<ReturnType<GatewayProviderSource['listAllocations']>>>();
    let next = 0;
    // Bound discovery fan-out even if an Owner policy enumerates many nodes.
    await Promise.all(
      Array.from({ length: Math.min(4, policy.nodes.length) }, async () => {
        while (next < policy.nodes.length) {
          const node = policy.nodes[next++];
          if (!node) return;
          result.set(node.nodeId, await options.provider.listAllocations(node.nodeId));
        }
      }),
    );
    return result;
  }
  async function inspect(
    routeValue: GatewayRoute,
    ownedBindings: readonly GatewayEndpoint[],
    listener: boolean,
  ) {
    const route = gatewayRouteSchema.parse(routeValue);
    if (!exactBindableAddress(route.public.address) || !privateBackend(route.backend.address))
      unavailable();
    const context = gatewaySafetyContextSchema.parse(await options.resolveContext(route));
    const started = now();
    // Independent read-only evidence is collected concurrently. Nothing is
    // cached: every bind/renewal still reads actual sockets and fresh inventory.
    const [observation, nodes, server, nodeInventories] = await Promise.all([
      options.observer.observe(),
      options.provider.listNodes(),
      options.provider.getApplicationServer(context.providerServerId),
      inventories(),
    ]);
    if (
      observation.namespaceId !== observation.hostNamespaceId ||
      observation.observedAt > now() ||
      now() - observation.observedAt > policy.maximumObservationAgeMs
    )
      unavailable();
    if (
      !observation.interfaceAddresses.some(
        (address) => canonicalAddress(address) === route.public.address,
      )
    )
      unavailable();
    if (
      nodes.length !== policy.nodes.length ||
      new Set(nodes.map((node) => node.id)).size !== nodes.length
    )
      unavailable();
    for (const node of nodes) {
      const declared = policy.nodes.find((entry) => entry.nodeId === node.id);
      if (!declared || declared.nodeUuid !== node.uuid) unavailable();
      nodeNetwork(observation, declared);
    }
    const selectedNode =
      policy.nodes.find((node) => node.nodeId === context.providerNodeId) ?? unavailable();
    const selectedNetwork = nodeNetwork(observation, selectedNode);
    if (
      server.id !== context.providerServerId ||
      server.uuid !== context.providerServerUuid ||
      server.external_id !== context.externalId ||
      server.user !== context.providerUserId ||
      server.node !== context.providerNodeId ||
      server.nest !== context.nestId ||
      server.egg !== context.eggId ||
      server.suspended ||
      !server.relationships?.allocations
    )
      unavailable();
    const claims = server.relationships.allocations.data.map((entry) => entry.attributes);
    const ownClaim = claims.filter((allocation) => allocation.id === context.providerAllocationId);
    if (
      ownClaim.length !== 1 ||
      !ownClaim[0]?.assigned ||
      !allocationIdentityEqual(ownClaim[0].ip, route.backend.allocationAddress) ||
      ownClaim[0].port !== route.backend.port
    )
      unavailable();
    if (
      route.backend.allocationAddress === '127.0.0.1' &&
      !selectedNode.loopbackRemap?.verifiedEggs.some(
        (egg) => egg.nestId === context.nestId && egg.eggId === context.eggId,
      )
    )
      unavailable();
    if (effectiveAddress(route.backend.allocationAddress, selectedNode) !== route.backend.address)
      unavailable();
    let ownInventory = false;
    for (const node of policy.nodes) {
      const inventory = nodeInventories.get(node.nodeId) ?? unavailable();
      if (new Set(inventory.map((allocation) => allocation.id)).size !== inventory.length)
        unavailable();
      for (const allocation of inventory) {
        const effective = effectiveAddress(allocation.ip, node);
        // Include free allocations too: Gateway cannot take a configured provider endpoint.
        if (
          allocation.port === route.public.port &&
          addressesOverlap(effective, route.public.address)
        )
          unavailable();
        const selected =
          node.nodeId === context.providerNodeId && allocation.id === context.providerAllocationId;
        if (selected) {
          if (
            !allocation.assigned ||
            !allocationIdentityEqual(allocation.ip, route.backend.allocationAddress) ||
            allocation.port !== route.backend.port
          )
            unavailable();
          ownInventory = true;
        } else if (
          allocation.assigned &&
          allocation.port === route.backend.port &&
          addressesOverlap(effective, route.backend.address)
        )
          unavailable();
      }
    }
    if (!ownInventory) unavailable();
    const container = safeContainer(route, context, observation, selectedNetwork);
    for (const existing of observation.containers) {
      // A direct server in host/shared/routed/unknown networking can disregard its
      // allocation binding address. Stopped containers must not become a hidden
      // future wildcard listener after this public endpoint is admitted.
      if (existing.service === 'Pterodactyl' && existing.containerType === 'server_process') {
        if (existing.unassignedPublications?.length) unavailable();
        const configured = policy.nodes.some((node) => {
          const network = nodeNetwork(observation, node);
          return [network.name, network.id].includes(existing.networkMode);
        });
        if (!configured) unavailable();
      }
      for (const endpoint of [...existing.configuredBindings, ...existing.activeBindings]) {
        if (listener && endpointsOverlap(endpoint, route.public)) unavailable();
        if (
          existing.id !== container.id &&
          endpoint.port === route.backend.port &&
          addressesOverlap(endpoint.address, route.backend.address)
        )
          unavailable();
      }
    }
    if (listener) {
      for (const socket of observation.sockets) {
        if (
          endpointsOverlap(socket, route.public) &&
          !(
            socket.processOwned &&
            exactEndpoint(socket, route.public) &&
            ownedBindings.some((owned) => exactEndpoint(owned, route.public))
          )
        )
          unavailable();
      }
      if (
        ownedBindings.some(
          (owned) => endpointsOverlap(owned, route.public) && !exactEndpoint(owned, route.public),
        )
      )
        unavailable();
    }
    if (
      now() - started > policy.maximumObservationAgeMs ||
      now() - observation.observedAt > policy.maximumObservationAgeMs
    )
      unavailable();
    return {
      route,
      observation,
      container,
      digest: identityDigest(route, context, observation, container, selectedNetwork),
    };
  }
  async function proveBackend(state: Awaited<ReturnType<typeof inspect>>) {
    if (!state.container.running || !(await options.probeBackend(state.route))) unavailable();
    if (now() - state.observation.observedAt > policy.maximumObservationAgeMs) unavailable();
    const proof: GatewayReachabilityProof = {
      version: 1,
      routeId: state.route.id,
      serverId: state.route.serverId,
      allocationId: state.route.allocationId,
      namespaceId: state.observation.namespaceId,
      dockerDaemonId: state.observation.dockerDaemonId,
      digest: state.digest,
      verifiedAt: now(),
    };
    await options.saveProof(state.route, proof);
    if (now() - state.observation.observedAt > policy.maximumObservationAgeMs) unavailable();
  }
  return {
    async validate(route, ownedBindings) {
      const state = await inspect(route, ownedBindings, true);
      if (route.mode === 'online') return proveBackend(state);
      const raw = await options.loadProof(route);
      const proof = gatewayReachabilityProofSchema.safeParse(raw);
      if (
        !proof.success ||
        proof.data.routeId !== route.id ||
        proof.data.serverId !== route.serverId ||
        proof.data.allocationId !== route.allocationId ||
        proof.data.namespaceId !== state.observation.namespaceId ||
        proof.data.dockerDaemonId !== state.observation.dockerDaemonId ||
        proof.data.digest !== state.digest ||
        proof.data.verifiedAt > now() ||
        !(await options.probeNode(route)) ||
        now() - state.observation.observedAt > policy.maximumObservationAgeMs
      )
        unavailable();
    },
    async validateBackend(route) {
      const state = await inspect(route, [], false);
      return proveBackend(state);
    },
  };
}
