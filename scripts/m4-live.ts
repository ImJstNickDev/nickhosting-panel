/** Reviewed live-test building blocks. No phase creates a server or bypasses
 * Core's M2/M3 lifecycle/admission. See docs/M4-LIVE-TESTS.md before execution. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, rename, statfs } from 'node:fs/promises';
import { cpus } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { probeNodeEndpoint, startNodeProbe } from '../apps/game-gateway/src/node-probe.js';
import { probeMinecraftStatus } from '../games/minecraft/src/protocol.js';
import { fetchMinecraftProtocols } from '../games/minecraft/src/releases.js';
import {
  createRuntimeMetadataClient,
  type MinecraftRuntimeRequest,
  resolveMinecraftRuntime,
} from '../games/minecraft/src/runtime.js';
import { type GatewayRoute, gatewayRouteSchema } from '../packages/game-sdk/src/index.js';
import {
  endpointsOverlap,
  gatewayNetworkPolicySchema,
} from '../packages/gateway-safety/src/index.js';
import {
  createNetworkObserver,
  createPterodactylAdapter,
  type PterodactylAdapter,
} from '../packages/pterodactyl-adapter/src/index.js';
import { backendAllocationPoolSchema } from '../packages/server-management/src/allocation-pool.js';

export interface MinecraftLivePlan {
  version: 1;
  pr: number;
  credentialsFile: string;
  expectedApiIdentitySha256: string;
  expectedApiAccountId: number;
  nodeId: number;
  nodeUuid: string;
  diskPath: string;
  observer: {
    dockerSocket: string;
    hostProcDirectory: string;
    expectedHostNamespaceId: string;
    expectedDockerDaemonId: string;
  };
  networkPolicy: unknown;
  backendAllocationPool: unknown;
  gatewayAddress: string;
  nodeProbe: { address: string; port: number };
  limits: {
    memoryMiB: number;
    cpuPercent: number;
    diskMiB: number;
    maxConcurrentServers: 1;
    memoryHeadroomMiB: number;
    diskHeadroomMiB: number;
  };
  profiles: {
    request: MinecraftRuntimeRequest;
    nestId: number;
    eggId: number;
    image: string;
    javaMajor: number;
  }[];
  metadataUserAgent: string;
  /** Independently inspected Wings ingress backing filesystem; isolated test DB only. */
  uploadPolicy?: unknown;
  approval: {
    endpoints: boolean;
    eula: boolean;
    reference: string | null;
    externalExposureAcknowledged: boolean;
  };
}
export interface MinecraftLiveAsset {
  managedServerId: string;
  externalId: string;
  profile: MinecraftRuntimeRequest['profile'];
  requestedAt: string;
  attemptedAt?: string;
  id?: number;
  uuid?: string;
  identifier?: string;
  createdAt?: string;
  deletedAt?: string;
  /** A real Core-minted route, not synthetic compatibility evidence. */
  route?: GatewayRoute;
}
export interface MinecraftLiveLedger {
  version: 1;
  runId: string;
  pr: number;
  branch: string;
  head: string;
  planSha256: string;
  apiIdentitySha256: string;
  apiAccountId: number;
  apiOriginSha256: string;
  createdAt: string;
  existingServerUuids: string[];
  assets: MinecraftLiveAsset[];
  events: { at: string; event: string; assetId?: string; details?: Record<string, unknown> }[];
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function requireIgnored(path: string) {
  execFileSync('git', ['check-ignore', '--quiet', '--', path], { stdio: 'pipe' });
}
function assertPlan(plan: MinecraftLivePlan) {
  assert.equal(plan.version, 1);
  assert(Number.isInteger(plan.pr) && plan.pr > 0);
  assert.match(plan.expectedApiIdentitySha256, /^[a-f0-9]{64}$/);
  assert(Number.isInteger(plan.expectedApiAccountId) && plan.expectedApiAccountId > 0);
  assert.equal(
    plan.gatewayAddress,
    '127.0.0.1',
    'Only exact local fixture Gateway binds are proposed',
  );
  const pool = backendAllocationPoolSchema.parse(plan.backendAllocationPool);
  assert.equal(pool.allocations.length, 1);
  assert.deepEqual(pool.gatewayBindAddresses, [plan.gatewayAddress]);
  const pin = pool.allocations[0];
  assert(pin);
  assert.equal(plan.nodeProbe.address, pin.backendAddress ?? pin.address);
  assert(
    Number.isInteger(plan.nodeProbe.port) &&
      plan.nodeProbe.port >= 49152 &&
      plan.nodeProbe.port <= 65535,
  );
  assert.notEqual(plan.nodeProbe.port, pin.port);
  assert.equal(plan.limits.maxConcurrentServers, 1);
  for (const [value, maximum] of [
    [plan.limits.memoryMiB, 2048],
    [plan.limits.cpuPercent, 100],
    [plan.limits.diskMiB, 4096],
  ])
    assert(
      value !== undefined &&
        maximum !== undefined &&
        Number.isInteger(value) &&
        value > 0 &&
        value <= maximum,
    );
  assert(plan.limits.memoryHeadroomMiB >= 12288 && plan.limits.diskHeadroomMiB >= 16384);
  assert.equal(plan.profiles.length, 5);
  assert.equal(new Set(plan.profiles.map((profile) => profile.request.profile)).size, 5);
  gatewayNetworkPolicySchema.parse(plan.networkPolicy);
  requireIgnored(plan.credentialsFile);
}
export async function readMinecraftLivePlan(path: string) {
  requireIgnored(path);
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0);
  const raw = await readFile(path, 'utf8');
  const plan = JSON.parse(raw) as MinecraftLivePlan;
  assertPlan(plan);
  return { plan, planSha256: hash(raw) };
}
async function api(plan: MinecraftLivePlan) {
  const secrets = parseEnv(await readFile(plan.credentialsFile, 'utf8'));
  assert(
    secrets.NH_PTERODACTYL_BASE_URL &&
      secrets.NH_PTERODACTYL_APPLICATION_KEY &&
      secrets.NH_PTERODACTYL_CLIENT_KEY,
  );
  const adapter = createPterodactylAdapter({
    baseURL: secrets.NH_PTERODACTYL_BASE_URL,
    applicationKey: secrets.NH_PTERODACTYL_APPLICATION_KEY,
    clientKey: secrets.NH_PTERODACTYL_CLIENT_KEY,
    timeoutMs: 10000,
  });
  const account = await adapter.getAccount();
  assert.equal(account.id, plan.expectedApiAccountId);
  assert.equal(hash(JSON.stringify(account)), plan.expectedApiIdentitySha256);
  return { adapter, originHash: hash(new URL(secrets.NH_PTERODACTYL_BASE_URL).origin) };
}
/** Real available capacity, not the sum of configured stopped-server limits. */
async function resourcePreflight(plan: MinecraftLivePlan) {
  const mem = /^MemAvailable:\s+(\d+) kB$/m.exec(await readFile('/proc/meminfo', 'utf8'));
  assert(mem?.[1]);
  const availableMiB = Math.floor(Number(mem[1]) / 1024);
  // 2x guest RAM conservatively covers Wings overhead and Java/installer work.
  assert(
    availableMiB >= plan.limits.memoryHeadroomMiB + 2 * plan.limits.memoryMiB,
    'Memory headroom unavailable',
  );
  const disk = await statfs(plan.diskPath, { bigint: true });
  const diskMiB = Number((disk.bavail * disk.bsize) / 1048576n);
  assert(
    diskMiB >= plan.limits.diskHeadroomMiB + 2 * plan.limits.diskMiB,
    'Disk headroom unavailable',
  );
  const before = cpus().map((cpu) => cpu.times);
  await new Promise((done) => setTimeout(done, 300));
  const after = cpus().map((cpu) => cpu.times);
  assert.equal(before.length, after.length);
  let idle = 0,
    total = 0;
  for (let index = 0; index < before.length; index++) {
    const a = before[index],
      b = after[index];
    assert(a && b);
    idle += b.idle - a.idle;
    total +=
      Object.values(b).reduce((sum, n) => sum + n, 0) -
      Object.values(a).reduce((sum, n) => sum + n, 0);
  }
  assert(
    total > 0 && (idle / total) * before.length >= 2,
    'Two logical CPUs of current idle headroom required',
  );
  return { availableMiB, availableDiskMiB: diskMiB };
}
/** This is read-only. Socket snapshots cannot reserve a port; every actual
 * listener must recheck immediately and retain the normal M3 safety validator. */
