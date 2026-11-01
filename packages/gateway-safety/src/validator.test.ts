import type { GatewayRoute } from '@nickhosting/game-sdk';
import type {
  Allocation,
  ApplicationServer,
  NetworkObservation,
  Node,
} from '@nickhosting/pterodactyl-adapter';
import { describe, expect, it, vi } from 'vitest';
import { addressesOverlap, endpointsOverlap } from './addresses.js';
import {
  createGatewaySafetyValidator,
  type GatewayReachabilityProof,
  GatewaySafetyError,
  type GatewaySafetyOptions,
} from './validator.js';

const ids = {
  route: '11111111-1111-4111-8111-111111111111',
  server: '22222222-2222-4222-8222-222222222222',
  node: '33333333-3333-4333-8333-333333333333',
  allocation: '44444444-4444-4444-8444-444444444444',
  provider: '55555555-5555-4555-8555-555555555555',
  generation: '66666666-6666-4666-8666-666666666666',
};
function fixture() {
  const now = 1_800_000_000_000;
  const route: GatewayRoute = {
    id: ids.route,
    serverId: ids.server,
    nodeId: ids.node,
    allocationId: ids.allocation,
    revision: 1,
    generation: ids.generation,
    public: { address: '192.0.2.10', port: 25565, transport: 'tcp' },
    backend: { allocationAddress: '127.0.0.1', address: '10.5.0.1', port: 25565 },
    mode: 'online',
    locale: 'en',
  };
  const allocation: Allocation = { id: 7, ip: '127.0.0.1', port: 25565, assigned: true };
  const node = { id: 1, uuid: 'provider-node-1' } as Node;
  const server = {
    id: 42,
    uuid: ids.provider,
    external_id: 'nh-owned-server',
    user: 2,
    node: 1,
    nest: 3,
    egg: 4,
    suspended: false,
    relationships: { allocations: { object: 'list', data: [{ attributes: allocation }] } },
  } as ApplicationServer;
  const bindings = (['tcp', 'udp'] as const).map((transport) => ({
    address: '10.5.0.1',
    port: 25565,
    transport,
  }));
  const observation: NetworkObservation = {
    observedAt: now,
    namespaceId: 'net:[100]',
    hostNamespaceId: 'net:[100]',
    dockerDaemonId: 'test-daemon',
    interfaceAddresses: ['192.0.2.10', '10.5.0.1'],
    sockets: [],
    containers: [
      {
        id: 'a'.repeat(64),
        name: `/${ids.provider}`,
        service: 'Pterodactyl',
        containerType: 'server_process',
        running: true,
        networkMode: 'fixture-bridge',
        configuredBindings: structuredClone(bindings),
        activeBindings: structuredClone(bindings),
      },
    ],
    networks: [
      {
        id: 'b'.repeat(64),
        name: 'fixture-bridge',
        driver: 'bridge',
        scope: 'local',
        internal: false,
        ipv6: false,
        options: {},
      },
    ],
  };
  let proof: GatewayReachabilityProof | null = null;
  const options: GatewaySafetyOptions = {
    provider: {
      listNodes: vi.fn(async () => [node]),
      listAllocations: vi.fn(async () => [allocation]),
      getApplicationServer: vi.fn(async () => server),
    },
    observer: { observe: vi.fn(async () => observation) },
    policy: {
      maximumObservationAgeMs: 5000,
      nodes: [
        {
          nodeId: 1,
          nodeUuid: 'provider-node-1',
          networkMode: 'fixture-bridge',
          loopbackRemap: {
            wingsVersion: '1.11.13',
            interfaceAddress: '10.5.0.1',
            ispn: false,
            verifiedEggs: [{ nestId: 3, eggId: 4, forceOutgoingIp: false }],
          },
        },
      ],
    },
    resolveContext: vi.fn(async () => ({
      providerServerId: 42,
      providerServerUuid: ids.provider,
      externalId: 'nh-owned-server',
      providerUserId: 2,
      providerNodeId: 1,
      providerAllocationId: 7,
      nestId: 3,
      eggId: 4,
    })),
    loadProof: vi.fn(async () => proof),
    saveProof: vi.fn(async (_route, value) => {
      proof = value;
    }),
    probeBackend: vi.fn(async () => true),
    probeNode: vi.fn(async () => true),
    now: () => now,
  };
  return {
    route,
    allocation,
    node,
    server,
    observation,
    options,
    validator: () => createGatewaySafetyValidator(options),
    proof: () => proof,
  };
}

describe('Gateway address collision semantics', () => {
  it.each([
    ['::ffff:192.0.2.1', '192.0.2.1', true],
    ['::ffff:c000:201', '192.0.2.1', true],
    ['::', '192.0.2.1', true],
    ['::', 'fd00::1', true],
    ['0.0.0.0', '192.0.2.1', true],
    ['0.0.0.0', 'fd00::1', false],
    ['192.0.2.1', '10.0.0.1', false],
    ['fd00::1', 'fd00::2', false],
    ['FD00:0:0:0:0:0:0:1', 'fd00::1', true],
    ['unknown', '192.0.2.1', true],
  ])('overlap %s / %s is %s', (a, b, result) => expect(addressesOverlap(a, b)).toBe(result));
  it('permits equal numerical ports on different exact IPs, and separates TCP/UDP socket ownership', () => {
    const endpoint = { address: '192.0.2.1', port: 25565, transport: 'tcp' as const };
    expect(endpointsOverlap(endpoint, { ...endpoint, address: '10.0.0.1' })).toBe(false);
    expect(endpointsOverlap(endpoint, { ...endpoint, transport: 'udp' })).toBe(false);
  });
});

