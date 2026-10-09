/** Explicitly authorized M2 fixtures only. Never discovers targets for mutation by name. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { type AuthContext, DomainError, SecretCodec } from '../packages/core/src/index.js';
import { createDatabase, migrate } from '../packages/database/src/index.js';
import { createTestDatabase } from '../packages/database/src/testing.js';
import type { GameManifest } from '../packages/game-sdk/src/index.js';
import {
  createContainerObserver,
  createPterodactylAdapter,
  type PterodactylAdapter,
} from '../packages/pterodactyl-adapter/src/index.js';
import {
  createManagedServer,
  createManagementRuntime,
  enqueueServerOperation,
  processServerOperation,
  setManagedNode,
  setPhysicalHost,
  setRuntimeMapping,
  setUserLimits,
  verifyManagedIdentity,
} from '../packages/server-management/src/index.js';

if (!process.argv.includes('--owner-authorized'))
  throw new Error('Explicit Owner authorization required');
const planPath = process.argv[2];
if (!planPath || planPath.startsWith('--'))
  throw new Error('Pass the reviewed ignored fixture plan');
interface Plan {
  nodeId: number;
  nestId: number;
  eggId: number;
  provisionUserId: number;
  dockerImage: string;
  startup: string;
  environment: Record<string, string>;
  diskPath: string;
  dockerObserverSocket: string;
  memoryOverheadPercent: number;
  fixtureWingsMemoryMultiplier: number;
  count: number;
  memoryMiB: number;
  cpuPercent: number;
  diskMiB: number;
}
const plan: Plan = JSON.parse(readFileSync(planPath, 'utf8'));
function defined<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
async function installerPreflight() {
  const before = cpus().map((cpu) => cpu.times);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const after = cpus().map((cpu) => cpu.times);
  let idle = 0,
    total = 0;
  for (let i = 0; i < before.length; i++) {
    const a = defined(before[i]),
      b = defined(after[i]);
    idle += b.idle - a.idle;
    total +=
      Object.values(b).reduce((x, y) => x + y, 0) - Object.values(a).reduce((x, y) => x + y, 0);
  }
  assert.ok(
    total > 0 && (idle / total) * before.length >= 2,
    'Insufficient installation CPU headroom',
  );
  const memory = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m);
  assert.ok(
    memory?.[1] && Number(memory[1]) / 1024 > 12288,
    'Insufficient installation memory headroom',
  );
  const disk = statfsSync(plan.diskPath);
  assert.ok(
    (disk.bavail * disk.bsize) / 1048576 > 16384,
    'Insufficient installation disk headroom',
  );
}

assert.ok(
  Number.isInteger(plan.memoryOverheadPercent) &&
    plan.memoryOverheadPercent >= 100 &&
    plan.memoryOverheadPercent <= 400,
);
assert.ok(
  plan.fixtureWingsMemoryMultiplier >= 1 &&
    plan.fixtureWingsMemoryMultiplier <= plan.memoryOverheadPercent / 100,
);
assert.equal(plan.count, 4);
assert.equal(plan.memoryMiB, 256);
assert.equal(plan.cpuPercent, 10);
assert.equal(plan.diskMiB, 256);
assert.equal(plan.startup, 'sh ./m2-fixture.sh NH_M2_READY');
const fixtureScript = [
  '#!/bin/sh',
  'echo "Listening on M2 isolated fixture"',
  'echo NH_M2_READY',
  'while IFS= read -r line; do',
  '  case "$line" in end|stop) exit 0;; *) echo "$line";; esac',
  'done',
  '',
].join('\n');
const ledgerDirectory = resolve('mountdata/test-assets');
mkdirSync(ledgerDirectory, { recursive: true });
const resumeIndex = process.argv.indexOf('--resume-ledger');
const resumePath = resumeIndex < 0 ? undefined : resolve(defined(process.argv[resumeIndex + 1]));
if (resumePath)
  assert.ok(
    resumePath.startsWith(`${ledgerDirectory}/m2-live-`) &&
      /^m2-live-[a-f0-9-]{36}\.json$/.test(resumePath.slice(ledgerDirectory.length + 1)),
  );
const resumed = resumePath ? JSON.parse(readFileSync(resumePath, 'utf8')) : undefined;
for (const name of readdirSync(ledgerDirectory).filter((n) => /^m2-live-.*\.json$/.test(n))) {
  if (resolve(ledgerDirectory, name) === resumePath) continue;
  const existing = JSON.parse(readFileSync(resolve(ledgerDirectory, name), 'utf8'));
  if (existing.assets?.some((a: { deletedAt?: string }) => !a.deletedAt))
    throw new Error(
      'An earlier ledger has unresolved assets; stop and review it before another run',
    );
}
const run: string = resumed?.run ?? `m2-live-${randomUUID()}`;
assert.ok(/^m2-live-[a-f0-9-]{36}$/.test(run));
const ledgerPath = resolve(ledgerDirectory, `${run}.json`);
type Asset = {
  serverId: string;
  externalId: string;
  requestedAt: string;
  attemptedAt?: string;
  uuid?: string;
  id?: number;
  identifier?: string;
  createdAt?: string;
  verifiedAt?: string;
  deletedAt?: string;
};
const freshLedger = {
  run,
  pr: 17,
  startedAt: new Date().toISOString(),
  schema: '',
  apiIdentity: '',
  nodeId: plan.nodeId,
  provisionUserId: plan.provisionUserId,
  assets: [] as Asset[],
  checks: [] as string[],
  completedAt: '',
  failure: '',
  failureLocation: '',
};
const ledger: typeof freshLedger = resumed ?? freshLedger;
if (resumed) {
  assert.equal(ledger.pr, 17);
  assert.equal(ledger.run, run);
  assert.equal(ledger.nodeId, plan.nodeId);
  assert.equal(ledger.provisionUserId, plan.provisionUserId);
  assert.equal(ledger.assets.length, plan.count);
  for (const key of ['id', 'uuid', 'serverId', 'externalId'] as const)
    assert.equal(new Set(ledger.assets.map((asset) => asset[key])).size, plan.count);
  assert.ok(!ledger.completedAt);
  assert.equal(resumePath, ledgerPath);
  assert.ok(
    ledger.assets.every((a) => a.uuid && a.id && a.externalId && a.createdAt && !a.deletedAt),
  );
  ledger.checks.push(
    ledger.failure
      ? `Resuming quiescent fixture run after ${ledger.failure} at ${ledger.failureLocation}; prior evidence retained`
      : 'Resuming quiescent fixture run after verified diagnostic stop; prior evidence retained',
  );
}
function save() {
  const temp = `${ledgerPath}.tmp`;
  writeFileSync(temp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  const file = openSync(temp, 'r');
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temp, ledgerPath);
  const directory = openSync(ledgerDirectory, 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function evidence(check: string) {
  ledger.checks.push(check);
  save();
  console.log(JSON.stringify({ check }));
}
save();
const secrets = parseEnv(readFileSync('.env.m2.local', 'utf8'));
assert.ok(
  secrets.NH_PTERODACTYL_BASE_URL &&
    secrets.NH_PTERODACTYL_APPLICATION_KEY &&
    secrets.NH_PTERODACTYL_CLIENT_KEY,
);
const base = {
  baseURL: secrets.NH_PTERODACTYL_BASE_URL,
  applicationKey: secrets.NH_PTERODACTYL_APPLICATION_KEY,
  clientKey: secrets.NH_PTERODACTYL_CLIENT_KEY,
};
const discovery = createPterodactylAdapter(base);
const node = await discovery.getNode(plan.nodeId);
const httpOrigin = new URL(`${node.scheme}://${node.fqdn}:${node.daemon_listen}`).origin;
const wsOrigin = httpOrigin.replace(/^http/, 'ws');
const raw = createPterodactylAdapter({
  ...base,
  containerObserver: createContainerObserver(plan.dockerObserverSocket),
  webSocketOrigins: [wsOrigin],
  downloadOrigins: [httpOrigin],
});
const identity = await raw.getAccount();
assert.equal(identity.id, plan.provisionUserId);
const verifiedIdentity = `client-account:${identity.id}; provision-owner:${plan.provisionUserId}`;
if (resumed) assert.equal(ledger.apiIdentity, verifiedIdentity);
ledger.apiIdentity = verifiedIdentity;
save();
const before = (await raw.listApplicationServers()).filter(
  (remote) => !resumed || !ledger.assets.some((a) => a.uuid === remote.uuid),
);
const untouched = new Map(
  before.map((s) => [
    s.uuid,
    JSON.stringify({
      id: s.id,
      uuid: s.uuid,
      external_id: s.external_id,
      node: s.node,
      allocation: s.allocation,
      limits: s.limits,
      feature_limits: s.feature_limits,
      user: s.user,
      egg: s.egg,
      container: s.container,
      updated_at: s.updated_at,
    }),
  ]),
);
async function resumeDatabase() {
  assert.match(ledger.schema, /^nh_test_[a-f0-9]{32}$/);
  const url = new URL(defined(process.env.NH_TEST_DATABASE_URL));
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]', process.env.NH_TEST_VERIFIED_DATABASE_HOST].includes(
      url.hostname,
    ),
  );
  assert.equal(url.username, 'nickhosting_test');
  assert.equal(url.pathname, '/nickhosting_test');
  const instance = createDatabase(url.toString(), {
    options: `-c search_path=${ledger.schema}`,
    max: 15,
  });
  const owned = await instance.db
    .selectFrom('managed_servers')
    .select(['id', 'pterodactyl_id', 'pterodactyl_uuid', 'external_id', 'active_operation_id'])
    .execute();
  assert.equal(owned.length, ledger.assets.length);
  for (const asset of ledger.assets) {
    const row = defined(owned.find((entry) => entry.id === asset.serverId));
    assert.equal(row.pterodactyl_id, asset.id);
    assert.equal(row.pterodactyl_uuid, asset.uuid);
    assert.equal(row.external_id, asset.externalId);
    assert.equal(row.active_operation_id, null);
  }
  assert.equal(
    (await instance.db.selectFrom('resource_reservations').select('server_id').execute()).length,
    0,
  );
  assert.equal(
    (await instance.db.selectFrom('installation_reservations').select('server_id').execute())
      .length,
    0,
  );
  await migrate(instance.pool);
  return {
    ...instance,
    schema: ledger.schema,
    async destroy() {
      await instance.pool.query(`DROP SCHEMA "${ledger.schema}" CASCADE`);
      await instance.db.destroy();
    },
  };
}
const database = resumed ? await resumeDatabase() : await createTestDatabase();
ledger.schema = database.schema;
save();
const db = database.db;
const context: AuthContext = {
  actorUserId: run,
  subjectUserId: run,
  role: 'owner',
  sessionType: 'regular',
  ownerElevation: false,
};
function assetFor(value: string | number) {
  const asset = ledger.assets.find((a) => a.id === value || a.identifier === value);
  assert.ok(
    asset?.uuid && asset.id && asset.identifier && asset.createdAt,
    'No durable provenance: stop',
  );
  return asset;
}
async function prove(value: string | number) {
  const asset = assetFor(value);
  const remote = await raw.getApplicationServer(defined(asset.id));
  assert.equal(remote.uuid, asset.uuid);
  assert.equal(remote.identifier, asset.identifier);
  assert.equal(remote.external_id, asset.externalId);
  assert.equal(remote.created_at, asset.createdAt);
  assert.equal(remote.user, plan.provisionUserId);
  assert.equal(remote.node, plan.nodeId);
  assert.ok(!untouched.has(remote.uuid));
  const row = await db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', asset.serverId)
    .executeTakeFirstOrThrow();
  await verifyManagedIdentity(db, row, remote);
  asset.verifiedAt = new Date().toISOString();
  save();
  return remote;
}
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
]);
const adapter = new Proxy(raw, {
  get(target, key, receiver) {
    if (key === 'createServer')
      return async (input: Parameters<PterodactylAdapter['createServer']>[0]) => {
        const asset = ledger.assets.find((a) => a.externalId === input.externalId);
        assert.ok(
          asset && !asset.attemptedAt && !asset.uuid,
          'Creation intent missing or repeated',
        );
        assert.equal(await raw.findServerByExternalId(asset.externalId), null);
        const free = await raw.listAllocations(plan.nodeId);
        for (const id of [input.allocation.default, ...(input.allocation.additional ?? [])]) {
          const selected = free.find((a) => a.id === id && !a.assigned);
          assert.ok(selected);
          // A conservative live fixture avoids a port used by any direct server.
          assert.ok(!free.some((a) => a.assigned && a.port === selected.port));
        }
        assert.equal(input.limits.memory, 256);
        assert.equal(input.limits.disk, 256);
        assert.equal(input.limits.cpu, 10);
        asset.attemptedAt = new Date().toISOString();
        save();
        await installerPreflight();
        const remote = await target.createServer(input);
        assert.equal(remote.external_id, asset.externalId);
        assert.equal(remote.node, plan.nodeId);
        assert.equal(remote.user, plan.provisionUserId);
        assert.ok(!untouched.has(remote.uuid));
        Object.assign(asset, {
          id: remote.id,
          uuid: remote.uuid,
          identifier: remote.identifier,
          createdAt: remote.created_at,
          verifiedAt: new Date().toISOString(),
        });
        save();
        return remote;
      };
    const value = Reflect.get(target, key, receiver);
    if (typeof key === 'string' && mutations.has(key))
      return async (...args: unknown[]) => {
        await prove(args[0] as string | number);
        if (
          key === 'reinstall' ||
          key === 'reinstallApplication' ||
          key === 'reinstallWithConfirmation'
        )
          await installerPreflight();
        return Reflect.apply(value, target, args);
      };
    return value;
  },
});
async function verifyOwnedContainer(asset: Asset, running: boolean, memoryMiB?: number) {
  await prove(defined(asset.id));
  const result = spawnSync(
    'docker',
    [
      '--host',
      `unix://${plan.dockerObserverSocket}`,
      'inspect',
      '--format',
      '{{json .State.Running}} {{json .HostConfig.Memory}}',
      defined(asset.uuid),
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('DOCKER_')),
      ),
    },
  );
  assert.equal(result.status, 0, 'Owned container observation unavailable');
  const [state, memory] = result.stdout.trim().split(' ');
  assert.equal(state, String(running));
  if (memoryMiB !== undefined) {
    assert.equal(
      Number(memory),
      Math.round(memoryMiB * plan.fixtureWingsMemoryMultiplier * 1_000_000),
    );
    const reservation = await db
      .selectFrom('resource_reservations')
      .selectAll()
      .where('server_id', '=', asset.serverId)
      .executeTakeFirstOrThrow();
    assert.equal(reservation.memory_mib, memoryMiB);
    assert.ok(reservation.physical_memory_mib * 1048576 >= Number(memory));
    evidence(
      `physical limit verified: configured ${memoryMiB}, Docker ${Number(memory)} bytes, reserved ${reservation.physical_memory_mib} MiB`,
    );
  }
}
const env = {
  NH_OBSERVER_ID: run,
  NH_DOCKER_OBSERVER_SOCKET: plan.dockerObserverSocket,
  NH_DEFAULT_USER_MEMORY_MIB: '256',
  NH_DEFAULT_USER_CPU_PERCENT: '10',
};
const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
const runtime = await createManagementRuntime({ db, codec, env, adapter });
async function pump(jobId: string, timeoutMs = 480000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await processServerOperation(db, jobId, runtime.lifecycle);
    const row = await db
      .selectFrom('operation_jobs')
      .selectAll()
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    if (row.state === 'failed') throw new Error(`operation failed: ${row.error_code}`);
    if (row.state === 'succeeded') return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('Operation deadline exceeded; preserve ledger and request review');
}
async function operation(serverId: string, input: Record<string, unknown>) {
  await runtime.refreshObservations();
  const queued = await enqueueServerOperation(
    db,
    context,
    serverId,
    { idempotencyKey: randomUUID(), ...input },
    env,
  );
  await pump(queued.jobId);
  evidence(`${input.action}: confirmed`);
  return queued;
}
const limits = { memory: 256, cpu: 10, disk: 256, swap: 0, io: 500 };
try {
  if (!resumed) {
    await database.pool.query(
      'insert into "user"(id,name,email,role,"emailVerified") values($1,$2,$3,$4,true)',
      [run, 'Isolated M2 test', `${run}@example.test`, 'owner'],
    );
    const gameId = 'm2-fixture';
    const manifest: GameManifest = {
      id: gameId,
      version: '1.0.0',
      nameKey: 'games.m2-fixture.name',
      capabilities: {
        console: true,
        files: true,
        backups: true,
        players: false,
        mods: false,
        worlds: false,
        idleDetection: false,
        gracefulStop: false,
        readiness: false,
        wake: 'manual',
      },
      connection: {
        mode: 'static-host-port',
        hostnameSettingKey: 'staticGameHostname',
        showPort: true,
      },
      ports: [{ role: 'game', transport: 'both', required: true }],
      runtimes: [
        {
          id: 'fixture',
          nameKey: 'games.m2-fixture.runtime',
          supportedGameVersions: ['1'],
          supports: {},
        },
      ],
      wizard: { steps: [] },
      management: [],
      contentProviders: [],
      localizations: { namespace: 'games.m2-fixture', locales: ['en', 'it'] },
    };
    await db
      .insertInto('game_integrations')
      .values({ id: gameId, version: '1.0.0', manifest })
      .execute();
    await db
      .insertInto('game_rollouts')
      .values({ integration_id: gameId, state: 'public', allowlist: [] })
      .execute();
    const host = await setPhysicalHost(db, context, {
      name: 'M2 isolated fixture accounting',
      memoryLimitMiB: Math.floor(totalmem() / 1048576),
      cpuLimitPercent: cpus().length * 100,
      storagePoolMiB: 16384,
      memoryHeadroomMiB: 4096,
      cpuHeadroomPercent: 100,
      diskHeadroomMiB: 8192,
      localDiskPath: plan.diskPath,
      observerId: run,
    });
    const managedNode = await setManagedNode(db, adapter, context, {
      physicalHostId: host.id,
      pterodactylNodeId: plan.nodeId,
      provisionUserId: plan.provisionUserId,
      memoryOverheadPercent: plan.memoryOverheadPercent,
    });
    const mapping = await setRuntimeMapping(db, adapter, context, {
      gameId,
      runtimeId: 'fixture',
      nodeId: managedNode.id,
      nestId: plan.nestId,
      eggId: plan.eggId,
      dockerImage: plan.dockerImage,
      startup: plan.startup,
      environment: plan.environment,
      portRoles: [{ role: 'game', protocols: ['tcp', 'udp'], primary: true }],
      featureLimits: { databases: 0, allocations: 1, backups: 1 },
    });
    await setUserLimits(db, context, {
      userId: run,
      memoryMiB: 256,
      cpuPercent: 10,
      storageMiB: 8192,
      reason: 'Conservative approved M2 concurrency fixture',
    });
    for (let i = 0; i < plan.count; i++) {
      await runtime.refreshObservations();
      const created = await createManagedServer(
        db,
        adapter,
        context,
        {
          idempotencyKey: randomUUID(),
          mappingId: mapping.id,
          name: `Codex M2 ${run.slice(-8)} ${i + 1}`,
          limits,
          autoStart: false,
        },
        env,
      );
      const row = await db
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', created.serverId)
        .executeTakeFirstOrThrow();
      ledger.assets.push({
        serverId: created.serverId,
        externalId: row.external_id,
        requestedAt: new Date().toISOString(),
      });
      save();
      await pump(created.jobId);
      const remote = await prove(defined(defined(ledger.assets[i]).id));
      assert.equal((await adapter.getResources(remote.identifier)).current_state, 'offline');
      await adapter.writeFile(remote.identifier, 'm2-fixture.sh', fixtureScript);
      assert.equal(
        Buffer.from(await adapter.readFile(remote.identifier, 'm2-fixture.sh')).toString(),
        fixtureScript,
      );
      evidence(`provision ${i + 1}: installed and offline; fixture script verified`);
    }
  } else {
    for (const asset of ledger.assets) {
      const remote = await prove(defined(asset.id));
      for (const key of ['memory', 'cpu', 'disk', 'swap', 'io'] as const)
        assert.equal(remote.limits[key], limits[key]);
      const observer = createContainerObserver(plan.dockerObserverSocket);
      assert.equal(await observer.stopped(remote.uuid, 'server'), true);
      assert.equal(await observer.stopped(remote.uuid, 'installer'), true);
      assert.equal((await adapter.getResources(remote.identifier)).current_state, 'offline');
      assert.equal(
        Buffer.from(await adapter.readFile(remote.identifier, 'm2-fixture.sh')).toString(),
        fixtureScript,
      );
    }
    const existingNode = await db.selectFrom('managed_nodes').selectAll().executeTakeFirstOrThrow();
    await setManagedNode(db, adapter, context, {
      id: existingNode.id,
      physicalHostId: existingNode.physical_host_id,
      pterodactylNodeId: plan.nodeId,
      provisionUserId: plan.provisionUserId,
      memoryOverheadPercent: plan.memoryOverheadPercent,
    });
    ledger.failure = '';
    ledger.failureLocation = '';
    save();
    evidence(
      'resumed four ledger-proven quiescent fixtures after isolated migration and script read-back',
    );
  }
  assert.equal((await db.selectFrom('resource_reservations').selectAll().execute()).length, 0);
  const capacity = await adapter.getNode(plan.nodeId);
  assert.ok(capacity.allocated_resources && capacity.allocated_resources.memory > capacity.memory);
  evidence(
    'four stopped servers created despite aggregate configured memory exceeding node capacity; zero active reservations',
  );
  const first = defined(ledger.assets[0]),
    second = defined(ledger.assets[1]);
  await runtime.refreshObservations();
  const starts = await Promise.allSettled(
    [first, second].map((a) =>
      enqueueServerOperation(
        db,
        context,
        a.serverId,
        { idempotencyKey: randomUUID(), action: 'start' },
        env,
      ),
    ),
  );
  assert.equal(starts.filter((r) => r.status === 'fulfilled').length, 1);
  const admitted = starts.findIndex((r) => r.status === 'fulfilled');
  const running = defined(ledger.assets[admitted]);
  const start = defined(starts[admitted]);
  assert.equal(start.status, 'fulfilled');
  await pump(start.value.jobId);
  await verifyOwnedContainer(running, true, 256);
  evidence('two simultaneous real start requests at one-server limit: exactly one admitted');
  let ready = false;
  const echo = `NH_M2_ECHO_${randomUUID()}`;
  const relay = await adapter.relayConsole(defined(running.identifier), {
    authorize: async () => {
      await prove(defined(running.id));
      return true;
    },
    onEvent: (event) => {
      if (event.type === 'console' && event.data.trim() === echo) ready = true;
    },
    maxDurationMs: 15000,
  });
  await adapter.sendCommand(defined(running.identifier), echo);
  for (let i = 0; i < 50 && !ready; i++) await new Promise((r) => setTimeout(r, 100));
  relay.close();
  assert.ok(ready, 'Fixture console readiness marker absent');
  evidence(
    'backend-only WebSocket and command: fixture readiness marker received (no game-readiness claim)',
  );
  await operation(running.serverId, { action: 'restart' });
  assert.equal((await db.selectFrom('resource_reservations').selectAll().execute()).length, 1);
  await operation(running.serverId, { action: 'stop' });
  await verifyOwnedContainer(running, false);
  assert.equal((await db.selectFrom('resource_reservations').selectAll().execute()).length, 0);
  await adapter.writeFile(defined(running.identifier), 'm2-proof.txt', 'M2 fixture only');
  assert.equal(
    Buffer.from(await adapter.readFile(defined(running.identifier), 'm2-proof.txt')).toString(),
    'M2 fixture only',
  );
  evidence('isolated file write/read round trip');
  await operation(running.serverId, { action: 'backup' });
  const backups = await adapter.listBackups(defined(running.identifier));
  assert.equal(backups.length, 1);
  await adapter.writeFile(defined(running.identifier), 'm2-proof.txt', 'Changed fixture');
  await operation(running.serverId, {
    action: 'restore',
    backupId: defined(backups[0]).uuid,
    truncate: true,
    confirm: true,
  });
  assert.equal(
    Buffer.from(await adapter.readFile(defined(running.identifier), 'm2-proof.txt')).toString(),
    'M2 fixture only',
  );
  evidence('backup restore correlated with fresh successful activity and file content');
  await operation(running.serverId, { action: 'configure', limits: { ...limits, memory: 128 } });
  await operation(running.serverId, { action: 'start' });
  await verifyOwnedContainer(running, true, 128);
  await operation(running.serverId, { action: 'stop' });
  evidence('offline build change and subsequent Wings boot refresh');
  await operation(running.serverId, { action: 'reinstall', confirm: true, backupBefore: false });
  await operation(running.serverId, { action: 'wipe', confirm: true, backupBefore: false });
  assert.ok(
    !(await adapter.listFiles(defined(running.identifier), '')).some(
      (f) => f.name === 'm2-proof.txt',
    ),
  );
  for (const backup of await adapter.listBackups(defined(running.identifier)))
    await adapter.deleteBackup(defined(running.identifier), backup.uuid);
  assert.equal((await adapter.listBackups(defined(running.identifier))).length, 0);
  for (const asset of ledger.assets) {
    await prove(defined(asset.id));
    await operation(asset.serverId, { action: 'delete', confirm: true });
    assert.equal(await raw.findServerByExternalId(asset.externalId), null);
    const remaining = spawnSync(
      'docker',
      [
        '--host',
        `unix://${plan.dockerObserverSocket}`,
        'ps',
        '-a',
        '--filter',
        `name=^/${defined(asset.uuid)}$`,
        '--format',
        '{{.Names}}',
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('DOCKER_')),
        ),
      },
    );
    assert.equal(remaining.status, 0);
    assert.equal(remaining.stdout.trim(), '', 'Owned server container cleanup is not confirmed');
    asset.deletedAt = new Date().toISOString();
    save();
  }
  const after = await raw.listApplicationServers();
  assert.equal(after.length, before.length);
  for (const remote of after)
    assert.equal(
      JSON.stringify({
        id: remote.id,
        uuid: remote.uuid,
        external_id: remote.external_id,
        node: remote.node,
        allocation: remote.allocation,
        limits: remote.limits,
        feature_limits: remote.feature_limits,
        user: remote.user,
        egg: remote.egg,
        container: remote.container,
        updated_at: remote.updated_at,
      }),
      untouched.get(remote.uuid),
    );
  evidence(
    'all four fixture servers deleted; pre-existing Application server configuration unchanged',
  );
  ledger.completedAt = new Date().toISOString();
  save();
  await database.destroy();
  console.log(JSON.stringify({ ledger: ledgerPath, completed: true }));
} catch (error) {
  ledger.failure =
    error instanceof DomainError
      ? `${error.name}:${error.code}`
      : error instanceof Error
        ? error.name
        : 'failure';
  ledger.failureLocation =
    (error instanceof Error
      ? error.stack
          ?.match(/scripts\/m2-live\.ts:(\d+):(\d+)/)
          ?.slice(1)
          .join(':')
      : '') ?? '';
  save();
  // Never print raw provider errors/URLs or perform unreviewed automatic cleanup.
  console.error(
    JSON.stringify({
      failed: true,
      ledger: ledgerPath,
      schema: ledger.schema,
      reason: 'Live test stopped; preserve private ledger and inspect safely',
    }),
  );
  await db.destroy();
  process.exitCode = 1;
}
