/** Explicitly approved isolated fixture only. Docker/provider calls are READ-ONLY.
 * The coordinator creates/stops/starts/removes the exact Compose project separately. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { createGatewayDataPlane } from '../apps/game-gateway/src/data-plane.js';
import { probeNodeEndpoint } from '../apps/game-gateway/src/node-probe.js';
import type {
  GatewayProtocolAdapter,
  GatewayRoute,
  GatewaySnapshot,
} from '../packages/game-sdk/src/index.js';
import {
  addressesOverlap,
  createGatewaySafetyValidator,
  type GatewayReachabilityProof,
  gatewayNetworkPolicySchema,
} from '../packages/gateway-safety/src/index.js';
import {
  createNetworkObserver,
  createPterodactylAdapter,
} from '../packages/pterodactyl-adapter/src/index.js';

const project = 'nickhosting-m3-network-tests';
const image =
  'node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf';
const root = process.cwd();
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const phase = option('--phase');
if (
  !args.includes('--owner-approved') ||
  !['preflight', 'online', 'sleeping', 'recovered'].includes(phase ?? '')
) {
  throw new Error(
    'Requires explicit Owner approval and --phase preflight|online|sleeping|recovered; creates no Docker resources.',
  );
}
const policyPath = option('--existing-node-policy');
if (!policyPath) throw new Error('Pass an ignored, independently verified existing-node policy.');
execFileSync('git', ['check-ignore', '--quiet', '--', policyPath]);
const docker = (...argumentsList: string[]) =>
  execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...argumentsList], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('DOCKER_')),
    ),
  }).trim();
const hash = (data: string) => createHash('sha256').update(data).digest('hex');
let scenario = 'prepare';
let closeGateway: (() => Promise<void>) | undefined;
let lockPath: string | undefined;
const timingMs: Record<string, number> = {};
const supportedPolicy = { maximumLeaseMs: 15000, probeTimeoutMs: 3000 };
type Asset = { id: string; name: string; createdAt: string; imageId: string; service: string };
type Ledger = {
  version: 1;
  runId: string;
  startedAt: string;
  branch: string;
  head: string;
  project: string;
  fixtureUuid: string;
  environmentHash: string;
  scriptHash: string;
  dockerDaemonId: string;
  namespaceId: string;
  networkId: string;
  assets: Asset[];
  verifiedApiIdentity: { id: number; admin?: boolean };
  apiOriginHash: string;
  syntheticNodeId: number;
  syntheticServerId: number;
  providerAllocationIds: number[];
  gatewayId: string;
  routes: GatewayRoute[];
  proofs: Record<string, GatewayReachabilityProof>;
  results: {
    phase: string;
    completedAt: string;
    checks: string[];
    directInventoryCount: number;
    independentProductionNamespaceProof: false;
    timingMs?: Record<string, number>;
    policy?: typeof supportedPolicy;
  }[];
};
async function main() {
  const envSource = await readFile('.env.m3-network.local', 'utf8');
  const env = parseEnv(envSource);
  const required = (name: string) => {
    const value = env[name];
    assert(value, `missing ${name}`);
    return value;
  };
  const fixtureUuid = required('NH_M3_FIXTURE_UUID');
  assert.match(fixtureUuid, /^[a-f0-9-]{36}$/);
  const backend = required('NH_M3_BACKEND_IP');
  const bind = required('NH_M3_GATEWAY_BIND');
  assert.equal(bind, '127.0.0.1', 'fixture Gateway must remain exact loopback');
  const ports = ['NH_M3_GAME_PORT', 'NH_M3_QUERY_PORT'].map((name) => Number(required(name)));
  const nodePort = Number(required('NH_M3_NODE_PROBE_PORT'));
  for (const port of [...ports, nodePort])
    assert(Number.isInteger(port) && port >= 49152 && port <= 65535);
  assert.equal(new Set([...ports, nodePort]).size, 3);
  const baselinePolicy = gatewayNetworkPolicySchema.parse(
    JSON.parse(await readFile(policyPath as string, 'utf8')),
  );
  const protectedEnv = parseEnv(await readFile('.env.m2.local', 'utf8'));
  const adapter = createPterodactylAdapter({
    baseURL: protectedEnv.NH_PTERODACTYL_BASE_URL ?? '',
    applicationKey: protectedEnv.NH_PTERODACTYL_APPLICATION_KEY ?? '',
    clientKey: protectedEnv.NH_PTERODACTYL_CLIENT_KEY,
  });
  const [nodes, servers, account] = await Promise.all([
    adapter.listNodes(),
    adapter.listApplicationServers(),
    adapter.getAccount(),
  ]);
  const inventory = await Promise.all(
    nodes.map(async (node) => ({ node, allocations: await adapter.listAllocations(node.id) })),
  );
  assert(
    !servers.some(
      (server) =>
        server.uuid === fixtureUuid || server.external_id === `nh-m3-fixture:${fixtureUuid}`,
    ),
    'fixture must never identify a real Panel server',
  );
  assert.equal(nodes.length, baselinePolicy.nodes.length);
  for (const node of nodes)
    assert(
      baselinePolicy.nodes.some(
        (known) => known.nodeId === node.id && known.nodeUuid === node.uuid,
      ),
    );
  if (phase === 'preflight') {
    assert.equal(
      docker(
        'container',
        'ls',
        '--all',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--format',
        '{{.ID}}',
      ),
      '',
      'project already exists; provenance review required',
    );
    assert.equal(
      docker('network', 'ls', '--filter', `name=^${project}$`, '--format', '{{.ID}}'),
      '',
      'project network already exists',
    );
    const observed = await createNetworkObserver({
      dockerSocket: '/var/run/docker.sock',
      hostProcDirectory: '/proc/self',
      expectedHostNamespaceId: required('NH_M3_EXPECTED_NAMESPACE'),
      expectedDockerDaemonId: required('NH_M3_DOCKER_DAEMON_ID'),
    }).observe();
    const reservedPorts = [...ports, nodePort];
    for (const endpoint of [
      ...observed.sockets,
      ...observed.containers.flatMap((container) => [
        ...container.configuredBindings,
        ...container.activeBindings,
      ]),
    ]) {
      assert(
        !(
          reservedPorts.includes(endpoint.port) &&
          (addressesOverlap(endpoint.address, bind) || addressesOverlap(endpoint.address, backend))
        ),
        'planned endpoint now conflicts',
      );
    }
    for (const { node, allocations } of inventory) {
      const known = baselinePolicy.nodes.find((entry) => entry.nodeId === node.id);
      assert(known);
      for (const allocation of allocations) {
        const effective =
          allocation.ip === '127.0.0.1' ? known.loopbackRemap?.interfaceAddress : allocation.ip;
        assert(effective, 'unknown existing loopback semantics');
        assert(
          !(
            reservedPorts.includes(allocation.port) &&
            (addressesOverlap(effective, bind) || addressesOverlap(effective, backend))
          ),
          'planned endpoint conflicts with provider allocation',
        );
      }
    }
    const range = (subnet: string) => {
      const [address, length] = subnet.split('/');
      const prefix = length === undefined ? 32 : Number(length);
      assert(
        address &&
          /^\d+\.\d+\.\d+\.\d+$/.test(address) &&
          Number.isInteger(prefix) &&
          prefix >= 0 &&
          prefix <= 32,
      );
      const bytes = address.split('.').map(Number);
      assert(bytes.every((value) => value >= 0 && value <= 255));
      const value = bytes.reduce((total, byte) => total * 256 + byte, 0);
      const size = 2 ** (32 - prefix);
      const start = Math.floor(value / size) * size;
      return [start, start + size - 1] as const;
    };
    const planned = range(required('NH_M3_SUBNET'));
    const existingSubnets: string[] = [];
    for (const networkId of docker('network', 'ls', '--no-trunc', '--format', '{{.ID}}')
      .split('\n')
      .filter(Boolean)) {
      const subnets = JSON.parse(
        docker('network', 'inspect', '--format', '{{json .IPAM.Config}}', networkId),
      ) as { Subnet?: string }[] | null;
      for (const subnet of subnets ?? [])
        if (subnet.Subnet && !subnet.Subnet.includes(':')) existingSubnets.push(subnet.Subnet);
    }
    const hostRoutes = JSON.parse(
      execFileSync('ip', ['-j', '-4', 'route', 'show', 'table', 'all'], { encoding: 'utf8' }),
    ) as { dst?: string }[];
    for (const route of hostRoutes)
      if (route.dst && route.dst !== 'default') existingSubnets.push(route.dst);
    for (const subnet of existingSubnets) {
      const existing = range(subnet);
      assert(
        planned[1] < existing[0] || existing[1] < planned[0],
        'proposed subnet now overlaps existing topology',
      );
    }
    console.log(
      JSON.stringify({
        phase,
        passed: true,
        liveProviderAllocations: inventory.reduce(
          (count, row) => count + row.allocations.length,
          0,
        ),
        subnetDisjoint: true,
        plannedEndpointsDisjoint: true,
        infrastructureMutations: 0,
        listenersCreated: 0,
      }),
    );
    return;
  }
  const inspectedFormat =
    '{"id":{{json .Id}},"name":{{json .Name}},"createdAt":{{json .Created}},"imageId":{{json .Image}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},"ports":{{json .HostConfig.PortBindings}}}';
  const containerIds = docker(
    'container',
    'ls',
    '--all',
    '--no-trunc',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--format',
    '{{.ID}}',
  )
    .split('\n')
    .filter(Boolean);
  assert.equal(containerIds.length, 2, 'exact fixture project services required');
  const imageId = JSON.parse(
    docker('image', 'inspect', '--format', '{{json .Id}}', image),
  ) as string;
  const inspected = containerIds.map((id) =>
    JSON.parse(docker('container', 'inspect', '--format', inspectedFormat, id)),
  );
  const preparedAt = (await stat('.env.m3-network.local')).mtimeMs;
  const assets: Asset[] = [];
  for (const container of inspected) {
    const service = container.labels['com.docker.compose.service'];
    assert(['game', 'node-probe'].includes(service));
    assert.equal(container.labels['com.docker.compose.project'], project);
    assert.equal(container.labels['com.docker.compose.project.working_dir'], root);
    assert.equal(
      container.labels['com.docker.compose.project.config_files'],
      resolve('compose.m3-test.yaml'),
    );
    assert.equal(container.labels['ing.nickhost.test-asset'], 'm3-network-fixture');
    assert.equal(container.imageId, imageId);
    assert.equal(container.readOnly, true);
    assert.equal(container.privileged, false);
    assert(
      Date.parse(container.createdAt) >= preparedAt &&
        Date.parse(container.createdAt) <= Date.now(),
    );
    assert.equal(container.mounts.length, 1);
    assert.equal(container.mounts[0].Source, resolve('scripts/m3-network-fixture-server.mjs'));
    assert.equal(container.mounts[0].Destination, '/fixture/server.mjs');
    assert.equal(container.mounts[0].RW, false);
    const expectedPorts = service === 'game' ? ports : [nodePort];
    assert.equal(Object.keys(container.ports).length, expectedPorts.length * 2);
    for (const port of expectedPorts)
      for (const transport of ['tcp', 'udp'])
        assert.deepEqual(container.ports[`${port}/${transport}`], [
          { HostIp: backend, HostPort: String(port) },
        ]);
    if (service === 'game') {
      assert.equal(container.name, `/${fixtureUuid}`);
      assert.equal(container.running, phase !== 'sleeping');
    } else assert.equal(container.running, true);
    assets.push({
      id: container.id,
      name: container.name,
      createdAt: container.createdAt,
      imageId,
      service,
    });
  }
  assert.equal(new Set(assets.map((asset) => asset.service)).size, 2);
  assets.sort((a, b) => a.service.localeCompare(b.service));
  const network = JSON.parse(
    docker(
      'network',
      'inspect',
      '--format',
      '{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"internal":{{json .Internal}},"labels":{{json .Labels}},"ipam":{{json .IPAM.Config}},"containers":{{json .Containers}}}',
      project,
    ),
  );
  assert.equal(network.name, project);
  assert.equal(network.driver, 'bridge');
  assert.equal(network.internal, false);
  assert.equal(network.labels['com.docker.compose.project'], project);
  assert.equal(network.ipam.length, 1);
  assert.equal(network.ipam[0].Subnet, required('NH_M3_SUBNET'));
  assert.equal(network.ipam[0].Gateway, backend);
  assert(!network.ipam[0].IPRange);
  assert(
    !network.ipam[0].AuxiliaryAddresses ||
      Object.keys(network.ipam[0].AuxiliaryAddresses).length === 0,
  );
  assert(
    Object.keys(network.containers).every((id) => containerIds.includes(id)),
    'foreign network member',
  );
  assert.equal(
    JSON.parse(docker('info', '--format', '{{json .ID}}')),
    required('NH_M3_DOCKER_DAEMON_ID'),
  );
  const stateDirectory = resolve('mountdata/test-assets');
  await mkdir(stateDirectory, { recursive: true });
  const ledgerPath = resolve(stateDirectory, `m3-network-${fixtureUuid}.json`);
  const lock = await open(`${ledgerPath}.lock`, 'wx', 0o600);
  lockPath = `${ledgerPath}.lock`;
  await lock.close();
  let ledger: Ledger;
  const scriptHash = hash(await readFile('scripts/m3-network-fixture-server.mjs', 'utf8'));
  try {
    ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Ledger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || phase !== 'online') throw error;
    const nodeId = randomUUID(),
      serverId = randomUUID(),
      generation = randomUUID();
    const providerAllocationIds = ports.map(
      (_, index) =>
        Math.max(
          0,
          ...inventory.flatMap((row) => row.allocations.map((allocation) => allocation.id)),
        ) +
        index +
        1,
    );
    const routes = ports.flatMap((port) => {
      const allocationId = randomUUID();
      return (['tcp', 'udp'] as const).map(
        (transport): GatewayRoute => ({
          id: randomUUID(),
          serverId,
          nodeId,
          allocationId,
          generation,
          revision: 1,
          public: { address: bind, port, transport },
          backend: { address: backend, allocationAddress: backend, port },
          protocol: {
            handlerId: 'm3-fixture',
            gameVersion: '1',
            role: port === ports[0] ? 'game' : 'query',
          },
          mode: 'online',
          locale: 'en',
        }),
      );
    });
    ledger = {
      version: 1,
      runId: randomUUID(),
      startedAt: new Date().toISOString(),
      branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      project,
      fixtureUuid,
      environmentHash: hash(envSource),
      scriptHash,
      dockerDaemonId: required('NH_M3_DOCKER_DAEMON_ID'),
      namespaceId: required('NH_M3_EXPECTED_NAMESPACE'),
      networkId: network.id,
      assets,
      verifiedApiIdentity: account,
      apiOriginHash: hash(protectedEnv.NH_PTERODACTYL_BASE_URL ?? ''),
      syntheticNodeId: Math.max(...nodes.map((node) => node.id)) + 1,
      syntheticServerId: Math.max(...servers.map((server) => server.id)) + 1,
      providerAllocationIds,
      gatewayId: randomUUID(),
      routes,
      proofs: {},
      results: [],
    };
  }
  assert(!nodes.some((node) => node.id === ledger.syntheticNodeId));
  assert(!servers.some((server) => server.id === ledger.syntheticServerId));
  assert(
    !inventory.some((entry) =>
      entry.allocations.some((allocation) => ledger.providerAllocationIds.includes(allocation.id)),
    ),
  );
  assert.equal(ledger.version, 1);
  assert.equal(ledger.project, project);
  assert.equal(ledger.fixtureUuid, fixtureUuid);
  assert.equal(ledger.networkId, network.id);
  assert.equal(ledger.environmentHash, hash(envSource));
  assert.equal(ledger.scriptHash, scriptHash);
  assert.deepEqual(ledger.assets, assets);
  assert.deepEqual(ledger.verifiedApiIdentity, account);
  assert.equal(ledger.apiOriginHash, hash(protectedEnv.NH_PTERODACTYL_BASE_URL ?? ''));
  assert.equal(ledger.namespaceId, required('NH_M3_EXPECTED_NAMESPACE'));
  assert.equal(ledger.dockerDaemonId, required('NH_M3_DOCKER_DAEMON_ID'));
  const persist = async () => {
    await writeFile(`${ledgerPath}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    await rename(`${ledgerPath}.tmp`, ledgerPath);
  };
  await persist(); // Durable provenance precedes even an isolated fixture listener.
  scenario = 'safety';
  const ownAllocations = ports.map((port, index) => ({
    id: ledger.providerAllocationIds[index] as number,
    ip: backend,
    port,
    assigned: true,
  }));
  const observer = createNetworkObserver({
    dockerSocket: '/var/run/docker.sock',
    hostProcDirectory: '/proc/self',
    expectedHostNamespaceId: ledger.namespaceId,
    expectedDockerDaemonId: ledger.dockerDaemonId,
  });
  async function exchange(
    address: string,
    port: number,
    transport: 'tcp' | 'udp',
    bytes: Buffer,
  ): Promise<Buffer> {
    return new Promise((resolveReply, reject) => {
      let close = () => {};
      const chunks: Buffer[] = [];
      let count = 0;
      let settled = false;
      const finish = (error?: Error, value?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        close();
        if (error) reject(error);
        else resolveReply(value ?? Buffer.concat(chunks));
      };
      const timer = setTimeout(() => finish(new Error('fixture exchange timeout')), 5000);
      if (transport === 'tcp') {
        const socket = connect({ host: address, port });
        close = () => socket.destroy();
        socket.on('error', (error) => finish(error));
        socket.on('connect', () => socket.end(bytes));
        socket.on('data', (chunk: Buffer) => {
          count += chunk.length;
          if (count > Math.max(bytes.length, 1024))
            return finish(new Error('unexpected fixture response size'));
          chunks.push(chunk);
        });
        socket.on('end', () => finish());
      } else {
        const socket = createSocket('udp4');
        close = () => {
          try {
            socket.close();
          } catch {}
        };
        socket.on('error', (error) => finish(error));
        socket.on('message', (value) => finish(undefined, value));
        socket.connect(port, address, () =>
          socket.send(bytes, (error) => {
            if (error) finish(error);
          }),
        );
      }
    });
  }
  const readiness = async (route: GatewayRoute) => {
    try {
      const challenge = Buffer.concat([Buffer.from('NH-M3-GAME-READY:'), randomBytes(32)]);
      return (
        await exchange(route.backend.address, route.backend.port, route.public.transport, challenge)
      ).equals(challenge);
    } catch {
      return false;
    }
  };
  const safety = createGatewaySafetyValidator({
    provider: {
      listNodes: async () => [
        ...(await adapter.listNodes()),
        { id: ledger.syntheticNodeId, uuid: fixtureUuid },
      ],
      listAllocations: async (nodeId) =>
        nodeId === ledger.syntheticNodeId ? ownAllocations : adapter.listAllocations(nodeId),
      getApplicationServer: async (id) => {
        assert.equal(id, ledger.syntheticServerId);
        return {
          id,
          uuid: fixtureUuid,
          external_id: `nh-m3-fixture:${fixtureUuid}`,
          user: account.id,
          node: ledger.syntheticNodeId,
          nest: 1,
          egg: 1,
          suspended: false,
          relationships: {
            allocations: {
              object: 'list',
              data: ownAllocations.map((attributes) => ({ attributes })),
            },
          },
        };
      },
    },
    observer,
    policy: {
      ...baselinePolicy,
      nodes: [
        ...baselinePolicy.nodes,
        { nodeId: ledger.syntheticNodeId, nodeUuid: fixtureUuid, networkMode: project },
      ],
    },
    resolveContext: async (route) => {
      const saved = ledger.routes.find((known) => known.id === route.id);
      assert(
        saved &&
          saved.serverId === route.serverId &&
          saved.nodeId === route.nodeId &&
          saved.allocationId === route.allocationId,
      );
      assert.deepEqual(route.backend, saved.backend);
      return {
        providerServerId: ledger.syntheticServerId,
        providerServerUuid: fixtureUuid,
        externalId: `nh-m3-fixture:${fixtureUuid}`,
        providerUserId: account.id,
        providerNodeId: ledger.syntheticNodeId,
        providerAllocationId: ledger.providerAllocationIds[
          ports.indexOf(route.backend.port)
        ] as number,
        nestId: 1,
        eggId: 1,
      };
    },
    loadProof: async (route) => ledger.proofs[route.id] ?? null,
    saveProof: async (route, proof) => {
      ledger.proofs[route.id] = proof;
      await persist();
    },
    probeBackend: readiness,
    probeNode: (route) =>
      probeNodeEndpoint(route.backend.address, nodePort, route.public.transport, 2000),
  });
  const routes = ledger.routes.map((route) => ({
    ...route,
    revision: phase === 'online' ? 1 : phase === 'sleeping' ? 2 : 3,
    mode: phase === 'sleeping' ? ('sleeping' as const) : ('online' as const),
  }));
  let revision = routes[0]?.revision ?? 1;
  let selected = routes;
  const snapshot = (): GatewaySnapshot => ({
    gatewayId: ledger.gatewayId,
    revision,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + supportedPolicy.maximumLeaseMs).toISOString(),
    routes: selected,
  });
  let wakeCalls = 0;
  const protocol: GatewayProtocolAdapter = {
    id: 'm3-fixture',
    supports: (route) => route.protocol?.handlerId === 'm3-fixture',
    classify: (bytes) => ({
      kind:
        Buffer.from(bytes).toString() === 'STATUS\n'
          ? 'status'
          : Buffer.from(bytes).toString() === 'JOIN\n'
            ? 'join'
            : 'ignore',
    }),
    response: (_context, mode) => Buffer.from(`${mode}\n`),
    probeReadiness: async ({ route }) => ({ ready: await readiness(route) }),
  };
  const create = () =>
    createGatewayDataPlane({
      gatewayId: ledger.gatewayId,
      safety,
      protocols: [protocol],
      control: {
        fetchSnapshot: async () => snapshot(),
        requestWake: async () => {
          wakeCalls++;
          return { mode: 'blocked' };
        },
        reportObservation: async () => {},
      },
      policy: {
        maximumLeaseMs: supportedPolicy.maximumLeaseMs,
        maxClockSkewMs: 1000,
        pollIntervalMs: 10000,
        observationIntervalMs: 30000,
        probeTimeoutMs: supportedPolicy.probeTimeoutMs,
        tcpConnectTimeoutMs: 2000,
        tcpIdleTimeoutMs: 10000,
        classificationTimeoutMs: 1000,
        maxClassificationBytes: 1024,
        maxProtocolResponseBytes: 1024,
        maxTcpConnections: 100,
        maxUdpSessions: 100,
        udpIdleTimeoutMs: 1000,
        maxUdpQueuedBytes: 65536,
        wakeRetryMs: 5000,
        gracefulShutdownMs: 100,
      },
    });
  const checks: string[] = [];
  let gateway = create();
  closeGateway = () => gateway.stop();
  let began = performance.now();
  await gateway.start();
  timingMs.initialStart = Math.round(performance.now() - began);
  console.log(
    JSON.stringify({
      phase,
      stage: 'initial-start',
      elapsedMs: timingMs.initialStart,
      routes: gateway.health().routes,
      policy: supportedPolicy,
    }),
  );
  assert.equal(gateway.health().routes, 4);
  checks.push('real-observer-provider-inventory-prebind');
  scenario = 'forwarding';
  if (phase === 'sleeping') {
    for (const route of routes)
      assert.equal(
        (
          await exchange(bind, route.public.port, route.public.transport, Buffer.from('STATUS\n'))
        ).toString(),
        'sleeping\n',
      );
    assert.equal(wakeCalls, 0);
    checks.push(
      'passive-status-no-wake',
      'persisted-proof-stopped-container-same-address-node-challenge',
    );
  } else {
    await Promise.all(
      routes.flatMap((route) =>
        Array.from({ length: 8 }, async () => {
          const bytes = randomBytes(route.public.transport === 'tcp' ? 256 * 1024 : 4096);
          assert.deepEqual(
            await exchange(bind, route.public.port, route.public.transport, bytes),
            bytes,
          );
        }),
      ),
    );
    checks.push(
      'same-number-distinct-address-tcp-udp',
      'multiport',
      '32-concurrent-binary-clients',
    );
  }
  scenario = 'four-route-renewal';
  began = performance.now();
  await gateway.refresh();
  timingMs.fourRouteRenewal = Math.round(performance.now() - began);
  console.log(
    JSON.stringify({
      phase,
      stage: 'four-route-renewal',
      elapsedMs: timingMs.fourRouteRenewal,
      routes: gateway.health().routes,
      policy: supportedPolicy,
    }),
  );
  assert.equal(gateway.health().routes, 4);
  checks.push('four-route-lease-renewal');
  scenario = 'restart';
  await gateway.stop();
  gateway = create();
  began = performance.now();
  await gateway.start();
  timingMs.restart = Math.round(performance.now() - began);
  console.log(
    JSON.stringify({
      phase,
      stage: 'gateway-restart',
      elapsedMs: timingMs.restart,
      routes: gateway.health().routes,
      policy: supportedPolicy,
    }),
  );
  assert.equal(gateway.health().routes, 4);
  checks.push('gateway-process-state-restart');
  scenario = 'reconciliation';
  selected = routes.slice(0, 2);
  revision++;
  began = performance.now();
  await gateway.refresh();
  timingMs.reconciliation = Math.round(performance.now() - began);
  assert.equal(gateway.health().routes, 2);
  checks.push('route-removal-reconciliation');
  const stale = snapshot();
  stale.revision = revision - 1;
  await assert.rejects(gateway.applySnapshot(stale));
  checks.push('stale-snapshot-rejected');
  await gateway.stop();
  closeGateway = undefined;
  ledger.results.push({
    phase: phase as string,
    completedAt: new Date().toISOString(),
    checks,
    directInventoryCount: inventory.reduce((sum, row) => sum + row.allocations.length, 0),
    independentProductionNamespaceProof: false,
    timingMs,
    policy: supportedPolicy,
  });
  await persist();
  console.log(
    JSON.stringify({
      phase,
      passed: true,
      checks,
      directInventoryCount: ledger.results.at(-1)?.directInventoryCount,
      fixtureUuid,
      provenanceLedger: `mountdata/test-assets/m3-network-${fixtureUuid}.json`,
      infrastructureMutations: 0,
      independentProductionNamespaceProof: false,
      timingMs,
      policy: supportedPolicy,
    }),
  );
}
try {
  await main();
} catch {
  console.error(
    JSON.stringify({
      passed: false,
      scenario,
      timingMs,
      message:
        'Fixture assertion or safe prerequisite failed; preserve ledger and inspect before continuing.',
    }),
  );
  process.exitCode = 1;
} finally {
  await closeGateway?.();
  if (lockPath) await unlink(lockPath);
}