describe('Gateway snapshot provider batches', () => {
  it.each([false, true])('shares four server routes with bulk support=%s', async (bulk) => {
    const f = fixture();
    const context = await f.options.resolveContext(f.route);
    const container = f.observation.containers[0];
    if (!container) throw new Error('Missing fixture container');
    const entries = [ids.route, ids.server, ids.node, ids.allocation].map((id, index) => {
      const port = f.route.backend.port + index;
      const allocation = { ...f.allocation, id: 7 + index, port };
      const server = {
        ...f.server,
        id: 42 + index,
        uuid: id,
        relationships: {
          allocations: { object: 'list' as const, data: [{ attributes: allocation }] },
        },
      };
      return {
        allocation,
        server,
        route: {
          ...f.route,
          id,
          public: { ...f.route.public, port },
          backend: { ...f.route.backend, port },
        },
        container: {
          ...container,
          id: String(index + 1).repeat(64),
          name: `/${id}`,
          configuredBindings: container.configuredBindings.map((binding) => ({ ...binding, port })),
          activeBindings: container.activeBindings.map((binding) => ({ ...binding, port })),
        },
      };
    });
    f.observation.containers = entries.map((entry) => entry.container);
    f.options.provider.listAllocations = vi.fn(async () =>
      entries.map((entry) => entry.allocation),
    );
    f.options.provider.getApplicationServer = vi.fn(async (id) => {
      const entry = entries.find((entry) => entry.server.id === id);
      if (!entry) throw new Error('Missing fixture server');
      return entry.server;
    });
    f.options.resolveContext = vi.fn(async (route) => {
      const entry = entries.find((entry) => entry.route.id === route.id);
      if (!entry) throw new Error('Missing fixture context');
      return {
        ...context,
        providerServerId: entry.server.id,
        providerServerUuid: entry.server.uuid,
        providerAllocationId: entry.allocation.id,
      };
    });
    if (bulk)
      f.options.provider.getApplicationServers = vi.fn(async () =>
        entries.map((entry) => entry.server),
      );
    const batch = f.validator().createValidationBatch?.(entries.map((entry) => entry.route));
    if (!batch) throw new Error('Missing validation batch');
    await Promise.all(entries.map(({ route }) => batch.validate(route, [])));
    expect(f.options.provider.listNodes).toHaveBeenCalledOnce();
    expect(f.options.provider.listAllocations).toHaveBeenCalledOnce();
    expect(f.options.provider.getApplicationServer).toHaveBeenCalledTimes(bulk ? 0 : 4);
    if (bulk) {
      expect(f.options.provider.getApplicationServers).toHaveBeenCalledOnce();
      expect(f.options.provider.getApplicationServers).toHaveBeenCalledWith(
        entries.map((entry) => entry.route.id),
      );
    }
  });

  it.each(['missing', 'duplicate', 'failed', 'identity'] as const)(
    'rejects %s bulk evidence without retrying single-server reads',
    async (kind) => {
      const f = fixture();
      f.options.provider.getApplicationServers = vi.fn(async () => {
        if (kind === 'failed') throw new Error('Bulk failed');
        if (kind === 'missing') return [];
        if (kind === 'duplicate') return [f.server, f.server];
        return [{ ...f.server, external_id: 'foreign' }];
      });
      const safety = f.validator();
      const batch = safety.createValidationBatch?.([f.route]);
      if (!batch) throw new Error('Missing validation batch');
      await expect(batch.validate(f.route, [])).rejects.toThrow();
      await expect(batch.validate(f.route, [])).rejects.toThrow();
      expect(f.options.provider.getApplicationServers).toHaveBeenCalledOnce();
      expect(f.options.provider.getApplicationServer).not.toHaveBeenCalled();
      expect(f.options.saveProof).not.toHaveBeenCalled();
      f.options.provider.getApplicationServers = vi.fn(async () => [f.server]);
      await expect(
        safety.createValidationBatch?.([f.route]).validate(f.route, []),
      ).resolves.toEqual({ backendReady: true });
    },
  );

  it('keeps bulk evidence inside its source age and snapshot boundary', async () => {
    const f = fixture();
    let clock = f.observation.observedAt;
    f.options.now = () => clock;
    f.options.provider.getApplicationServers = vi.fn(async () => [f.server]);
    const safety = f.validator();
    const batch = safety.createValidationBatch?.([f.route]);
    if (!batch) throw new Error('Missing validation batch');
    await batch.validate(f.route, []);
    await batch.validate(f.route, []);
    clock += 5001;
    f.observation.observedAt = clock;
    await expect(batch.validate(f.route, [])).rejects.toMatchObject({
      reason: 'observation_stale',
    });
    expect(f.options.provider.getApplicationServers).toHaveBeenCalledOnce();
    await safety.createValidationBatch?.([f.route]).validate(f.route, []);
    expect(f.options.provider.getApplicationServers).toHaveBeenCalledTimes(2);
    await safety.validate(f.route, []);
    expect(f.options.provider.getApplicationServer).toHaveBeenCalledOnce();
  });

  it('shares all-node inventory and each server across routes and final bind checks only in one batch', async () => {
    const f = fixture();
    const secondAllocation = { ...f.allocation, id: 8, port: 25566 };
    const secondServer = {
      ...f.server,
      id: 43,
      uuid: ids.generation,
      external_id: 'nh-second-server',
      relationships: {
        allocations: { object: 'list' as const, data: [{ attributes: secondAllocation }] },
      },
    };
    const routes: GatewayRoute[] = [
      f.route,
      { ...f.route, id: ids.node, public: { ...f.route.public, transport: 'udp' } },
      {
        ...f.route,
        id: ids.allocation,
        serverId: ids.provider,
        allocationId: ids.node,
        public: { ...f.route.public, port: secondAllocation.port },
        backend: { ...f.route.backend, port: secondAllocation.port },
      },
    ];
    const container = f.observation.containers[0];
    const node = f.options.policy.nodes[0];
    if (!container || !node) throw new Error('Missing fixture topology');
    f.observation.containers.push({
      ...container,
      id: 'c'.repeat(64),
      name: `/${secondServer.uuid}`,
      configuredBindings: container.configuredBindings.map((binding) => ({
        ...binding,
        port: secondAllocation.port,
      })),
      activeBindings: container.activeBindings.map((binding) => ({
        ...binding,
        port: secondAllocation.port,
      })),
    });
    f.options.policy.nodes.push({ ...node, nodeId: 2, nodeUuid: 'provider-node-2' });
    f.options.provider.listNodes = vi.fn(async () => [f.node, { id: 2, uuid: 'provider-node-2' }]);
    f.options.provider.listAllocations = vi.fn(async (nodeId) =>
      nodeId === 1 ? [f.allocation, secondAllocation] : [],
    );
    f.options.provider.getApplicationServer = vi.fn(async (serverId) =>
      serverId === 42 ? f.server : secondServer,
    );
    const context = await f.options.resolveContext(f.route);
    f.options.resolveContext = vi.fn(async (route) =>
      route.serverId === f.route.serverId
        ? context
        : {
            ...context,
            providerServerId: secondServer.id,
            providerServerUuid: secondServer.uuid,
            externalId: secondServer.external_id,
            providerAllocationId: secondAllocation.id,
          },
    );
    const proofs = new Map<string, GatewayReachabilityProof>();
    f.options.loadProof = vi.fn(async (route) => proofs.get(route.id) ?? null);
    f.options.saveProof = vi.fn(async (route, proof) => {
      proofs.set(route.id, proof);
    });
    const safety = f.validator();
    const batch = safety.createValidationBatch?.();
    if (!batch) throw new Error('Missing validation batch');
    expect(f.options.provider.listNodes).not.toHaveBeenCalled();
    for (let gate = 0; gate < 2; gate++)
      await Promise.all(routes.map((route) => batch.validate(route, [])));
    expect(f.options.provider.listNodes).toHaveBeenCalledOnce();
    expect(f.options.provider.listAllocations).toHaveBeenCalledTimes(2);
    expect(f.options.provider.getApplicationServer).toHaveBeenCalledTimes(2);
    expect(f.options.provider.getApplicationServer).toHaveBeenCalledWith(42);
    expect(f.options.provider.getApplicationServer).toHaveBeenCalledWith(43);
    expect(f.options.resolveContext).toHaveBeenCalledTimes(6);
    expect(f.options.observer.observe).toHaveBeenCalledTimes(6);
    expect(f.options.loadProof).toHaveBeenCalledTimes(6);
    const next = safety.createValidationBatch?.();
    if (!next) throw new Error('Missing next validation batch');
    await Promise.all(routes.map((route) => next.validate(route, [])));
    expect(f.options.provider.listNodes).toHaveBeenCalledTimes(2);
    expect(f.options.provider.listAllocations).toHaveBeenCalledTimes(4);
    expect(f.options.provider.getApplicationServer).toHaveBeenCalledTimes(4);
  });

  it.each(['listNodes', 'listAllocations', 'getApplicationServer'] as const)(
    'retains a failed %s read in its batch and recovers only with fresh sources',
    async (source) => {
      const f = fixture();
      vi.mocked(f.options.provider[source]).mockRejectedValueOnce(new Error('Provider failed'));
      const safety = f.validator();
      const batch = safety.createValidationBatch?.();
      if (!batch) throw new Error('Missing validation batch');
      await expect(batch.validate(f.route, [])).rejects.toThrow('Provider failed');
      await expect(batch.validate(f.route, [])).rejects.toThrow('Provider failed');
      expect(f.options.provider[source]).toHaveBeenCalledOnce();
      expect(f.options.probeBackend).not.toHaveBeenCalled();
      expect(f.options.saveProof).not.toHaveBeenCalled();
      const next = safety.createValidationBatch?.();
      if (!next) throw new Error('Missing next validation batch');
      await expect(next.validate(f.route, [])).resolves.toEqual({ backendReady: true });
      expect(f.options.provider[source]).toHaveBeenCalledTimes(2);
    },
  );

  it('isolates concurrently active batches, including source failures', async () => {
    const f = fixture();
    let rejectFirst!: (error: Error) => void;
    f.options.provider.listNodes = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValue([f.node]);
    const safety = f.validator();
    const first = safety.createValidationBatch?.();
    const second = safety.createValidationBatch?.();
    if (!first || !second) throw new Error('Missing validation batches');
    const failed = first.validate(f.route, []).catch((error) => error);
    await vi.waitFor(() => expect(rejectFirst).toBeTypeOf('function'));
    const otherRoute = { ...f.route, id: ids.node };
    await expect(second.validate(otherRoute, [])).resolves.toEqual({ backendReady: true });
    rejectFirst(new Error('First batch failed'));
    expect(await failed).toMatchObject({ message: 'First batch failed' });
    expect(f.options.provider.listNodes).toHaveBeenCalledTimes(2);
    expect(f.options.provider.listAllocations).toHaveBeenCalledTimes(2);
    expect(f.options.provider.getApplicationServer).toHaveBeenCalledTimes(2);
  });

  it.each(['before-inspection', 'proof-read', 'node-challenge'] as const)(
    'rejects provider evidence expiring at %s without renewing its timestamp',
    async (phase) => {
      const f = fixture();
      let clock = f.observation.observedAt;
      f.options.now = () => clock;
      f.options.providerReady = () => true;
      const safety = f.validator();
      const batch = safety.createValidationBatch?.();
      if (!batch) throw new Error('Missing validation batch');
      await batch.validate(f.route, []);
      clock += phase === 'before-inspection' ? 5001 : 4999;
      f.observation.observedAt = clock;
      if (phase === 'proof-read') {
        f.options.loadProof = async () => {
          clock += 2;
          return f.proof();
        };
      }
      if (phase === 'node-challenge') {
        f.route.mode = 'sleeping';
        f.options.probeNode = async () => {
          clock += 2;
          return true;
        };
      }
      await expect(batch.validate(f.route, [f.route.public])).rejects.toMatchObject({
        reason: 'observation_stale',
      });
      expect(f.options.provider.listNodes).toHaveBeenCalledOnce();
      expect(f.options.provider.getApplicationServer).toHaveBeenCalledOnce();
    },
  );

  it.each(['provider', 'socket', 'context', 'proof'] as const)(
    'does not let shared provider reads bypass %s safety at the final bind gate',
    async (change) => {
      const f = fixture();
      const safety = f.validator();
      const batch = safety.createValidationBatch?.();
      if (!batch) throw new Error('Missing validation batch');
      if (change === 'provider')
        f.options.provider.listAllocations = vi.fn(async () => [
          f.allocation,
          { id: 8, ip: f.route.public.address, port: f.route.public.port + 1, assigned: false },
        ]);
      await batch.validate(f.route, []);
      if (change === 'provider') f.route.public.port++;
      if (change === 'socket')
        f.observation.sockets.push({ ...f.route.public, processOwned: false, inode: 'foreign' });
      if (change === 'context') {
        const context = await f.options.resolveContext(f.route);
        f.options.resolveContext = async () => ({ ...context, externalId: 'foreign-owner' });
      }
      if (change === 'proof') {
        f.options.loadProof = async () => null;
        f.options.probeBackend = async () => false;
      }
      await expect(batch.validate(f.route, [f.route.public])).rejects.toThrow();
      expect(f.options.provider.listNodes).toHaveBeenCalledOnce();
      expect(f.options.observer.observe).toHaveBeenCalledTimes(2);
    },
  );
});

