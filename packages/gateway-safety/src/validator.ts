import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { DomainError } from '@nickhosting/core';
import {
  type GatewayEndpoint,
  type GatewayProtocolObservation,
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
    version: z.union([z.literal(1), z.literal(2)]),
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
  /** Earliest source-read time of a supplied immutable control evidence batch. */
  observedAt?(): number | undefined;
  listNodes(signal?: AbortSignal): Promise<z.infer<typeof safetyProviderNodeSchema>[]>;
  listAllocations(
    nodeId: number,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof safetyProviderAllocationSchema>[]>;
  getApplicationServer(
    serverId: number,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof safetyProviderServerSchema>>;
  /** Core scopes a bulk read to these authenticated managed routes. */
  getApplicationServers?(
    routeIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<z.infer<typeof safetyProviderServerSchema>[]>;
}
export interface GatewaySafetyOptions {
  provider: GatewayProviderSource;
  observer: NetworkObserver;
  policy: GatewayNetworkPolicy;
  resolveContext(route: GatewayRoute, signal?: AbortSignal): Promise<GatewaySafetyContext>;
  loadProof(route: GatewayRoute, signal?: AbortSignal): Promise<GatewayReachabilityProof | null>;
  saveProof(
    route: GatewayRoute,
    proof: GatewayReachabilityProof,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Actual game-protocol challenge/readiness response from the Gateway process namespace. */
  probeBackend(
    route: GatewayRoute,
    validationId?: string,
    signal?: AbortSignal,
  ): Promise<boolean | GatewayProtocolObservation>;
  /** Fresh nonce challenge response from a configured persistent probe at EXACT backend.address. */
  probeNode(
    route: GatewayRoute,
    context?: GatewaySafetyContext,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Trusted compiled integration declares Core provider-running readiness authority. */
  providerReady?: (route: GatewayRoute) => boolean;
  now?: () => number;
  onTiming?: (event: {
    routeId: string;
    generation: string;
    validationId: string;
    stage: string;
    durationMs: number;
    outcome: 'completed' | 'rejected';
  }) => void;
}

export type GatewaySafetyReason =
  | 'unsafe_topology'
  | 'backend_container_missing'
  | 'backend_container_ambiguous'
  | 'backend_identity'
  | 'backend_configured_binding'
  | 'backend_active_binding'
  | 'provider_identity'
  | 'provider_allocation'
  | 'public_collision'
  | 'backend_collision'
  | 'observation_stale'
  | 'namespace_mismatch'
  | 'backend_protocol'
  | 'node_challenge'
  | 'retained_proof_mismatch';
export class GatewaySafetyError extends DomainError {
  constructor(
    readonly reason: GatewaySafetyReason,
    readonly observationFailure?: 'lease_grant_replaced' | 'lease_evidence_expired',
  ) {
    super('allocation_unavailable');
  }
}
function unavailable(reason: GatewaySafetyReason = 'unsafe_topology'): never {
  throw new GatewaySafetyError(reason);
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
  allowTransient = false,
) {
  const matches = observation.containers.filter(
    (container) => container.name === `/${context.providerServerUuid}`,
  );
  const container = matches[0];
  if (matches.length === 0 && allowTransient) return undefined;
  if (matches.length > 1) unavailable('backend_container_ambiguous');
  if (!container) unavailable('backend_container_missing');
  if (
    container.service !== 'Pterodactyl' ||
    container.containerType !== 'server_process' ||
    ![network.name, network.id].includes(container.networkMode)
  )
    unavailable('backend_identity');
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
      unavailable('backend_configured_binding');
    if (
      container.running &&
      container.activeBindings.filter((binding) => exactEndpoint(binding, expected)).length !== 1
    ) {
      // Docker can report Running before effective publications appear. Only
      // absent bindings are transient; conflicting publications remain unsafe.
      if (
        !allowTransient ||
        container.activeBindings.some(
          (binding) => binding.port === expected.port && binding.transport === transport,
        )
      )
        unavailable('backend_active_binding');
    }
  }
  return container;
}
function identityDigest(
  route: GatewayRoute,
  context: GatewaySafetyContext,
  observation: NetworkObservation,
  container: ObservedContainer,
  network: ObservedNetwork,
  node: GatewayNetworkPolicy['nodes'][number],
  version: 1 | 2,
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        // v1 remains readable only against its original Docker container.
        // v2 binds reachability to the durable, freshly corroborated provider
        // identity. Wings routinely recreates a container for the same server.
        ...(version === 2 ? { version, providerNodeUuid: node.nodeUuid } : {}),
        serverId: route.serverId,
        nodeId: route.nodeId,
        allocationId: route.allocationId,
        backend: route.backend,
        transport: route.public.transport,
        context,
        namespaceId: observation.namespaceId,
        dockerDaemonId: observation.dockerDaemonId,
        container: {
          ...(version === 1 ? { id: container.id } : {}),
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

/** Race a consumer deadline without allowing a late source to continue its pipeline. */
async function cancellable<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    const work = action();
    const value = signal
      ? await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }),
        ])
      : await work;
    signal?.throwIfAborted();
    return value;
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
type SharedRead<T> = {
  work: Promise<T>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
};
async function sharedRead<T>(
  entries: Map<string, SharedRead<T>>,
  key: string,
  action: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  retain = false,
): Promise<T> {
  signal?.throwIfAborted();
  let entry = entries.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = {
      controller,
      consumers: 0,
      settled: false,
      work: Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return action(controller.signal);
      }),
    };
    entries.set(key, entry);
    const current = entry;
    const settle = () => {
      current.settled = true;
      if (!retain && entries.get(key) === current) entries.delete(key);
    };
    void current.work.then(
      () => settle(),
      (error) => {
        current.controller.abort(error);
        settle();
      },
    );
  }
  const current = entry;
  current.consumers++;
  try {
    return await cancellable(() => current.work, signal);
  } finally {
    current.consumers--;
    if (!current.consumers && !current.settled) {
      if (entries.get(key) === current) entries.delete(key);
      current.controller.abort(signal?.reason);
    }
  }
}