export async function preflightMinecraftLive(
  plan: MinecraftLivePlan,
  requireFreeAllocation = true,
  nodeProbeMayBeRunning = false,
) {
  assertPlan(plan);
  const { adapter, originHash } = await api(plan);
  const resources = await resourcePreflight(plan);
  const [nodes, observed] = await Promise.all([
    adapter.listNodes(),
    createNetworkObserver(plan.observer).observe(),
  ]);
  const node = nodes.find((row) => row.id === plan.nodeId);
  assert(node && node.uuid === plan.nodeUuid && !node.maintenance_mode);
  const policy = gatewayNetworkPolicySchema.parse(plan.networkPolicy);
  assert.equal(policy.nodes.find((row) => row.nodeId === plan.nodeId)?.nodeUuid, node.uuid);
  assert.equal(
    policy.nodes.length,
    nodes.length,
    'Every real provider node requires a network policy',
  );
  for (const item of nodes) {
    const declaration = policy.nodes.find(
      (entry) => entry.nodeId === item.id && entry.nodeUuid === item.uuid,
    );
    assert(declaration, 'Provider node identity changed');
    const network = observed.networks.find((entry) => entry.name === declaration.networkMode);
    assert(
      network && network.driver === 'bridge' && network.scope === 'local',
      'Unverified node bridge',
    );
    assert.equal(network.options['com.docker.network.bridge.gateway_mode_ipv4'] ?? 'nat', 'nat');
  }
  const inventory = [];
  for (const item of nodes)
    inventory.push({ node: item, allocations: await adapter.listAllocations(item.id) });
  const pool = backendAllocationPoolSchema.parse(plan.backendAllocationPool);
  const pin = pool.allocations[0];
  assert(pin);
  const allocation = inventory
    .find((row) => row.node.id === plan.nodeId)
    ?.allocations.find((row) => row.id === pin.allocationId);
  assert(allocation && allocation.ip === pin.address && allocation.port === pin.port);
  if (requireFreeAllocation)
    assert.equal(allocation.assigned, false, 'Selected allocation is no longer free');
  const backend = pin.backendAddress ?? pin.address;
  assert(observed.interfaceAddresses.includes(backend));
  assert(observed.interfaceAddresses.includes(plan.gatewayAddress));
  const endpoints = ['tcp', 'udp'].flatMap((transport) => [
    { address: plan.gatewayAddress, port: pin.port, transport: transport as 'tcp' | 'udp' },
    {
      address: plan.nodeProbe.address,
      port: plan.nodeProbe.port,
      transport: transport as 'tcp' | 'udp',
    },
    ...(requireFreeAllocation
      ? [{ address: backend, port: pin.port, transport: transport as 'tcp' | 'udp' }]
      : []),
  ]);
  for (const endpoint of endpoints) {
    for (const item of inventory)
      for (const other of item.allocations) {
        if (
          item.node.id === plan.nodeId &&
          other.id === pin.allocationId &&
          endpoint.port === pin.port &&
          endpoint.address === backend
        )
          continue;
        // Exact loopback remapping must be evidenced by policy, never guessed.
        const address =
          other.ip === '127.0.0.1'
            ? policy.nodes.find((n) => n.nodeId === item.node.id)?.loopbackRemap?.interfaceAddress
            : other.ip;
        assert(address, 'Unknown loopback mapping');
        assert(
          !endpointsOverlap(endpoint, { address, port: other.port, transport: endpoint.transport }),
          'Provider allocation collision',
        );
      }
    const isNodeProbe =
      endpoint.address === plan.nodeProbe.address && endpoint.port === plan.nodeProbe.port;
    if (
      nodeProbeMayBeRunning &&
      isNodeProbe &&
      observed.sockets.some((socket) => endpointsOverlap(endpoint, socket))
    ) {
      assert(
        await probeNodeEndpoint(endpoint.address, endpoint.port, endpoint.transport, 3000),
        'Existing approved node endpoint did not answer its nonce',
      );
      continue;
    }
    assert(
      !observed.sockets.some((socket) => endpointsOverlap(endpoint, socket)),
      'Host listener collision',
    );
    assert(
      !observed.containers.some((container) =>
        [...container.configuredBindings, ...container.activeBindings].some((binding) =>
          endpointsOverlap(endpoint, binding),
        ),
      ),
      'Docker publication collision',
    );
  }
  const metadata = createRuntimeMetadataClient({ userAgent: plan.metadataUserAgent });
  const protocols = await fetchMinecraftProtocols();
  const runtimes = [];
  for (const profile of plan.profiles) {
    const egg = await adapter.getEgg(profile.nestId, profile.eggId);
    assert.equal(egg.id, profile.eggId);
    assert.equal(egg.nest, profile.nestId);
    assert(
      Object.values(egg.docker_images ?? {}).includes(profile.image),
      'Requested runtime image not available on selected egg',
    );
    const runtime = await resolveMinecraftRuntime(profile.request, metadata);
    assert.equal(runtime.javaMajor, profile.javaMajor);
    const protocol = protocols.releases.get(runtime.release);
    assert(protocol && protocol.family === 'netty');
    runtimes.push({ runtime, protocol, eggId: egg.id });
  }
  return { adapter, originHash, resources, observed, inventory, runtimes };
}
function ledgerPath(path: string) {
  const value = resolve(path);
  assert.equal(dirname(value), resolve('mountdata/test-assets'));
  assert.match(basename(value), /^m4-live-[a-f0-9-]{36}\.json$/);
  requireIgnored(value);
  return value;
}
/** The journal is durable before a remote effect and after its confirmed result. */
export async function saveMinecraftLiveLedger(path: string, ledger: MinecraftLiveLedger) {
  const destination = ledgerPath(path);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(ledger, null, 2));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, destination);
  const directory = await open(dirname(destination), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function createMinecraftLiveLedger(plan: MinecraftLivePlan, planSha256: string) {
  assertPlan(plan);
  const { adapter, originHash } = await api(plan);
  for (const name of await readdir(resolve('mountdata/test-assets'))) {
    if (!/^m4-live-[a-f0-9-]{36}\.json$/.test(name)) continue;
    const previous = JSON.parse(
      await readFile(resolve('mountdata/test-assets', name), 'utf8'),
    ) as MinecraftLiveLedger;
    assert(
      previous.assets.every((asset) => asset.deletedAt),
      'Previous M4 assets require scoped recovery first',
    );
  }
  const runId = randomUUID();
  const ledger: MinecraftLiveLedger = {
    version: 1,
    runId,
    pr: plan.pr,
    branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    planSha256,
    apiIdentitySha256: plan.expectedApiIdentitySha256,
    apiAccountId: plan.expectedApiAccountId,
    apiOriginSha256: originHash,
    createdAt: new Date().toISOString(),
    existingServerUuids: (await adapter.listApplicationServers()).map((server) => server.uuid),
    assets: [],
    events: [],
  };
  assert.equal(ledger.branch, 'milestone/m4-minecraft');
  const path = resolve('mountdata/test-assets', `m4-live-${runId}.json`);
  await saveMinecraftLiveLedger(path, ledger);
  return { ledger, path };
}
export async function proveMinecraftLiveAsset(
  adapter: PterodactylAdapter,
  plan: MinecraftLivePlan,
  ledger: MinecraftLiveLedger,
  asset: MinecraftLiveAsset,
) {
  assert(
    asset.id &&
      asset.uuid &&
      asset.identifier &&
      asset.createdAt &&
      asset.attemptedAt &&
      !asset.deletedAt,
    'Complete durable creation provenance required',
  );
  assert(
    !ledger.existingServerUuids.includes(asset.uuid),
    'Pre-existing server cannot be a test asset',
  );
  assert.equal(ledger.apiIdentitySha256, plan.expectedApiIdentitySha256);
  assert.equal(ledger.apiAccountId, plan.expectedApiAccountId);
  const identity = await adapter.getAccount();
  assert.equal(hash(JSON.stringify(identity)), ledger.apiIdentitySha256);
  const remote = await adapter.getApplicationServer(asset.id);
  assert.equal(remote.uuid, asset.uuid);
  assert.equal(remote.identifier, asset.identifier);
  assert.equal(remote.external_id, asset.externalId);
  assert.equal(remote.created_at, asset.createdAt);
  assert.equal(remote.node, plan.nodeId);
  assert.equal(remote.user, plan.expectedApiAccountId);
  const profile = plan.profiles.find((entry) => entry.request.profile === asset.profile);
  assert(profile && remote.egg === profile.eggId && remote.nest === profile.nestId);
  assert.equal(remote.container.image, profile.image);
  assert.equal(
    remote.allocation,
    backendAllocationPoolSchema.parse(plan.backendAllocationPool).allocations[0]?.allocationId,
  );
  assert(remote.limits.memory > 0 && remote.limits.memory <= plan.limits.memoryMiB);
  assert(remote.limits.cpu > 0 && remote.limits.cpu <= plan.limits.cpuPercent);
  assert(remote.limits.disk > 0 && remote.limits.disk <= plan.limits.diskMiB);
  assert.equal(remote.limits.swap, 0);
  assert.equal(remote.limits.io, 500);
  assert.deepEqual(remote.feature_limits, { databases: 0, allocations: 1, backups: 1 });
  return remote;
}
/** Compose this guard into the existing Core runtime; it does not implement a
 * second provision/start/job path. Uncertain creation never replays automatically. */
export function guardMinecraftLiveAdapter(
  raw: PterodactylAdapter,
  plan: MinecraftLivePlan,
  ledger: MinecraftLiveLedger,
  path: string,
): PterodactylAdapter {
  assert(
    plan.approval.endpoints &&
      plan.approval.eula &&
      plan.approval.externalExposureAcknowledged &&
      plan.approval.reference,
  );
  const mutations = new Set([
    'stopWithConfirmation',
    'reinstallWithConfirmation',
    'reinstallApplication',
    'updateDetails',
    'updateBuild',
    'updateStartup',
    'power',
    'reinstall',
    'deleteServer',
    'sendCommand',
    'writeFile',
    'deleteFiles',
    'createDirectory',
    'renameFiles',
    'createBackup',
    'deleteBackup',
    'restoreBackup',
    'uploadFile',
  ]);
  const reads = new Set([
    'getAccount',
    'listNodes',
    'getNode',
    'listNests',
    'listEggs',
    'getEgg',
    'listAllocations',
    'listUsers',
    'listApplicationServers',
    'getApplicationServer',
    'findServerByExternalId',
    'getClientServer',
    'listClientServers',
    'getClientPermissions',
    'getResources',
    'confirmInstallation',
    'listFiles',
    'readFile',
    'listBackups',
    'listBackupActivity',
    'getBackup',
    'downloadBackup',
    'downloadFile',
    'discoverCapabilities',
  ]);
  return new Proxy(raw, {
    get(target, key, receiver) {
      if (key === 'relayConsole')
        return async (
          identifier: string,
          input: Parameters<PterodactylAdapter['relayConsole']>[1],
        ) => {
          const asset = ledger.assets.find((row) => row.identifier === identifier);
          assert(asset, 'No durable ownership record');
          return raw.relayConsole(identifier, {
            ...input,
            authorize: async () => {
              try {
                await proveMinecraftLiveAsset(raw, plan, ledger, asset);
                return input.authorize();
              } catch {
                return false;
              }
            },
          });
        };
      if (key === 'createServer')
        return async (input: Parameters<PterodactylAdapter['createServer']>[0]) => {
          const asset = ledger.assets.find((row) => row.externalId === input.externalId);
          assert(
            asset &&
              !asset.attemptedAt &&
              !asset.uuid &&
              ledger.assets.filter((row) => !row.deletedAt).length === 1,
          );
          assert.equal(await raw.findServerByExternalId(asset.externalId), null);
          const profile = plan.profiles.find((row) => row.request.profile === asset.profile);
          assert(profile && input.eggId === profile.eggId && input.dockerImage === profile.image);
          assert.equal(input.userId, plan.expectedApiAccountId);
          assert.equal(input.limits.memory, plan.limits.memoryMiB);
          assert.equal(input.limits.cpu, plan.limits.cpuPercent);
          assert.equal(input.limits.disk, plan.limits.diskMiB);
          assert.equal(input.limits.swap, 0);
          assert.equal(input.limits.io, 500);
          assert.deepEqual(input.featureLimits, { databases: 0, allocations: 1, backups: 1 });
          assert.equal(
            input.allocation.default,
            backendAllocationPoolSchema.parse(plan.backendAllocationPool).allocations[0]
              ?.allocationId,
          );
          assert.equal(input.allocation.additional?.length ?? 0, 0);
          await preflightMinecraftLive(plan, true, true);
          assert(!asset.attemptedAt && !asset.uuid, 'Concurrent or repeated creation intent');
          asset.attemptedAt = new Date().toISOString();
          ledger.events.push({
            at: asset.attemptedAt,
            event: 'creation.attempted',
            assetId: asset.managedServerId,
          });
          await saveMinecraftLiveLedger(path, ledger);
          const remote = await target.createServer(input);
          assert.equal(remote.external_id, asset.externalId);
          assert(!ledger.existingServerUuids.includes(remote.uuid));
          Object.assign(asset, {
            id: remote.id,
            uuid: remote.uuid,
            identifier: remote.identifier,
            createdAt: remote.created_at,
          });
          await saveMinecraftLiveLedger(path, ledger);
          await proveMinecraftLiveAsset(raw, plan, ledger, asset);
          return remote;
        };
      const value = Reflect.get(target, key, receiver);
      if (typeof key === 'string' && mutations.has(key))
        return async (...args: unknown[]) => {
          const asset = ledger.assets.find(
            (row) => row.id === args[0] || row.identifier === args[0],
          );
          assert(asset, 'No durable ownership record');
          await proveMinecraftLiveAsset(raw, plan, ledger, asset);
          if (key === 'updateDetails') {
            const input = args[1] as Parameters<PterodactylAdapter['updateDetails']>[1];
            assert.equal(input.user, plan.expectedApiAccountId);
            assert.equal(input.external_id, asset.externalId);
          }
          if (key === 'updateStartup') {
            const input = args[1] as Parameters<PterodactylAdapter['updateStartup']>[1];
            const profile = plan.profiles.find((row) => row.request.profile === asset.profile);
            assert(profile && input.egg === profile.eggId && input.image === profile.image);
          }
          if (key === 'updateBuild') {
            const input = args[1] as Parameters<PterodactylAdapter['updateBuild']>[1];
            assert(
              Number.isSafeInteger(input.memory) &&
                input.memory > 0 &&
                input.memory <= plan.limits.memoryMiB &&
                Number.isFinite(input.cpu) &&
                input.cpu > 0 &&
                input.cpu <= plan.limits.cpuPercent &&
                Number.isSafeInteger(input.disk) &&
                input.disk > 0 &&
                input.disk <= plan.limits.diskMiB,
            );
            assert.equal(input.swap, 0);
            assert.equal(input.io, 500);
            assert.deepEqual(input.feature_limits, { databases: 0, allocations: 1, backups: 1 });
            assert.equal(
              input.allocation,
              backendAllocationPoolSchema.parse(plan.backendAllocationPool).allocations[0]
                ?.allocationId,
            );
            assert.equal(input.add_allocations?.length ?? 0, 0);
            assert.equal(input.remove_allocations?.length ?? 0, 0);
          }
          if (key === 'stopWithConfirmation' || key === 'reinstallWithConfirmation') {
            const input = args[2] as Parameters<PterodactylAdapter['stopWithConfirmation']>[2];
            args[2] = {
              ...input,
              authorize: async () => {
                await proveMinecraftLiveAsset(raw, plan, ledger, asset);
                return input.authorize();
              },
              beforePower: async () => {
                await proveMinecraftLiveAsset(raw, plan, ledger, asset);
                await input.beforePower?.();
              },
            };
          }
          if (
            ['power', 'reinstall', 'reinstallApplication', 'reinstallWithConfirmation'].includes(
              key,
            ) &&
            !(key === 'power' && ['stop', 'kill'].includes(String(args[1])))
          )
            await resourcePreflight(plan);
          ledger.events.push({
            at: new Date().toISOString(),
            event: `mutation.${key}.attempted`,
            assetId: asset.managedServerId,
          });
          await saveMinecraftLiveLedger(path, ledger);
          const result = await Reflect.apply(value, target, args);
          if (key === 'deleteServer') {
            assert.equal(await raw.findServerByExternalId(asset.externalId), null);
            asset.deletedAt = new Date().toISOString();
          }
          ledger.events.push({
            at: new Date().toISOString(),
            event: `mutation.${key}.returned`,
            assetId: asset.managedServerId,
          });
          await saveMinecraftLiveLedger(path, ledger);
          return result;
        };
      if (typeof value === 'function')
        assert(typeof key === 'string' && reads.has(key), 'Unreviewed adapter operation');
      return value;
    },
  });
}
async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const phase = option('--phase'),
    path = option('--plan');
  assert(path && ['preflight', 'responder', 'prove', 'probe'].includes(phase ?? ''));
  const { plan, planSha256 } = await readMinecraftLivePlan(path);
  if (phase === 'preflight') {
    const checked = await preflightMinecraftLive(plan);
    console.log(
      JSON.stringify({
        phase,
        result: 'passed-read-only',
        allocations: checked.inventory.reduce((sum, row) => sum + row.allocations.length, 0),
        profilesResolved: checked.runtimes.length,
        ...checked.resources,
        liveCompatibilityVerified: false,
      }),
    );
    return;
  }
  assert(
    args.includes('--owner-approved') &&
      plan.approval.endpoints &&
      plan.approval.externalExposureAcknowledged &&
      plan.approval.reference,
    'Exact endpoint approval required',
  );
  if (phase === 'responder') {
    await preflightMinecraftLive(plan);
    const opened: Awaited<ReturnType<typeof startNodeProbe>>[] = [];
    try {
      for (const transport of ['tcp', 'udp'] as const)
        opened.push(
          await startNodeProbe({
            ...plan.nodeProbe,
            transport,
            maxConnections: 16,
            timeoutMs: 1000,
          }),
        );
      for (const transport of ['tcp', 'udp'] as const)
        assert(
          await probeNodeEndpoint(plan.nodeProbe.address, plan.nodeProbe.port, transport, 3000),
        );
      console.log(
        JSON.stringify({ phase, result: 'nonce-responder-ready', pid: process.pid, planSha256 }),
      );
      await new Promise<void>((done) => {
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
    } finally {
      for (const responder of opened.reverse()) await responder.close();
    }
    return;
  }
  const ledgerFile = option('--ledger');
  assert(ledgerFile);
  const ledger = JSON.parse(await readFile(ledgerPath(ledgerFile), 'utf8')) as MinecraftLiveLedger;
  assert.equal(ledger.version, 1);
  assert.equal(ledger.pr, plan.pr);
  assert.equal(ledger.planSha256, planSha256);
  const { adapter, originHash } = await api(plan);
  assert.equal(ledger.apiOriginSha256, originHash);
  const active = ledger.assets.filter((asset) => !asset.deletedAt);
  assert.equal(active.length, 1);
  const asset = active[0];
  assert(asset);
  await proveMinecraftLiveAsset(adapter, plan, ledger, asset);
  if (phase === 'probe') {
    assert(plan.approval.eula, 'Owner EULA acceptance required');
    const route = gatewayRouteSchema.parse(asset.route);
    assert.equal(route.serverId, asset.managedServerId);
    const pin = backendAllocationPoolSchema.parse(plan.backendAllocationPool).allocations[0];
    assert(
      pin &&
        route.backend.address === (pin.backendAddress ?? pin.address) &&
        route.backend.port === pin.port,
    );
    assert.equal(route.public.address, plan.gatewayAddress);
    assert.equal(route.public.port, pin.port);
    const version = (await fetchMinecraftProtocols()).releases.get(
      route.protocol?.gameVersion ?? '',
    );
    assert(version);
    const result = await probeMinecraftStatus(
      { route, signal: AbortSignal.timeout(5000) },
      version,
    );
    assert(result.ready, 'Minecraft status/ping readiness not proven');
    ledger.events.push({
      at: new Date().toISOString(),
      event: 'real-server.status-ping',
      assetId: asset.managedServerId,
      details: {
        ready: result.ready,
        playerCount: result.playerCount ?? null,
        authenticatedClientVerified: false,
      },
    });
    await saveMinecraftLiveLedger(ledgerFile, ledger);
  }
  console.log(JSON.stringify({ phase, result: 'passed', fullCompatibilityVerified: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Provider bodies, account metadata, addresses and credentials stay private.
    console.error(
      JSON.stringify({
        result: 'failed-closed',
        action: 'Preserve private ledger and request coordinator review; no automatic cleanup.',
      }),
    );
    process.exitCode = 1;
  });
}