describe('Gateway pre-bind and forwarding safety', () => {
  it('uses declared provider readiness only with existing matching network proof and running bindings', async () => {
    const f = fixture();
    f.options.providerReady = () => true;
    const safety = f.validator();
    await safety.validate(f.route, []);
    f.route.mode = 'online';
    vi.mocked(f.options.probeBackend).mockClear().mockResolvedValue(false);
    expect(await safety.validate(f.route, [f.route.public])).toEqual({ backendReady: true });
    expect(f.options.probeBackend).not.toHaveBeenCalled();
    f.server.suspended = true;
    await expect(safety.validate(f.route, [f.route.public])).rejects.toThrow();
    f.server.suspended = false;
    f.options.loadProof = async () => null;
    await expect(safety.validate(f.route, [f.route.public])).rejects.toThrow();
  });

  it.each(['identity', 'collision', 'stale', 'bindings'] as const)(
    'provider readiness cannot bypass %s validation',
    async (failure) => {
      const f = fixture();
      f.options.providerReady = () => true;
      const safety = f.validator();
      await safety.validate(f.route, []);
      vi.mocked(f.options.probeBackend).mockClear().mockResolvedValue(false);
      if (failure === 'identity') f.server.uuid = 'foreign';
      if (failure === 'collision')
        f.observation.sockets.push({ ...f.route.public, processOwned: false, inode: 'foreign' });
      if (failure === 'stale') f.observation.observedAt -= 5001;
      if (failure === 'bindings')
        Object.assign(f.observation.containers[0] ?? {}, { activeBindings: [] });
      await expect(safety.validate(f.route, [f.route.public])).rejects.toThrow();
      expect(f.options.probeBackend).not.toHaveBeenCalled();
    },
  );

  it('provider readiness rejects observation expiry while loading the network proof', async () => {
    const f = fixture();
    f.options.providerReady = () => true;
    let clock = f.observation.observedAt;
    f.options.now = () => clock;
    const safety = f.validator();
    await safety.validate(f.route, []);
    f.options.loadProof = async () => {
      clock += 5001;
      return f.proof();
    };
    await expect(safety.validate(f.route, [f.route.public])).rejects.toThrow();
  });

  it('provider readiness cannot forward a stopped backend', async () => {
    const f = fixture();
    f.options.providerReady = () => true;
    const safety = f.validator();
    await safety.validate(f.route, []);
    Object.assign(f.observation.containers[0] ?? {}, { running: false, activeBindings: [] });
    expect(await safety.validate(f.route, [f.route.public])).toEqual({ backendReady: false });
  });

  it('separates waking validation timings without leaking context or changing safety on sink failure', async () => {
    const f = fixture();
    f.route.mode = 'waking';
    const events: Parameters<NonNullable<GatewaySafetyOptions['onTiming']>>[0][] = [];
    f.options.onTiming = (event) => {
      events.push(event);
    };
    await f.validator().validateBackend(f.route);
    expect(events.map((e) => e.stage)).toEqual(
      expect.arrayContaining([
        'context',
        'provider_inventory',
        'host_observation',
        'inspect_total',
        'backend_protocol',
        'proof_write',
      ]),
    );
    expect(new Set(events.map((e) => e.validationId)).size).toBe(1);
    expect(events.every((e) => e.durationMs >= 0 && e.outcome === 'completed')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('nh-owned-server');
    f.options.onTiming = () => {
      throw new Error('private sink failure');
    };
    await expect(f.validator().validateBackend(f.route)).resolves.toBeUndefined();
    f.server.suspended = true;
    await expect(f.validator().validateBackend(f.route)).rejects.toThrow();
  });

  it.each([
    ['missing-container', 'waking'],
    ['active-bindings', 'waking'],
    ['missing-container', 'sleeping'],
    ['active-bindings', 'sleeping'],
  ] as const)(
    'retains only an already owned waiting responder during %s recreation in %s and requires full proof before forwarding',
    async (transition, mode) => {
      const f = fixture();
      const validator = f.validator();
      await validator.validate(f.route, []);
      const original = structuredClone(f.observation.containers[0]);
      if (!original) throw new Error('fixture');
      f.route.mode = mode;
      if (transition === 'missing-container') f.observation.containers = [];
      else {
        f.observation.containers[0] = { ...original, id: 'c'.repeat(64), activeBindings: [] };
      }
      vi.mocked(f.options.probeBackend).mockClear().mockResolvedValue(false);
      await expect(validator.validate(f.route, [f.route.public])).resolves.toEqual({
        backendReady: false,
      });
      expect(f.options.probeBackend).not.toHaveBeenCalled();
      await expect(validator.validateBackend(f.route)).rejects.toBeInstanceOf(GatewaySafetyError);
      // Absence cannot authorize a new bind, even with the same durable proof.
      await expect(validator.validate(f.route, [])).rejects.toBeInstanceOf(GatewaySafetyError);
      f.route.mode = 'online';
      await expect(validator.validate(f.route, [f.route.public])).rejects.toBeInstanceOf(
        GatewaySafetyError,
      );
      f.observation.containers = [{ ...original, id: 'c'.repeat(64) }];
      vi.mocked(f.options.probeBackend).mockResolvedValue(true);
      await expect(validator.validate(f.route, [f.route.public])).resolves.toEqual({
        backendReady: true,
      });
    },
  );
  it('keeps the existing sleeping responder through a new wake generation before Docker recreates its container', async () => {
    const f = fixture();
    const validator = f.validator();
    await validator.validate(f.route, []);
    f.route.mode = 'sleeping';
    const container = f.observation.containers[0];
    if (!container) throw new Error('fixture');
    container.running = false;
    container.activeBindings = [];
    await validator.validate(f.route, [f.route.public]);
    f.route.mode = 'waking';
    f.route.generation = '77777777-7777-4777-8777-777777777777';
    f.route.revision++;
    f.observation.containers = [];
    vi.mocked(f.options.probeBackend).mockClear().mockResolvedValue(false);
    await expect(validator.validate(f.route, [f.route.public])).resolves.toEqual({
      backendReady: false,
    });
    expect(f.options.probeBackend).not.toHaveBeenCalled();
    await expect(validator.validateBackend(f.route)).rejects.toBeInstanceOf(GatewaySafetyError);
    await expect(validator.validate(f.route, [])).rejects.toBeInstanceOf(GatewaySafetyError);
    // Core changing mode alone still cannot authorize forwarding without Docker/protocol evidence.
    f.route.mode = 'online';
    await expect(validator.validate(f.route, [f.route.public])).rejects.toBeInstanceOf(
      GatewaySafetyError,
    );
  });
  it.each([
    'socket-collision',
    'allocation-collision',
    'foreign-backend',
    'provider-identity',
    'changed-provider-owner',
    'namespace',
    'daemon',
    'network',
    'proof',
    'node-challenge',
  ] as const)(
    'fails closed on fresh %s even during a known backend replacement gap',
    async (failure) => {
      const f = fixture();
      const validator = f.validator();
      await validator.validate(f.route, []);
      const original = structuredClone(f.observation.containers[0]);
      if (!original) throw new Error('fixture');
      f.route.mode = 'waking';
      f.route.generation = '77777777-7777-4777-8777-777777777777';
      f.observation.containers = [];
      if (failure === 'socket-collision')
        f.observation.sockets.push({ ...f.route.public, processOwned: false, inode: 'foreign' });
      if (failure === 'allocation-collision')
        vi.mocked(f.options.provider.listAllocations).mockResolvedValue([
          f.allocation,
          { id: 99, ip: f.route.public.address, port: f.route.public.port, assigned: true },
        ]);
      if (failure === 'foreign-backend')
        f.observation.containers.push({ ...original, name: '/foreign', id: 'd'.repeat(64) });
      if (failure === 'provider-identity') f.server.external_id = 'foreign';
      if (failure === 'changed-provider-owner') {
        const context = await f.options.resolveContext(f.route);
        f.server.user = 9;
        vi.mocked(f.options.resolveContext).mockResolvedValue({ ...context, providerUserId: 9 });
      }
      if (failure === 'namespace')
        f.observation.namespaceId = f.observation.hostNamespaceId = 'net:[200]';
      if (failure === 'daemon') f.observation.dockerDaemonId = 'different-daemon';
      if (failure === 'network') {
        const network = f.observation.networks[0];
        if (network) network.driver = 'host';
      }
      if (failure === 'proof') vi.mocked(f.options.loadProof).mockResolvedValue(null);
      if (failure === 'node-challenge') vi.mocked(f.options.probeNode).mockResolvedValue(false);
      await expect(validator.validate(f.route, [f.route.public])).rejects.toBeInstanceOf(
        GatewaySafetyError,
      );
    },
  );
  it('does not trust changed configured bindings or ambiguous/misidentified recreated containers', async () => {
    for (const kind of ['configured', 'ambiguous', 'identity'] as const) {
      const f = fixture();
      const validator = f.validator();
      await validator.validate(f.route, []);
      f.route.mode = 'waking';
      const container = f.observation.containers[0];
      if (!container) throw new Error('fixture');
      if (kind === 'configured') container.configuredBindings = [];
      if (kind === 'ambiguous') f.observation.containers.push({ ...container, id: 'c'.repeat(64) });
      if (kind === 'identity') container.service = 'foreign';
      await expect(validator.validate(f.route, [f.route.public])).rejects.toBeInstanceOf(
        GatewaySafetyError,
      );
    }
  });

  it('returns the exact coherent sample after one fresh inventory, protocol challenge and saved proof', async () => {
    const f = fixture();
    const sample = { ready: true, idle: true, playerCount: 0 };
    const probeBackend = vi.fn(async () => sample);
    const validator = createGatewaySafetyValidator({ ...f.options, probeBackend });
    expect(await validator.validateBackend(f.route)).toBe(sample);
    expect(probeBackend).toHaveBeenCalledExactlyOnceWith(f.route, expect.any(String));
    expect(f.options.observer.observe).toHaveBeenCalledOnce();
    expect(f.options.provider.listNodes).toHaveBeenCalledOnce();
    expect(f.proof()).toMatchObject({ version: 2, routeId: f.route.id });
  });
  it('never turns a structured not-ready sample into binding proof', async () => {
    const f = fixture();
    const validator = createGatewaySafetyValidator({
      ...f.options,
      probeBackend: async () => ({ ready: false, idle: true, playerCount: 0 }),
    });
    await expect(validator.validateBackend(f.route)).rejects.toThrow();
    expect(f.proof()).toBeNull();
  });

  it('proves loopback provider remap, both real Docker bindings and readiness from current namespace', async () => {
    const f = fixture();
    await f.validator().validate(f.route, []);
    expect(f.options.probeBackend).toHaveBeenCalledWith(f.route, expect.any(String));
    expect(f.proof()).toMatchObject({
      version: 2,
      serverId: f.route.serverId,
      allocationId: f.route.allocationId,
      namespaceId: 'net:[100]',
    });
    expect(f.options.provider.listAllocations).toHaveBeenCalledWith(1);
  });
  it.each(['10.5.0.1', 'fd42::1'])('preserves direct private backend %s', async (address) => {
    const f = fixture();
    f.route.backend.address = address;
    f.route.backend.allocationAddress = address;
    f.allocation.ip = address;
    f.observation.interfaceAddresses.push(address);
    for (const binding of f.observation.containers[0]?.configuredBindings ?? [])
      binding.address = address;
    for (const binding of f.observation.containers[0]?.activeBindings ?? [])
      binding.address = address;
    await f.validator().validate(f.route, []);
  });
  it('accepts expanded provider IPv6 for an immutable compressed ULA claim without allowing retargeting', async () => {
    const f = fixture();
    f.route.backend.address = 'fd42::1';
    f.route.backend.allocationAddress = 'fd42::1';
    f.allocation.ip = 'fd42:0000:0000:0000:0000:0000:0000:0001';
    f.observation.interfaceAddresses.push('fd42::1');
    for (const binding of f.observation.containers[0]?.configuredBindings ?? [])
      binding.address = 'fd42::1';
    for (const binding of f.observation.containers[0]?.activeBindings ?? [])
      binding.address = 'fd42::1';
    await f.validator().validate(f.route, []);
    f.allocation.ip = 'fd42:0000:0000:0000:0000:0000:0000:0002';
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it('does not use collision normalization to adopt IPv4-mapped IPv6 provider identity', async () => {
    const f = fixture();
    f.route.backend.allocationAddress = f.route.backend.address;
    f.allocation.ip = '::ffff:10.5.0.1';
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it.each(['tcp', 'udp'] as const)(
    'stopped direct provider allocations reserve both transports against %s',
    async (transport) => {
      const f = fixture();
      f.route.public.transport = transport;
      f.options.provider.listAllocations = vi.fn(async () => [
        f.allocation,
        { id: 8, ip: f.route.public.address, port: 25565, assigned: true },
      ]);
      await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
      expect(f.options.probeBackend).not.toHaveBeenCalled();
    },
  );
  it('does not steal unassigned provider endpoints', async () => {
    const f = fixture();
    f.options.provider.listAllocations = vi.fn(async () => [
      f.allocation,
      { id: 8, ip: f.route.public.address, port: 25565, assigned: false },
    ]);
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it.each(['0.0.0.0', '::', '::ffff:192.0.2.10'])(
    'refuses provider wildcard/mapped collision %s',
    async (address) => {
      const f = fixture();
      f.options.provider.listAllocations = vi.fn(async () => [
        f.allocation,
        { id: 8, ip: address, port: 25565, assigned: true },
      ]);
      await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    },
  );
  it('refuses unknown nodes instead of assuming they are remote', async () => {
    const f = fixture();
    f.options.provider.listNodes = vi.fn(async () => [f.node, { ...f.node, id: 2 }]);
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it('shares successful listener provider evidence with backend probes, not socket or game samples', async () => {
    const f = fixture();
    const safety = f.validator();
    await safety.validate(f.route, []);
    await safety.validateBackend(f.route);
    await safety.validateBackend(f.route);
    expect(f.options.provider.listNodes).toHaveBeenCalledTimes(1);
    expect(f.options.provider.listAllocations).toHaveBeenCalledTimes(1);
    expect(f.options.provider.getApplicationServer).toHaveBeenCalledTimes(1);
    expect(f.options.observer.observe).toHaveBeenCalledTimes(3);
    expect(f.options.resolveContext).toHaveBeenCalledTimes(3);
    expect(f.options.probeBackend).toHaveBeenCalledTimes(3);
    await safety.validate(f.route, [f.route.public]);
    expect(f.options.provider.listNodes).toHaveBeenCalledTimes(2);
  });
  it.each(['waking', 'online'] as const)(
    'probes an unchanged leased %s backend without repeating full inspection or proof writes',
    async (mode) => {
      const f = fixture();
      f.route.mode = mode;
      const safety = f.validator();
      await safety.validate(f.route, []);
      const sample = { ready: true, idle: false, playerCount: 2 };
      f.options.probeBackend = vi.fn(async () => sample);
      expect(await safety.probeLeasedBackend?.(f.route)).toBe(sample);
      expect(f.options.probeBackend).toHaveBeenCalledExactlyOnceWith(f.route, expect.any(String));
      expect(f.options.observer.observe).toHaveBeenCalledOnce();
      expect(f.options.resolveContext).toHaveBeenCalledOnce();
      expect(f.options.provider.listNodes).toHaveBeenCalledOnce();
      expect(f.options.saveProof).toHaveBeenCalledOnce();
      expect(f.options.probeNode).toHaveBeenCalledTimes(mode === 'waking' ? 1 : 0);
      // A subsequent renewal still checks every source, even while the grant is fresh.
      await safety.validate(f.route, [f.route.public]);
      expect(f.options.observer.observe).toHaveBeenCalledTimes(2);
      expect(f.options.provider.listNodes).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    'unvalidated',
    'revision',
    'generation',
    'wake-job',
    'backend',
    'online',
    'expired',
  ] as const)('requires normal backend inspection for %s leased probes', async (change) => {
    const f = fixture();
    f.route.mode = 'waking';
    let now = f.observation.observedAt;
    f.options.now = () => now;
    const safety = f.validator();
    if (change !== 'unvalidated') await safety.validate(f.route, []);
    if (change === 'revision') f.route.revision++;
    if (change === 'generation') f.route.generation = ids.server;
    if (change === 'wake-job') f.route.wakeJobId = ids.server;
    if (change === 'backend') f.route.backend.port++;
    if (change === 'online') f.route.mode = 'online';
    if (change === 'expired') {
      now += f.options.policy.maximumObservationAgeMs;
      f.observation.observedAt = now;
    }
    const before = vi.mocked(f.options.observer.observe).mock.calls.length;
    if (change === 'backend') await expect(safety.probeLeasedBackend?.(f.route)).rejects.toThrow();
    else await safety.probeLeasedBackend?.(f.route);
    expect(f.options.observer.observe).toHaveBeenCalledTimes(before + 1);
    expect(f.options.resolveContext).toHaveBeenCalledTimes(before + 1);
  });
  it.each(['stopped', 'missing-bindings'] as const)(
    'does not retain fast authority for a %s backend',
    async (change) => {
      const f = fixture();
      f.route.mode = 'waking';
      const safety = f.validator();
      await safety.validate(f.route, []);
      const container = f.observation.containers[0];
      if (!container) throw new Error('Missing fixture container');
      if (change === 'stopped') container.running = false;
      else container.activeBindings = [];
      await safety.validate(f.route, [f.route.public]);
      await expect(safety.probeLeasedBackend?.(f.route)).rejects.toThrow();
      expect(f.options.observer.observe).toHaveBeenCalledTimes(3);
    },
  );
  it.each(['waking', 'online'] as const)(
    'rejects %s leased samples that cross the original evidence deadline without extending it',
    async (mode) => {
      const f = fixture();
      f.route.mode = mode;
      let now = f.observation.observedAt;
      f.options.now = () => now;
      const safety = f.validator();
      await safety.validate(f.route, []);
      f.options.probeBackend = async () => {
        now += 5000;
        return { ready: true, idle: false, playerCount: 1 };
      };
      await expect(safety.probeLeasedBackend?.(f.route)).rejects.toMatchObject({
        reason: 'observation_stale',
      });
      expect(f.options.observer.observe).toHaveBeenCalledOnce();
      expect(f.options.saveProof).toHaveBeenCalledOnce();
    },
  );
  it('never accepts a negative leased protocol sample as readiness', async () => {
    const f = fixture();
    f.route.mode = 'waking';
    const safety = f.validator();
    await safety.validate(f.route, []);
    f.options.probeBackend = async () => ({ ready: false });
    await expect(safety.probeLeasedBackend?.(f.route)).rejects.toMatchObject({
      reason: 'backend_protocol',
    });
    expect(f.options.saveProof).toHaveBeenCalledOnce();
  });
  it.each(['unchanged', 'owner', 'container', 'failure'] as const)(
    'joins an already active %s renewal without duplicate backend inventory or host inspection',
    async (change) => {
      const f = fixture();
      f.route.mode = 'waking';
      const safety = f.validator();
      await safety.validate(f.route, []);
      if (change === 'owner') {
        const context = await f.options.resolveContext(f.route);
        f.server.user = 3;
        f.options.resolveContext = vi.fn(async () => ({ ...context, providerUserId: 3 }));
      }
      if (change === 'container') {
        const container = f.observation.containers[0];
        if (!container) throw new Error('Missing fixture container');
        container.id = 'c'.repeat(64);
      }
      if (change === 'failure') f.server.suspended = true;
      let finish!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.options.provider.listNodes = vi.fn(async () => {
        entered();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return [f.node];
      });
      const sample = { ready: true, playerCount: 1, idle: false };
      f.options.probeBackend = vi.fn(async () => sample);
      const renewal = safety.validate(f.route, [f.route.public]).catch((error) => error);
      await started;
      const pending = safety.probeLeasedBackend?.(f.route).catch((error) => error);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.options.observer.observe).toHaveBeenCalledTimes(2);
      expect(f.options.provider.listNodes).toHaveBeenCalledOnce();
      expect(f.options.probeBackend).not.toHaveBeenCalled();
      finish();
      await renewal;
      const result = await pending;
      if (change === 'unchanged') expect(result).toBe(sample);
      else
        expect(result).toMatchObject({
          reason: 'observation_stale',
          observationFailure: 'lease_grant_replaced',
        });
      expect(f.options.observer.observe).toHaveBeenCalledTimes(2);
      expect(f.options.provider.listAllocations).toHaveBeenCalledTimes(2);
      expect(f.options.provider.getApplicationServer).toHaveBeenCalledTimes(2);
    },
  );

  it('does not extend the original evidence deadline after joining a successful renewal', async () => {
    const f = fixture();
    f.route.mode = 'waking';
    let clock = f.observation.observedAt;
    f.options.now = () => clock;
    const safety = f.validator();
    await safety.validate(f.route, []);
    clock += 4999;
    f.observation.observedAt = clock;
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.options.provider.listNodes = async () => {
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return [f.node];
    };
    const renewal = safety.validate(f.route, [f.route.public]);
    await started;
    const pending = safety.probeLeasedBackend?.(f.route).catch((error) => error);
    f.options.probeBackend = async () => {
      clock += 2;
      return { ready: true };
    };
    finish();
    await renewal;
    expect(await pending).toMatchObject({ reason: 'observation_stale' });
    expect(f.options.observer.observe).toHaveBeenCalledTimes(2);
  });

  it('bounds joining an active renewal by the original grant deadline', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.route.mode = 'waking';
      let clock = f.observation.observedAt;
      f.options.now = () => clock;
      const safety = f.validator();
      await safety.validate(f.route, []);
      let finish!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.options.provider.listNodes = async () => {
        entered();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return [f.node];
      };
      const renewal = safety.validate(f.route, [f.route.public]).catch((error) => error);
      await started;
      const pending = safety.probeLeasedBackend?.(f.route).catch((error) => error);
      clock += 5000;
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({ reason: 'observation_stale' });
      expect(f.options.observer.observe).toHaveBeenCalledTimes(2);
      finish();
      await renewal;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    'unchanged',
    'owner',
    'container',
    'revision',
    'expired',
    'failure',
    'overlap-failure',
  ] as const)('coordinates an in-flight leased sample with a %s renewal', async (change) => {
    const f = fixture();
    f.route.mode = 'waking';
    let now = f.observation.observedAt;
    f.options.now = () => now;
    const safety = f.validator();
    await safety.validate(f.route, []);
    const sample = { ready: true, idle: false, playerCount: 1 };
    let finishProbe!: () => void;
    f.options.probeBackend = vi.fn(
      () =>
        new Promise<typeof sample>((resolve) => {
          finishProbe = () => resolve(sample);
        }),
    );
    const pending = safety.probeLeasedBackend?.(f.route);
    if (!pending) throw new Error('Missing leased probe');
    let finishRenewal!: () => void;
    let renewalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      renewalStarted = resolve;
    });
    let renewalCalls = 0;
    f.options.provider.listNodes = vi.fn(async () => {
      if (++renewalCalls > 1) throw new Error('Concurrent renewal failed');
      renewalStarted();
      await new Promise<void>((resolve) => {
        finishRenewal = resolve;
      });
      return [f.node];
    });
    if (change === 'owner') {
      f.server.user = 3;
      const context = await f.options.resolveContext(f.route);
      f.options.resolveContext = async () => ({ ...context, providerUserId: 3 });
    }
    if (change === 'container') {
      const container = f.observation.containers[0];
      if (!container) throw new Error('Missing container');
      container.id = 'c'.repeat(64);
    }
    const renewedRoute = {
      ...f.route,
      revision: f.route.revision + (change === 'revision' ? 1 : 0),
    };
    const renewal = safety.validate(renewedRoute, [f.route.public]);
    await started;
    let settled = false;
    const outcome = pending.then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    finishProbe();
    await Promise.resolve();
    expect(settled).toBe(false);
    // Renewal proof reads must not perform a second deferred protocol call.
    f.options.probeBackend = vi.fn(async () => sample);
    if (change === 'expired') now += 5000;
    if (change === 'failure') f.server.suspended = true;
    let overlapping: Promise<unknown> | undefined;
    if (change === 'overlap-failure') {
      overlapping = safety.validate(f.route, [f.route.public]).catch((error) => error);
    }
    finishRenewal();
    await renewal.catch(() => undefined);
    if (overlapping) {
      // The queued renewal runs after the first and must not restore its grant.
      f.server.suspended = true;
      finishRenewal();
      await overlapping;
    }
    const result = await outcome;
    if (change === 'unchanged') expect(result).toBe(sample);
    else expect(result).toMatchObject({ reason: 'observation_stale' });
  });
  it('bounds waiting for an unfinished renewal by the original evidence deadline', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.route.mode = 'waking';
      let now = f.observation.observedAt;
      f.options.now = () => now;
      const safety = f.validator();
      await safety.validate(f.route, []);
      let finishProbe!: (value: boolean) => void;
      f.options.probeBackend = () =>
        new Promise((resolve) => {
          finishProbe = resolve;
        });
      const pending = safety.probeLeasedBackend?.(f.route).catch((error) => error);
      let finishRenewal!: () => void;
      let renewalStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        renewalStarted = resolve;
      });
      f.options.provider.listNodes = async () => {
        renewalStarted();
        await new Promise<void>((resolve) => {
          finishRenewal = resolve;
        });
        return [f.node];
      };
      const renewal = safety.validate(f.route, [f.route.public]).catch((error) => error);
      await started;
      finishProbe(true);
      await vi.advanceTimersByTimeAsync(0);
      now += 5000;
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({ reason: 'observation_stale' });
      finishRenewal();
      await renewal;
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not salvage a pre-failure sample after a later successful renewal', async () => {
    const f = fixture();
    f.route.mode = 'waking';
    const safety = f.validator();
    await safety.validate(f.route, []);
    let finishProbe!: (value: boolean) => void;
    f.options.probeBackend = () =>
      new Promise((resolve) => {
        finishProbe = resolve;
      });
    const pending = safety.probeLeasedBackend?.(f.route).catch((error) => error);
    f.server.suspended = true;
    await expect(safety.validate(f.route, [f.route.public])).rejects.toThrow();
    f.server.suspended = false;
    f.options.probeBackend = async () => true;
    await safety.validate(f.route, [f.route.public]);
    finishProbe(true);
    expect(await pending).toMatchObject({ reason: 'observation_stale' });
  });
  it('revokes fast evidence immediately when a renewal fails during a leased probe', async () => {
    const f = fixture();
    f.route.mode = 'waking';
    const safety = f.validator();
    await safety.validate(f.route, []);
    let resolveProbe: ((result: boolean) => void) | undefined;
    f.options.probeBackend = () => new Promise((resolve) => (resolveProbe = resolve));
    const pending = safety.probeLeasedBackend?.(f.route);
    f.server.suspended = true;
    await expect(safety.validate(f.route, [f.route.public])).rejects.toThrow();
    resolveProbe?.(true);
    await expect(pending).rejects.toMatchObject({
      reason: 'observation_stale',
      observationFailure: 'lease_grant_replaced',
    });
    await expect(safety.probeLeasedBackend?.(f.route)).rejects.toThrow();
    expect(f.options.observer.observe).toHaveBeenCalledTimes(3);
  });
  it('revokes fast evidence after a full backend inspection observes a conflict', async () => {
    const f = fixture();
    f.route.mode = 'waking';
    const safety = f.validator();
    await safety.validate(f.route, []);
    const original = f.observation.containers[0];
    if (!original) throw new Error('Missing fixture container');
    f.observation.containers.push({ ...original, id: 'c'.repeat(64), name: '/foreign' });
    await expect(safety.validateBackend(f.route)).rejects.toThrow();
    await expect(safety.probeLeasedBackend?.(f.route)).rejects.toThrow();
    expect(f.options.observer.observe).toHaveBeenCalledTimes(3);
  });
  it.each(['revision', 'generation', 'context', 'expired', 'failed-renewal'] as const)(
    'does not reuse provider evidence after %s',
    async (change) => {
      const f = fixture();
      let now = f.observation.observedAt;
      f.options.now = () => now;
      const safety = f.validator();
      await safety.validate(f.route, []);
      if (change === 'revision') f.route.revision++;
      if (change === 'generation') f.route.generation = ids.server;
      if (change === 'context') {
        const old = f.options.resolveContext;
        f.options.resolveContext = async (route) => ({
          ...(await old(route)),
          externalId: 'new-owner',
        });
      }
      if (change === 'expired') {
        now += 5001;
        f.observation.observedAt = now;
      }
      if (change === 'failed-renewal') {
        f.server.suspended = true;
        await expect(safety.validate(f.route, [f.route.public])).rejects.toThrow();
      }
      const before = vi.mocked(f.options.provider.listNodes).mock.calls.length;
      if (change === 'context' || change === 'failed-renewal')
        await expect(safety.validateBackend(f.route)).rejects.toThrow();
      else await safety.validateBackend(f.route);
      expect(f.options.provider.listNodes).toHaveBeenCalledTimes(before + 1);
    },
  );
  it('still rejects fresh Docker conflicts while sharing provider evidence', async () => {
    const f = fixture();
    const safety = f.validator();
    await safety.validate(f.route, []);
    const original = f.observation.containers[0];
    if (!original) throw new Error('Missing fixture container');
    f.observation.containers.push({ ...original, id: 'c'.repeat(64), name: '/foreign' });
    await expect(safety.validateBackend(f.route)).rejects.toThrow();
    expect(f.options.provider.listNodes).toHaveBeenCalledTimes(1);
  });
  it('expires shared evidence if the protocol probe crosses its original age budget', async () => {
    const f = fixture();
    let now = f.observation.observedAt;
    f.options.now = () => now;
    const safety = f.validator();
    await safety.validate(f.route, []);
    f.options.probeBackend = async () => {
      now += 5001;
      f.observation.observedAt = now;
      return true;
    };
    await expect(safety.validateBackend(f.route)).rejects.toMatchObject({
      reason: 'observation_stale',
    });
  });
  it('requires fresh inventory for every renewal', async () => {
    const f = fixture();
    const safety = f.validator();
    await safety.validate(f.route, []);
    f.allocation.assigned = false;
    await expect(safety.validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    expect(f.options.provider.listNodes).toHaveBeenCalledTimes(2);
  });
  it('collects independent read-only sources concurrently before authorizing a bind', async () => {
    const f = fixture();
    const entered = new Set<string>();
    let release = () => {};
    let allEntered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      allEntered = resolve;
    });
    const enter = async (name: string) => {
      entered.add(name);
      if (entered.size === 4) allEntered();
      await gate;
    };
    const old = { observer: f.options.observer.observe, ...f.options.provider };
    f.options.observer.observe = vi.fn(async () => {
      await enter('observer');
      return old.observer();
    });
    f.options.provider.listNodes = vi.fn(async () => {
      await enter('nodes');
      return old.listNodes();
    });
    f.options.provider.getApplicationServer = vi.fn(async (id) => {
      await enter('server');
      return old.getApplicationServer(id);
    });
    f.options.provider.listAllocations = vi.fn(async (id) => {
      await enter('allocations');
      return old.listAllocations(id);
    });
    const checking = f.validator().validate(f.route, []);
    await started;
    expect(f.options.probeBackend).not.toHaveBeenCalled();
    release();
    await checking;
    expect(entered).toEqual(new Set(['observer', 'nodes', 'server', 'allocations']));
  });
  it('rejects evidence that expires while a parallel provider inventory read is pending', async () => {
    const f = fixture();
    let timestamp = f.observation.observedAt;
    f.options.now = () => timestamp;
    f.options.provider.listAllocations = vi.fn(async () => {
      timestamp += 5001;
      return [f.allocation];
    });
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    expect(f.options.saveProof).not.toHaveBeenCalled();
  });
  it('does not reuse a prior successful socket observation at the next bind gate', async () => {
    const f = fixture();
    const validator = f.validator();
    await validator.validate(f.route, []);
    f.observation.sockets.push({ ...f.route.public, inode: 'foreign', processOwned: false });
    await expect(validator.validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    expect(f.options.observer.observe).toHaveBeenCalledTimes(2);
    expect(f.options.provider.listAllocations).toHaveBeenCalledTimes(2);
  });
  it('bounds concurrent provider discovery even when many nodes are configured', async () => {
    const f = fixture();
    const template = f.options.policy.nodes[0];
    if (!template) throw new Error('fixture policy');
    f.options.policy.nodes = Array.from({ length: 12 }, (_, index) => ({
      ...template,
      nodeId: index + 1,
      nodeUuid: `provider-node-${index + 1}`,
    }));
    f.options.provider.listNodes = vi.fn(async () =>
      f.options.policy.nodes.map((node) => ({ id: node.nodeId, uuid: node.nodeUuid })),
    );
    let active = 0,
      maximum = 0;
    f.options.provider.listAllocations = vi.fn(async (id) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return id === 1 ? [f.allocation] : [];
    });
    await f.validator().validate(f.route, []);
    expect(maximum).toBe(4);
    expect(f.options.provider.listAllocations).toHaveBeenCalledTimes(12);
  });
  it.each(['uuid', 'external_id', 'user', 'node', 'nest', 'egg', 'suspended'])(
    'refuses provider identity drift in %s',
    async (key) => {
      const f = fixture();
      Object.assign(f.server, {
        [key]:
          key === 'suspended'
            ? true
            : typeof f.server[key as keyof ApplicationServer] === 'number'
              ? 999
              : 'foreign',
      });
      await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    },
  );
  it.each(['ip', 'port', 'assigned'])('refuses allocation identity drift in %s', async (key) => {
    const f = fixture();
    Object.assign(f.allocation, {
      [key]: key === 'ip' ? '10.6.0.1' : key === 'port' ? 25566 : false,
    });
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it.each(['networkMode', 'service', 'containerType', 'name'])(
    'refuses exact container identity drift in %s',
    async (key) => {
      const f = fixture();
      Object.assign(f.observation.containers[0] ?? {}, { [key]: 'foreign' });
      await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    },
  );
  it('requires both configured TCP and UDP bindings even for a TCP-only SDK role', async () => {
    const f = fixture();
    f.observation.containers[0]?.configuredBindings.pop();
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it('rejects mismatched actual live PortBindings instead of trusting configured bind declarations', async () => {
    const f = fixture();
    f.observation.containers[0]?.activeBindings.splice(0);
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it.each(['host', 'overlay', 'macvlan'])(
    'refuses unsupported network driver %s',
    async (driver) => {
      const f = fixture();
      Object.assign(f.observation.networks[0] ?? {}, { driver });
      await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    },
  );
  it('rejects routed bridge configuration', async () => {
    const f = fixture();
    Object.assign(f.observation.networks[0]?.options ?? {}, {
      'com.docker.network.bridge.gateway_mode_ipv4': 'routed',
    });
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it('rejects gateway namespace mismatch and non-owned public addresses', async () => {
    const f = fixture();
    f.observation.namespaceId = 'net:[200]';
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    f.observation.namespaceId = f.observation.hostNamespaceId;
    f.route.public.address = '192.0.2.11';
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it('rejects stale or future observations', async () => {
    const f = fixture();
    f.observation.observedAt -= 5001;
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    f.observation.observedAt += 6000;
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it('never exempts caller-declared listener ownership without this-process socket inode evidence', async () => {
    const f = fixture();
    f.observation.sockets.push({ ...f.route.public, inode: '123', processOwned: false });
    await expect(f.validator().validate(f.route, [f.route.public])).rejects.toThrow(
      'allocation_unavailable',
    );
    Object.assign(f.observation.sockets[0] ?? {}, { processOwned: true });
    await f.validator().validate(f.route, [f.route.public]);
  });
  it('never exempts a wildcard own socket or a Docker published binding', async () => {
    const f = fixture();
    f.observation.sockets.push({
      ...f.route.public,
      address: '0.0.0.0',
      inode: '123',
      processOwned: true,
    });
    await expect(f.validator().validate(f.route, [f.route.public])).rejects.toThrow(
      'allocation_unavailable',
    );
    f.observation.sockets = [];
    f.observation.containers[0]?.configuredBindings.push(f.route.public);
    await expect(f.validator().validate(f.route, [f.route.public])).rejects.toThrow(
      'allocation_unavailable',
    );
  });
  it('requires a protocol response, not a running container or UDP send success', async () => {
    const f = fixture();
    f.options.probeBackend = vi.fn(async () => false);
    await expect(f.validator().validateBackend(f.route)).rejects.toThrow('allocation_unavailable');
    expect(f.options.saveProof).not.toHaveBeenCalled();
  });
  it('bootstraps a waiting listener with one fresh inspection and a real protocol proof', async () => {
    const f = fixture();
    f.route.mode = 'waking';
    await f.validator().validate(f.route, []);
    expect(f.options.provider.listNodes).toHaveBeenCalledTimes(1);
    expect(f.options.provider.listAllocations).toHaveBeenCalledTimes(1);
    expect(f.options.provider.getApplicationServer).toHaveBeenCalledTimes(1);
    expect(f.options.observer.observe).toHaveBeenCalledTimes(1);
    expect(f.options.probeBackend).toHaveBeenCalledTimes(1);
    expect(f.options.probeNode).toHaveBeenCalledTimes(1);
    expect(f.proof()?.version).toBe(2);
    // Renewal still reads fresh collision/identity evidence, without rehashing proof.
    await f.validator().validate(f.route, []);
    expect(f.options.provider.listAllocations).toHaveBeenCalledTimes(2);
    expect(f.options.probeBackend).toHaveBeenCalledTimes(1);
  });
  it('rejects bootstrap evidence that expires during the actual backend probe', async () => {
    const f = fixture();
    f.route.mode = 'waking';
    let clock = f.observation.observedAt;
    f.options.now = () => clock;
    f.options.probeBackend = vi.fn(async () => {
      clock += f.options.policy.maximumObservationAgeMs + 1;
      return true;
    });
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    expect(f.options.saveProof).not.toHaveBeenCalled();
    expect(f.options.probeNode).not.toHaveBeenCalled();
  });
  it.each(['protocol', 'identity', 'collision', 'node challenge'] as const)(
    'never bootstraps a waiting listener past a failed %s check',
    async (failure) => {
      const f = fixture();
      f.route.mode = 'waking';
      if (failure === 'protocol') vi.mocked(f.options.probeBackend).mockResolvedValue(false);
      if (failure === 'identity') f.server.external_id = 'foreign-resource';
      if (failure === 'collision')
        f.observation.sockets.push({
          ...f.route.public,
          inode: '123',
          processOwned: false,
        });
      if (failure === 'node challenge') vi.mocked(f.options.probeNode).mockResolvedValue(false);
      await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
      if (failure !== 'node challenge') expect(f.options.saveProof).not.toHaveBeenCalled();
    },
  );
  it('does not establish first sleeping proof without a previously ready exact binding', async () => {
    const f = fixture();
    f.route.mode = 'sleeping';
    Object.assign(f.observation.containers[0] ?? {}, { running: false });
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    expect(f.options.probeNode).not.toHaveBeenCalled();
  });
  it('restarts a permanent sleeping listener only with persisted exact proof and fresh node challenge', async () => {
    const f = fixture();
    await f.validator().validateBackend(f.route);
    f.route.mode = 'sleeping';
    Object.assign(f.observation.containers[0] ?? {}, { running: false });
    Object.assign(f.observation.containers[0] ?? {}, { activeBindings: [] });
    await f.validator().validate(f.route, []);
    expect(f.options.probeNode).toHaveBeenCalledWith(
      f.route,
      await f.options.resolveContext(f.route),
    );
    f.options.probeNode = vi.fn(async () => false);
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it.each(['sleeping', 'waking'] as const)(
    'retains the %s listener across a corroborated Wings container recreation',
    async (mode) => {
      const f = fixture();
      await f.validator().validateBackend(f.route);
      f.route.mode = mode;
      Object.assign(f.observation.containers[0] ?? {}, {
        id: 'f'.repeat(64),
        running: false,
        activeBindings: [],
      });
      vi.mocked(f.options.probeBackend).mockClear().mockResolvedValue(false);
      await f.validator().validate(f.route, []);
      expect(f.options.probeNode).toHaveBeenCalledWith(
        f.route,
        await f.options.resolveContext(f.route),
      );
      expect(f.options.probeBackend).not.toHaveBeenCalled();
      // A retained waiting listener is not evidence that game traffic may forward.
      await expect(f.validator().validateBackend(f.route)).rejects.toThrow(
        'allocation_unavailable',
      );
      Object.assign(f.observation.containers[0] ?? {}, {
        running: true,
        activeBindings: structuredClone(f.observation.containers[0]?.configuredBindings),
      });
      f.route.mode = 'online';
      await expect(f.validator().validate(f.route, [])).resolves.toEqual({ backendReady: false });
      await expect(f.validator().validateBackend(f.route)).rejects.toThrow(
        'allocation_unavailable',
      );
      vi.mocked(f.options.probeBackend).mockResolvedValue(true);
      await f.validator().validate(f.route, []);
    },
  );
  it.each(['stopped', 'not-ready', 'probe-error'] as const)(
    'retains a safe permanent listener when the online backend is %s, without forwarding',
    async (failure) => {
      const f = fixture();
      await f.validator().validateBackend(f.route);
      if (failure === 'stopped')
        Object.assign(f.observation.containers[0] ?? {}, { running: false, activeBindings: [] });
      else if (failure === 'not-ready') vi.mocked(f.options.probeBackend).mockResolvedValue(false);
      else vi.mocked(f.options.probeBackend).mockRejectedValue(new Error('connection refused'));
      await expect(f.validator().validate(f.route, [])).resolves.toEqual({ backendReady: false });
      expect(f.options.probeNode).toHaveBeenCalledWith(
        f.route,
        await f.options.resolveContext(f.route),
      );
      // Losing node reachability or ownership still closes the listener.
      vi.mocked(f.options.probeNode).mockResolvedValue(false);
      await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
      vi.mocked(f.options.probeNode).mockResolvedValue(true);
      f.server.external_id = 'foreign-resource';
      await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    },
  );
  it('retains v1 only for its original container and upgrades only after a new protocol proof', async () => {
    const f = fixture();
    await f.validator().validateBackend(f.route);
    const legacy: GatewayReachabilityProof = {
      ...(f.proof() as GatewayReachabilityProof),
      version: 1,
      // Frozen digest produced by the original v1 fixture/identity format.
      digest: 'bcc7f84e90237b9a40c22abc7b97dbe777e572a56202c68e89e739fc6ef901bc',
    };
    await f.options.saveProof(f.route, legacy);
    f.route.mode = 'sleeping';
    await f.validator().validate(f.route, []);
    expect(f.proof()?.version).toBe(1);
    Object.assign(f.observation.containers[0] ?? {}, { id: 'f'.repeat(64) });
    vi.mocked(f.options.probeBackend).mockResolvedValue(false);
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    expect(f.proof()?.version).toBe(1);
    vi.mocked(f.options.probeBackend).mockResolvedValue(false);
    await expect(f.validator().validateBackend(f.route)).rejects.toThrow('allocation_unavailable');
    expect(f.proof()?.version).toBe(1);
    vi.mocked(f.options.probeBackend).mockResolvedValue(true);
    await f.validator().validateBackend(f.route);
    expect(f.proof()?.version).toBe(2);
    await f.validator().validate(f.route, []);
  });
  it.each(['uuid', 'externalId', 'claim', 'nodeUuid'] as const)(
    'rejects a dormant proof after coherent provider %s identity replacement',
    async (field) => {
      const f = fixture();
      await f.validator().validateBackend(f.route);
      const context = await f.options.resolveContext(f.route);
      f.route.mode = 'sleeping';
      Object.assign(f.observation.containers[0] ?? {}, { running: false, activeBindings: [] });
      if (field === 'uuid') {
        context.providerServerUuid = f.server.uuid = '77777777-7777-4777-8777-777777777777';
        Object.assign(f.observation.containers[0] ?? {}, { name: `/${f.server.uuid}` });
      } else if (field === 'externalId') {
        context.externalId = f.server.external_id = 'different-owner-resource';
      } else if (field === 'claim') {
        context.providerAllocationId = f.allocation.id = 8;
      } else {
        f.node.uuid = 'replacement-node';
        const node = f.options.policy.nodes[0];
        if (node) node.nodeUuid = f.node.uuid;
      }
      f.options.resolveContext = vi.fn(async () => context);
      await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
      expect(f.options.probeNode).not.toHaveBeenCalled();
    },
  );
  it('still fails closed when the recreated provider container is missing or ambiguous', async () => {
    const f = fixture();
    await f.validator().validateBackend(f.route);
    f.route.mode = 'waking';
    const original = f.observation.containers.splice(0);
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    const container = original[0];
    if (!container) throw new Error('missing fixture container');
    f.observation.containers.push(...original, { ...container, id: 'f'.repeat(64) });
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it.each(['network', 'binding', 'daemon', 'namespace'])(
    'invalidates sleeping proof after %s drift',
    async (kind) => {
      const f = fixture();
      await f.validator().validateBackend(f.route);
      f.route.mode = 'sleeping';
      Object.assign(f.observation.containers[0] ?? {}, { running: false });
      if (kind === 'network')
        Object.assign(f.observation.networks[0] ?? {}, { id: 'f'.repeat(64) });
      if (kind === 'binding')
        f.observation.containers[0]?.configuredBindings.push({
          address: '10.5.0.1',
          port: 25566,
          transport: 'tcp',
        });
      if (kind === 'daemon') f.observation.dockerDaemonId = 'changed';
      if (kind === 'namespace')
        f.observation.namespaceId = f.observation.hostNamespaceId = 'net:[101]';
      await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
    },
  );
  it('refuses hidden same-backend foreign allocated collisions', async () => {
    const f = fixture();
    f.options.provider.listAllocations = vi.fn(async () => [
      f.allocation,
      { id: 8, ip: '10.5.0.1', port: 25565, assigned: true },
    ]);
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it('refuses a stopped direct Pterodactyl container with unknown host binding semantics', async () => {
    const f = fixture();
    f.observation.containers.push({
      id: 'f'.repeat(64),
      name: '/unrelated',
      service: 'Pterodactyl',
      containerType: 'server_process',
      running: false,
      networkMode: 'host',
      configuredBindings: [],
      activeBindings: [],
    });
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
  it('protects the Wings UDP backend claim from a foreign Docker binding even on a TCP route', async () => {
    const f = fixture();
    f.observation.containers.push({
      id: 'f'.repeat(64),
      name: '/unrelated',
      service: null,
      containerType: null,
      running: false,
      networkMode: 'bridge',
      configuredBindings: [
        { address: f.route.backend.address, port: f.route.backend.port, transport: 'udp' },
      ],
      activeBindings: [],
    });
    await expect(f.validator().validate(f.route, [])).rejects.toThrow('allocation_unavailable');
  });
});