/** A denial never changes an allocation, container, socket, listener or provider configuration. */
export function createGatewaySafetyValidator(options: GatewaySafetyOptions): GatewaySafety {
  const policy = gatewayNetworkPolicySchema.parse(options.policy);
  const now = options.now ?? Date.now;
  const backendProbes = new Map<
    string,
    SharedRead<Awaited<ReturnType<GatewaySafetyOptions['probeBackend']>>>
  >();
  const nodeProbes = new Map<string, SharedRead<boolean>>();
  const providerObservedAt = (fallback: number) => {
    const observedAt = options.provider.observedAt?.() ?? fallback;
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0) unavailable('observation_stale');
    return observedAt;
  };
  function probeBackend(
    route: GatewayRoute,
    identity: string,
    validationId?: string,
    signal?: AbortSignal,
  ) {
    return sharedRead(
      backendProbes,
      JSON.stringify([route, identity]),
      (sharedSignal) => options.probeBackend(route, validationId, sharedSignal),
      signal,
    );
  }
  function probeNode(route: GatewayRoute, context: GatewaySafetyContext, signal?: AbortSignal) {
    return sharedRead(
      nodeProbes,
      JSON.stringify([context.providerNodeId, route.backend.address]),
      (sharedSignal) => options.probeNode(route, context, sharedSignal),
      signal,
    );
  }
  async function timed<T>(
    route: GatewayRoute,
    validationId: string,
    stage: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const started = performance.now();
    let outcome: 'completed' | 'rejected' = 'rejected';
    try {
      const value = await cancellable(action, signal);
      outcome = 'completed';
      return value;
    } finally {
      if (route.mode === 'waking') {
        try {
          options.onTiming?.({
            routeId: route.id,
            generation: route.generation,
            validationId,
            stage,
            durationMs: Math.round((performance.now() - started) * 1000) / 1000,
            outcome,
          });
        } catch {
          /* Diagnostics cannot change safety decisions. */
        }
      }
    }
  }

  // A prior successful listener validation retains only its proven backend
  // shape. Every listener use re-reads provider, sockets, topology and durable proof;
  // this is not cached permission or cached inventory. New listeners cannot use it.
  const retainedBindings = new Map<
    string,
    { public: GatewayEndpoint; container: ObservedContainer }
  >();
  async function inventories(signal?: AbortSignal) {
    const result = new Map<number, Awaited<ReturnType<GatewayProviderSource['listAllocations']>>>();
    let next = 0;
    // Bound discovery fan-out even if an Owner policy enumerates many nodes.
    await Promise.all(
      Array.from({ length: Math.min(4, policy.nodes.length) }, async () => {
        while (next < policy.nodes.length) {
          signal?.throwIfAborted();
          const node = policy.nodes[next++];
          if (!node) return;
          result.set(
            node.nodeId,
            await cancellable(() => options.provider.listAllocations(node.nodeId, signal), signal),
          );
        }
      }),
    );
    return result;
  }
  type InventoryEntry = {
    allocation: Awaited<ReturnType<GatewayProviderSource['listAllocations']>>[number];
    effective: string;
  };
  const inventoryIndexes = new WeakMap<
    Awaited<ReturnType<typeof inventories>>,
    { ports: Map<number, InventoryEntry[]>; identities: Map<string, InventoryEntry> }
  >();
  function indexedInventories(source: Awaited<ReturnType<typeof inventories>>) {
    const previous = inventoryIndexes.get(source);
    if (previous) return previous;
    const ports = new Map<number, InventoryEntry[]>();
    const identities = new Map<string, InventoryEntry>();
    for (const node of policy.nodes) {
      const values = source.get(node.nodeId) ?? unavailable();
      for (const allocation of values) {
        const key = `${node.nodeId}:${allocation.id}`;
        if (identities.has(key)) unavailable();
        // Validate every configured allocation, including free reservations and
        // unrelated ports, once for this immutable source batch.
        const entry = { allocation, effective: effectiveAddress(allocation.ip, node) };
        identities.set(key, entry);
        const samePort = ports.get(allocation.port) ?? [];
        samePort.push(entry);
        ports.set(allocation.port, samePort);
      }
    }
    const index = { ports, identities };
    inventoryIndexes.set(source, index);
    return index;
  }
  type ProviderEvidence = {
    started: number;
    nodes: Awaited<ReturnType<GatewayProviderSource['listNodes']>>;
    server: Awaited<ReturnType<GatewayProviderSource['getApplicationServer']>>;
    nodeInventories: Awaited<ReturnType<typeof inventories>>;
  };
  type ProviderBatch = (serverId: number, signal?: AbortSignal) => Promise<ProviderEvidence>;
  function createProviderBatch(routes: readonly GatewayRoute[]): ProviderBatch {
    const inventory = new Map<
      string,
      SharedRead<Pick<ProviderEvidence, 'started' | 'nodes' | 'nodeInventories'>>
    >();
    const bulk = new Map<string, SharedRead<Map<number, ProviderEvidence['server']>>>();
    const servers = new Map<string, SharedRead<ProviderEvidence['server']>>();
    const routeIds = [...new Set(routes.map((route) => route.id))];
    const getServers = options.provider.getApplicationServers?.bind(options.provider);
    return async (serverId, signal) => {
      const inventoryWork = sharedRead(
        inventory,
        'inventory',
        async (sharedSignal) => {
          const started = providerObservedAt(now());
          const [nodes, nodeInventories] = await Promise.all([
            options.provider.listNodes(sharedSignal),
            inventories(sharedSignal),
          ]);
          sharedSignal.throwIfAborted();
          return structuredClone({ started, nodes, nodeInventories });
        },
        signal,
        true,
      );
      const serverWork =
        getServers && routeIds.length
          ? sharedRead(
              bulk,
              'servers',
              async (sharedSignal) => {
                const values = await getServers(routeIds, sharedSignal);
                sharedSignal.throwIfAborted();
                const indexed = new Map(values.map((value) => [value.id, structuredClone(value)]));
                if (indexed.size !== values.length) unavailable('provider_identity');
                return indexed;
              },
              signal,
              true,
            ).then((values) => values.get(serverId) ?? unavailable('provider_identity'))
          : sharedRead(
              servers,
              String(serverId),
              async (sharedSignal) => {
                const value = await options.provider.getApplicationServer(serverId, sharedSignal);
                sharedSignal.throwIfAborted();
                return structuredClone(value);
              },
              signal,
              true,
            );
      const [shared, server] = await Promise.all([inventoryWork, serverWork]);
      signal?.throwIfAborted();
      return { ...shared, server };
    };
  }
  // Successful listener checks may supply backend observations, without extending
  // their age. Listener checks share provider reads only inside an explicit batch.
  type ProviderGrant = {
    key: string;
    evidence: ProviderEvidence;
    leasedProbe?: { routeKey: string; observedAt: number; identity: string; failures: object };
  };
  const validatedProvider = new Map<string, ProviderGrant>();
  const renewals = new Map<
    string,
    { routeKey: string; previous?: ProviderGrant; work: Promise<{ backendReady: boolean }> }
  >();
  const failures = new Map<string, object>();
  function failureToken(routeId: string, revoke = false) {
    let token = failures.get(routeId);
    if (!token || revoke) {
      token = {};
      failures.set(routeId, token);
      if (failures.size > 10000) {
        const oldest = failures.keys().next().value;
        if (oldest) failures.delete(oldest);
      }
    }
    return token;
  }
  const evidenceKey = (route: GatewayRoute, context: GatewaySafetyContext) =>
    JSON.stringify({ route, context });
  function inspect(
    route: GatewayRoute,
    ownedBindings: readonly GatewayEndpoint[],
    listener: boolean,
    batch?: ProviderBatch,
    observe?: NetworkObserver['observe'],
    signal?: AbortSignal,
  ) {
    const validationId = randomUUID();
    return timed(
      route,
      validationId,
      'inspect_total',
      () => inspectDetails(route, ownedBindings, listener, validationId, batch, observe, signal),
      signal,
    );
  }
  async function inspectDetails(
    routeValue: GatewayRoute,
    ownedBindings: readonly GatewayEndpoint[],
    listener: boolean,
    validationId: string,
    batch?: ProviderBatch,
    observe?: NetworkObserver['observe'],
    signal?: AbortSignal,
  ) {
    const route = gatewayRouteSchema.parse(routeValue);
    if (!exactBindableAddress(route.public.address) || !privateBackend(route.backend.address))
      unavailable();
    const context = gatewaySafetyContextSchema.parse(
      await timed(
        route,
        validationId,
        'context',
        () => options.resolveContext(route, signal),
        signal,
      ),
    );
    const started = now();
    const providerStarted = providerObservedAt(started);
    const previous = listener ? undefined : validatedProvider.get(route.id);
    const share =
      previous?.key === evidenceKey(route, context) &&
      previous.evidence.started <= started &&
      started - previous.evidence.started < policy.maximumObservationAgeMs;
    const providerRead = timed(
      route,
      validationId,
      share ? 'provider_reuse' : batch ? 'provider_batch' : 'provider_inventory',
      () =>
        share
          ? Promise.resolve(previous.evidence)
          : batch
            ? batch(context.providerServerId, signal)
            : Promise.all([
                options.provider.listNodes(signal),
                options.provider.getApplicationServer(context.providerServerId, signal),
                inventories(signal),
              ]).then(([nodes, server, nodeInventories]) => ({
                started: providerStarted,
                nodes,
                server,
                nodeInventories,
              })),
      signal,
    );
    // Initial snapshot checks may share timestamped host evidence. Final bind
    // checks and standalone probes read it again; every route enforces its age.
    // Settle both branches before abandoning a failed inspection.
    const results = await Promise.allSettled([
      timed(
        route,
        validationId,
        'host_observation',
        () => (observe ?? options.observer.observe.bind(options.observer))(signal),
        signal,
      ),
      providerRead,
    ]);
    signal?.throwIfAborted();
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const [observed, provider] = results;
    if (observed.status !== 'fulfilled' || provider.status !== 'fulfilled') unavailable();
    const observation = observed.value,
      providerEvidence = provider.value;
    const { nodes, server, nodeInventories } = providerEvidence;
    if (observation.namespaceId !== observation.hostNamespaceId) unavailable('namespace_mismatch');
    if (
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
      unavailable('provider_identity');
    const claims = server.relationships.allocations.data.map((entry) => entry.attributes);
    const ownClaim = claims.filter((allocation) => allocation.id === context.providerAllocationId);
    if (
      ownClaim.length !== 1 ||
      !ownClaim[0]?.assigned ||
      !allocationIdentityEqual(ownClaim[0].ip, route.backend.allocationAddress) ||
      ownClaim[0].port !== route.backend.port
    )
      unavailable('provider_allocation');
    if (
      route.backend.allocationAddress === '127.0.0.1' &&
      !selectedNode.loopbackRemap?.verifiedEggs.some(
        (egg) => egg.nestId === context.nestId && egg.eggId === context.eggId,
      )
    )
      unavailable();
    if (effectiveAddress(route.backend.allocationAddress, selectedNode) !== route.backend.address)
      unavailable();
    const inventory = indexedInventories(nodeInventories);
    for (const entry of inventory.ports.get(route.public.port) ?? [])
      if (addressesOverlap(entry.effective, route.public.address)) unavailable('public_collision');
    const ownInventory = inventory.identities.get(
      `${context.providerNodeId}:${context.providerAllocationId}`,
    );
    if (!ownInventory) unavailable('provider_allocation');
    if (
      !ownInventory.allocation.assigned ||
      !allocationIdentityEqual(ownInventory.allocation.ip, route.backend.allocationAddress) ||
      ownInventory.allocation.port !== route.backend.port
    )
      unavailable();
    for (const entry of inventory.ports.get(route.backend.port) ?? [])
      if (
        entry !== ownInventory &&
        entry.allocation.assigned &&
        addressesOverlap(entry.effective, route.backend.address)
      )
        unavailable();
    const retained = retainedBindings.get(route.id);
    // A wake operation rotates generation while retaining the same public listener.
    // Generation scopes control-plane authority, not backend identity: the caller
    // enforces its current lease, and the fresh v2 proof below still binds the exact
    // server, allocation, provider context and network. Never promote this retained
    // shape into forwarding or a new listener.
    const mayRetainStatus =
      listener &&
      (route.mode === 'waking' || route.mode === 'sleeping') &&
      retained !== undefined &&
      exactEndpoint(retained.public, route.public) &&
      ownedBindings.some((binding) => exactEndpoint(binding, route.public));
    const container = safeContainer(route, context, observation, selectedNetwork, mayRetainStatus);
    const proofContainer = container ?? (mayRetainStatus ? retained?.container : undefined);
    if (!proofContainer) unavailable('backend_container_missing');
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
        if (listener && endpointsOverlap(endpoint, route.public)) unavailable('public_collision');
        if (
          existing.id !== container?.id &&
          endpoint.port === route.backend.port &&
          addressesOverlap(endpoint.address, route.backend.address)
        )
          unavailable('backend_collision');
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
          unavailable('public_collision');
      }
      if (
        ownedBindings.some(
          (owned) => endpointsOverlap(owned, route.public) && !exactEndpoint(owned, route.public),
        )
      )
        unavailable();
    }
    if (
      providerEvidence.started > now() ||
      now() - providerEvidence.started > policy.maximumObservationAgeMs ||
      now() - started > policy.maximumObservationAgeMs ||
      now() - observation.observedAt > policy.maximumObservationAgeMs
    )
      unavailable('observation_stale');
    return {
      validationId,
      signal,
      route,
      context,
      observation,
      providerEvidence,
      container,
      mayRetainStatus,
      backendBindingsComplete:
        !!container &&
        ['tcp', 'udp'].every(
          (transport) =>
            container.activeBindings.filter((binding) =>
              exactEndpoint(binding, {
                address: route.backend.address,
                port: route.backend.port,
                transport: transport as 'tcp' | 'udp',
              }),
            ).length === 1,
        ),
      digest: identityDigest(
        route,
        context,
        observation,
        proofContainer,
        selectedNetwork,
        selectedNode,
        2,
      ),
      legacyDigest: identityDigest(
        route,
        context,
        observation,
        proofContainer,
        selectedNetwork,
        selectedNode,
        1,
      ),
    };
  }
  async function proveBackend(state: Awaited<ReturnType<typeof inspect>>) {
    state.signal?.throwIfAborted();
    if (!state.container?.running || !state.backendBindingsComplete)
      unavailable('backend_active_binding');
    const result = await timed(
      state.route,
      state.validationId,
      'backend_protocol',
      () =>
        probeBackend(
          state.route,
          JSON.stringify([state.digest, state.container?.id]),
          state.validationId,
          state.signal,
        ),
      state.signal,
    );
    if (!(typeof result === 'boolean' ? result : result.ready === true))
      unavailable('backend_protocol');
    if (
      now() - state.observation.observedAt > policy.maximumObservationAgeMs ||
      now() - state.providerEvidence.started > policy.maximumObservationAgeMs
    )
      unavailable('observation_stale');
    const proof: GatewayReachabilityProof = {
      version: 2,
      routeId: state.route.id,
      serverId: state.route.serverId,
      allocationId: state.route.allocationId,
      namespaceId: state.observation.namespaceId,
      dockerDaemonId: state.observation.dockerDaemonId,
      digest: state.digest,
      verifiedAt: now(),
    };
    await timed(
      state.route,
      state.validationId,
      'proof_write',
      () => options.saveProof(state.route, proof, state.signal),
      state.signal,
    );
    if (
      now() - state.observation.observedAt > policy.maximumObservationAgeMs ||
      now() - state.providerEvidence.started > policy.maximumObservationAgeMs
    )
      unavailable('observation_stale');
    // Return only the exact sample whose fresh binding/protocol proof was saved.
    // Boolean-only adapters retain the legacy data-plane fallback.
    return typeof result === 'boolean' ? undefined : result;
  }
  async function validateBackend(route: GatewayRoute, signal?: AbortSignal) {
    try {
      const state = await inspect(route, [], false, undefined, undefined, signal);
      return await proveBackend(state);
    } catch (error) {
      // A later failed full inspection must not leave a fast-path grant behind.
      validatedProvider.delete(route.id);
      failureToken(route.id, true);
      throw error;
    }
  }
  async function validateListener(
    route: GatewayRoute,
    ownedBindings: readonly GatewayEndpoint[],
    batch?: ProviderBatch,
    observe?: NetworkObserver['observe'],
    token = failureToken(route.id),
    signal?: AbortSignal,
  ) {
    const state = await inspect(route, ownedBindings, true, batch, observe, signal);
    const accepted = (backendReady: boolean) => {
      signal?.throwIfAborted();
      // A newer attempt that could not acquire this route's active inspection
      // revoked it. Its older completion must not restore backend authority.
      if (failureToken(route.id) !== token) unavailable('observation_stale');
      // Proof reads, node challenges and protocol responses may outlive the
      // provider inventory, especially when it was shared earlier in this batch.
      if (
        state.providerEvidence.started > now() ||
        state.observation.observedAt > now() ||
        now() - state.providerEvidence.started > policy.maximumObservationAgeMs ||
        now() - state.observation.observedAt > policy.maximumObservationAgeMs
      )
        unavailable('observation_stale');
      validatedProvider.set(route.id, {
        key: evidenceKey(state.route, state.context),
        evidence: structuredClone(state.providerEvidence),
        ...(state.container?.running && state.backendBindingsComplete
          ? {
              leasedProbe: {
                routeKey: JSON.stringify(state.route),
                observedAt: state.observation.observedAt,
                identity: JSON.stringify([state.digest, state.container.id]),
                failures: failureToken(route.id),
              },
            }
          : {}),
      });
      if (validatedProvider.size > 10000) {
        const oldest = validatedProvider.keys().next().value;
        if (oldest) validatedProvider.delete(oldest);
      }
      return { backendReady };
    };
    const raw = await cancellable(() => options.loadProof(route, signal), signal);
    const proof = gatewayReachabilityProofSchema.safeParse(raw);
    const matches =
      proof.success &&
      proof.data.routeId === route.id &&
      proof.data.serverId === route.serverId &&
      proof.data.allocationId === route.allocationId &&
      proof.data.namespaceId === state.observation.namespaceId &&
      proof.data.dockerDaemonId === state.observation.dockerDaemonId &&
      proof.data.digest === (proof.data.version === 1 ? state.legacyDigest : state.digest) &&
      proof.data.verifiedAt <= now();
    if (!state.container || (state.container.running && !state.backendBindingsComplete)) {
      if (!state.mayRetainStatus || !matches || !proof.success || proof.data.version !== 2)
        unavailable('retained_proof_mismatch');
      if (!(await probeNode(route, state.context, signal))) unavailable('node_challenge');
      if (now() - state.observation.observedAt > policy.maximumObservationAgeMs)
        unavailable('observation_stale');
      return accepted(false);
    }
    const retainBinding = () => {
      if (!state.container) return;
      retainedBindings.set(route.id, {
        public: { ...route.public },
        container: structuredClone(state.container),
      });
      // Bound memory even if withdrawn routes never return to this validator.
      if (retainedBindings.size > 10000) {
        const oldest = retainedBindings.keys().next().value;
        if (oldest) retainedBindings.delete(oldest);
      }
    };
    // Bootstrap from an actually ready owned backend using this inspection.
    // Stopped containers and protocol failures cannot replace a missing/stale
    // proof. This is the same gate used by readiness, not metadata promotion.
    if (!matches) {
      await proveBackend(state);
      if (route.mode === 'online') {
        retainBinding();
        return accepted(true);
      }
    } else if (
      route.mode === 'online' &&
      state.container.running &&
      state.backendBindingsComplete
    ) {
      if (options.providerReady?.(route)) {
        if (now() - state.observation.observedAt > policy.maximumObservationAgeMs)
          unavailable('observation_stale');
        retainBinding();
        return accepted(true);
      }
      // A failed game probe revokes forwarding, not an independently proven
      // public binding. Ownership/collision/topology failures above still throw.
      const result = await probeBackend(
        route,
        JSON.stringify([state.digest, state.container.id]),
        undefined,
        signal,
      ).catch(() => false);
      signal?.throwIfAborted();
      const backendReady = typeof result === 'boolean' ? result : result.ready === true;
      if (now() - state.observation.observedAt > policy.maximumObservationAgeMs)
        unavailable('observation_stale');
      if (backendReady) {
        retainBinding();
        return accepted(true);
      }
    }
    if (!(await probeNode(route, state.context, signal))) unavailable('node_challenge');
    if (now() - state.observation.observedAt > policy.maximumObservationAgeMs)
      unavailable('observation_stale');
    retainBinding();
    return accepted(false);
  }
  function validate(
    route: GatewayRoute,
    ownedBindings: readonly GatewayEndpoint[],
    batch?: ProviderBatch,
    observe?: NetworkObserver['observe'],
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    // Keep one active inspection per route, without queuing abandoned timeout
    // work. A concurrent attempt revokes the older result and retries only after
    // it settles; it cannot restore stale authority or add more provider work.
    const preceding = renewals.get(route.id);
    const previous = validatedProvider.get(route.id) ?? preceding?.previous;
    validatedProvider.delete(route.id);
    if (preceding) {
      failureToken(route.id, true);
      return Promise.reject(new GatewaySafetyError('observation_stale'));
    }
    const token = failureToken(route.id);
    let work!: Promise<{ backendReady: boolean }>;
    work = (async () => {
      try {
        return await validateListener(route, ownedBindings, batch, observe, token, signal);
      } catch (error) {
        validatedProvider.delete(route.id);
        failureToken(route.id, true);
        throw error;
      } finally {
        if (renewals.get(route.id)?.work === work) renewals.delete(route.id);
      }
    })();
    renewals.set(route.id, { routeKey: JSON.stringify(route), previous, work });
    return work;
  }
  const freshGrant = (grant: ProviderGrant | undefined) => {
    const time = now();
    return (
      grant?.leasedProbe !== undefined &&
      grant.leasedProbe.observedAt <= time &&
      grant.evidence.started <= time &&
      time - grant.leasedProbe.observedAt < policy.maximumObservationAgeMs &&
      time - grant.evidence.started < policy.maximumObservationAgeMs
    );
  };
  function equivalentGrant(routeId: string, previous: ProviderGrant, current?: ProviderGrant) {
    return (
      freshGrant(current) &&
      current?.key === previous.key &&
      current?.leasedProbe?.identity === previous.leasedProbe?.identity &&
      current?.leasedProbe?.failures === previous.leasedProbe?.failures &&
      failures.get(routeId) === previous.leasedProbe?.failures
    );
  }
  async function waitForRenewals(routeId: string, previous: ProviderGrant, signal?: AbortSignal) {
    while (renewals.has(routeId) && freshGrant(previous)) {
      signal?.throwIfAborted();
      const renewal = renewals.get(routeId);
      const remaining =
        Math.min(previous.leasedProbe?.observedAt ?? 0, previous.evidence.started) +
        policy.maximumObservationAgeMs -
        now();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const completed = await cancellable(
        () =>
          Promise.race([
            renewal?.work.then(
              () => true,
              () => false,
            ),
            new Promise<false>((resolve) => {
              timeout = setTimeout(() => resolve(false), Math.max(0, remaining));
            }),
          ]),
        signal,
      ).finally(() => clearTimeout(timeout));
      if (!completed) break;
    }
  }
  return {
    validate: (route, ownedBindings, signal) =>
      validate(route, ownedBindings, undefined, undefined, signal),
    createValidationBatch(routes = [], phase = 'initial') {
      const batch = createProviderBatch(routes);
      const host = new Map<string, SharedRead<NetworkObservation>>();
      const checked = new Set<string>();
      return {
        validate(route, ownedBindings, signal) {
          const first = !checked.has(route.id);
          checked.add(route.id);
          const observe =
            phase === 'prebind' || first
              ? async (consumerSignal?: AbortSignal) =>
                  structuredClone(
                    await sharedRead(
                      host,
                      'host',
                      (sharedSignal) =>
                        options.observer
                          .observe(sharedSignal)
                          .then((value) => structuredClone(value)),
                      consumerSignal,
                      phase === 'initial',
                    ),
                  )
              : undefined;
          return validate(route, ownedBindings, batch, observe, signal);
        },
      };
    },
    validateBackend,
    async probeLeasedBackend(routeValue, signal) {
      signal?.throwIfAborted();
      const route = gatewayRouteSchema.parse(routeValue);
      let previous = validatedProvider.get(route.id);
      const active = renewals.get(route.id);
      if (
        !previous &&
        ['waking', 'online'].includes(route.mode) &&
        active?.routeKey === JSON.stringify(route) &&
        active.previous?.leasedProbe?.routeKey === active.routeKey &&
        freshGrant(active.previous) &&
        failures.get(route.id) === active.previous.leasedProbe.failures
      ) {
        // A renewal revokes permission while it inspects. Join that full check
        // instead of starting a duplicate, but retain the original grant's deadline.
        previous = active.previous;
        await waitForRenewals(route.id, previous, signal);
        if (
          !freshGrant(previous) ||
          renewals.has(route.id) ||
          !equivalentGrant(route.id, previous, validatedProvider.get(route.id))
        )
          throw new GatewaySafetyError('observation_stale', 'lease_grant_replaced');
      }
      const fresh = () => freshGrant(previous);
      // The caller owns the live listener lease. This only samples an unchanged
      // backend within the ORIGINAL full validation budget; it cannot bind,
      // renew, change identity or produce a reusable reachability proof.
      if (
        !['waking', 'online'].includes(route.mode) ||
        previous?.leasedProbe?.routeKey !== JSON.stringify(route) ||
        !equivalentGrant(route.id, previous, validatedProvider.get(route.id)) ||
        !fresh()
      )
        return validateBackend(route, signal);
      const validationId = randomUUID();
      const identity = previous.leasedProbe?.identity ?? unavailable('observation_stale');
      const result = await timed(
        route,
        validationId,
        'leased_backend_protocol',
        () => probeBackend(route, identity, validationId, signal),
        signal,
      );
      if (!(typeof result === 'boolean' ? result : result.ready === true))
        unavailable('backend_protocol');
      // A fresh identical renewal may finish during the game response. Await it
      // rather than throwing away that response, within the ORIGINAL age budget.
      await timed(
        route,
        validationId,
        'renewal_wait',
        () => waitForRenewals(route.id, previous, signal),
        signal,
      );
      const current = validatedProvider.get(route.id);
      const equivalent = equivalentGrant(route.id, previous, current);
      if (!fresh() || renewals.has(route.id) || !equivalent)
        throw new GatewaySafetyError(
          'observation_stale',
          validatedProvider.get(route.id) !== previous
            ? 'lease_grant_replaced'
            : 'lease_evidence_expired',
        );
      return typeof result === 'boolean' ? undefined : result;
    },
  };
}
