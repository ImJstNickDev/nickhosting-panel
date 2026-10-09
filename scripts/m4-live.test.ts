import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { canonicalMinecraftJarSha256 } from '../games/minecraft/src/generated-launcher.js';
import type { PterodactylAdapter } from '../packages/pterodactyl-adapter/src/index.js';
import {
  guardMinecraftLiveAdapter,
  type MinecraftLiveLedger,
  type MinecraftLivePlan,
} from './m4-live.js';
import {
  finalizeMinecraftLiveCleanup,
  minecraftBootstrapManifest,
  minecraftLiveReadyRoute,
  promoteMinecraftInstallationEvidence,
} from './m4-live-scenario.js';

const require = createRequire(new URL('../games/minecraft/package.json', import.meta.url));
const { ZipFile } = require('yazl') as {
  ZipFile: new () => {
    addBuffer(buffer: Buffer, path: string, options: { mtime: Date }): void;
    end(): void;
    outputStream: Readable;
  };
};
async function generatedLauncher(year: number) {
  const archive = new ZipFile();
  for (const [path, contents] of [
    [
      'META-INF/MANIFEST.MF',
      'Manifest-Version: 1.0\r\nMain-Class: net.fabricmc.loader.impl.launch.server.FabricServerLauncher\r\n\r\n',
    ],
    [
      'fabric-server-launch.properties',
      'launch.mainClass=net.fabricmc.loader.impl.launch.knot.KnotServer\n',
    ],
  ])
    archive.addBuffer(Buffer.from(contents ?? ''), path ?? '', {
      mtime: new Date(`${year}-01-01T00:00:00Z`),
    });
  archive.end();
  const chunks: Buffer[] = [];
  for await (const chunk of archive.outputStream) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  return {
    path: 'fabric-server-launch.jar',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    role: 'fabric-launcher' as const,
    jarEntriesSha256: await canonicalMinecraftJarSha256(bytes),
    minecraftServerPath: 'server.jar',
  };
}

/** Pure fake boundary only. No file, network, Docker or Pterodactyl effect. */
function fixture() {
  const identity = { id: 41, admin: true };
  const accountHash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const now = new Date().toISOString();
  const asset = {
    managedServerId: randomUUID(),
    externalId: `isolated:${randomUUID()}`,
    profile: 'vanilla' as const,
    requestedAt: now,
    attemptedAt: now,
    id: 301,
    uuid: randomUUID(),
    identifier: 'fixture-only',
    createdAt: now,
  };
  const plan = {
    expectedApiIdentitySha256: accountHash,
    expectedApiAccountId: 41,
    nodeId: 77,
    profiles: [
      {
        request: { profile: 'vanilla', release: '26.1' },
        eggId: 91,
        nestId: 17,
        image: 'fixture/java:25',
      },
    ],
    backendAllocationPool: {
      allocations: [{ allocationId: 301, address: '10.99.0.5', port: 29991 }],
      gatewayBindAddresses: ['127.0.0.1'],
    },
    limits: { memoryMiB: 2048, cpuPercent: 100, diskMiB: 4096 },
    approval: {
      endpoints: true,
      eula: true,
      externalExposureAcknowledged: true,
      reference: 'isolated-unit-test',
    },
  } as unknown as MinecraftLivePlan;
  const ledger = {
    existingServerUuids: [],
    apiIdentitySha256: accountHash,
    apiAccountId: 41,
    assets: [asset],
    events: [],
  } as unknown as MinecraftLiveLedger;
  const remote = {
    id: asset.id,
    uuid: asset.uuid,
    identifier: asset.identifier,
    external_id: asset.externalId,
    created_at: now,
    node: 77,
    user: 41,
    egg: 91,
    nest: 17,
    container: { image: 'fixture/java:25' },
    allocation: 301,
    limits: { memory: 2048, cpu: 100, disk: 4096, swap: 0, io: 500 },
    feature_limits: { databases: 0, allocations: 1, backups: 1 },
  };
  const updateBuild = vi.fn();
  const adapter = guardMinecraftLiveAdapter(
    {
      getAccount: async () => identity,
      getApplicationServer: async () => remote,
      updateBuild,
    } as unknown as PterodactylAdapter,
    plan,
    ledger,
    '/unreachable-no-write-path',
  );
  return {
    adapter,
    updateBuild,
    ledger,
    input: {
      memory: 2048,
      cpu: 100,
      disk: 4096,
      swap: 0,
      io: 500,
      allocation: 301,
      feature_limits: { databases: 0, allocations: 1, backups: 1 },
    },
  };
}

describe('reviewed M4 live resource envelope', () => {
  it('waits for the current generation and committed snapshot before a real client can join', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    const generation = randomUUID();
    const serverId = randomUUID();
    const route = {
      id: randomUUID(),
      serverId,
      nodeId: randomUUID(),
      allocationId: randomUUID(),
      generation,
      revision: 7,
      mode: 'online' as const,
      locale: 'en' as const,
      sleepEligibleAt: new Date(now + 30000).toISOString(),
      public: { address: '127.0.0.1', port: 29991, transport: 'tcp' as const },
      backend: { allocationAddress: '10.99.0.5', address: '10.99.0.5', port: 29991 },
    };
    const snapshot = {
      gatewayId: randomUUID(),
      revision: 7,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 15000).toISOString(),
      routes: [route],
    };
    const state = {
      state: 'online' as const,
      generation,
      sleepJobId: null,
      sleepEligibleAt: route.sleepEligibleAt,
    };
    const health = {
      ready: true,
      controlAvailable: true,
      stopping: false,
      revision: 6,
      expiresAt: snapshot.expiresAt,
      routes: 1,
      tcpConnections: 0,
      udpSessions: 0,
      quiescentServers: 0,
    };
    const check = (status = health, routes = snapshot, core = state) =>
      minecraftLiveReadyRoute(core, routes, status, serverId, generation, now);
    // Core is already online while the data plane still serves the old policy.
    expect(check()).toBeUndefined();
    health.revision = snapshot.revision;
    expect(check()).toBe(route);
    expect(
      check(health, { ...snapshot, routes: [{ ...route, generation: randomUUID() }] }),
    ).toBeUndefined();
    expect(check(health, snapshot, { ...state, generation: randomUUID() })).toBeUndefined();
    expect(check({ ...health, routes: 0 }, { ...snapshot, routes: [] })).toBeUndefined();
    expect(check({ ...health, controlAvailable: false })).toBeUndefined();
    expect(check({ ...health, quiescentServers: 1 })).toBeUndefined();
    expect(check({ ...health, expiresAt: new Date(now + 4000).toISOString() })).toBeUndefined();
    const imminent = new Date(now + 4000).toISOString();
    expect(
      check(
        health,
        { ...snapshot, routes: [{ ...route, sleepEligibleAt: imminent }] },
        { ...state, sleepEligibleAt: imminent },
      ),
    ).toBeUndefined();
    for (const mode of ['sleeping', 'blocked', 'manually_stopped'] as const) {
      const { sleepEligibleAt: _idleDeadline, ...baseRoute } = route;
      const offline = { ...snapshot, routes: [{ ...baseRoute, mode }] };
      const current = { ...state, state: mode, sleepEligibleAt: null };
      expect(
        minecraftLiveReadyRoute(current, offline, health, serverId, generation, now, mode),
      ).toBe(offline.routes[0]);
      expect(
        minecraftLiveReadyRoute(
          current,
          offline,
          { ...health, revision: 6 },
          serverId,
          generation,
          now,
          mode,
        ),
      ).toBeUndefined();
      expect(
        minecraftLiveReadyRoute(current, snapshot, health, serverId, generation, now, mode),
      ).toBeUndefined();
    }
  });
  it('retains failed-run schema, bootstrap evidence and failure history after explicit asset cleanup', async () => {
    const scenario = {
      schema: `nh_test_${'a'.repeat(32)}`,
      activePhase: 'cleanup:vanilla',
      failedAt: '2026-10-09T12:00:00Z',
      completedBootstrap: ['vanilla'],
      completedMinecraft: [],
      cleanedAt: undefined,
      assetCleanupAt: undefined,
    };
    const callbacks = {
      retainSchema: true,
      event: vi.fn(async () => {}),
      dropSchema: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
    };
    await finalizeMinecraftLiveCleanup(
      scenario,
      [{ deletedAt: '2026-10-09T12:01:00Z' }],
      callbacks,
    );
    expect(callbacks.dropSchema).not.toHaveBeenCalled();
    expect(callbacks.save).toHaveBeenCalledOnce();
    expect(scenario.failedAt).toBe('2026-10-09T12:00:00Z');
    expect(scenario.completedBootstrap).toEqual(['vanilla']);
    expect(scenario.completedMinecraft).toEqual([]);
    expect(scenario.cleanedAt).toBeUndefined();
    expect(scenario.assetCleanupAt).toEqual(expect.any(String));
    expect(scenario.activePhase).toBeUndefined();
    expect(callbacks.event).toHaveBeenCalledWith(
      'cleanup.assets-confirmed-schema-retained',
      expect.objectContaining({ automaticRetry: false, originalJobsRetained: true }),
    );
  });
  it('cannot retain or drop a cleanup schema while an asset remains unresolved', async () => {
    for (const retainSchema of [true, false]) {
      const callbacks = {
        retainSchema,
        event: vi.fn(async () => {}),
        dropSchema: vi.fn(async () => {}),
        save: vi.fn(async () => {}),
      };
      await expect(
        finalizeMinecraftLiveCleanup(
          { schema: `nh_test_${'a'.repeat(32)}`, failedAt: 'unchanged' },
          [{}],
          callbacks,
        ),
      ).rejects.toThrow('Unresolved asset');
      expect(callbacks.event).not.toHaveBeenCalled();
      expect(callbacks.dropSchema).not.toHaveBeenCalled();
      expect(callbacks.save).not.toHaveBeenCalled();
    }
  });
  it('drops only a fully cleaned schema when retention was not requested', async () => {
    const scenario = {
      schema: `nh_test_${'b'.repeat(32)}`,
      activePhase: 'cleanup:vanilla',
      failedAt: '2026-10-09T12:00:00Z',
      cleanedAt: undefined,
    };
    const callbacks = {
      retainSchema: false,
      event: vi.fn(async () => {}),
      dropSchema: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
    };
    await finalizeMinecraftLiveCleanup(
      scenario,
      [{ deletedAt: '2026-10-09T12:01:00Z' }],
      callbacks,
    );
    expect(callbacks.dropSchema).toHaveBeenCalledOnce();
    expect(scenario.cleanedAt).toEqual(expect.any(String));
    expect(scenario.failedAt).toBe('2026-10-09T12:00:00Z');
    expect(scenario.activePhase).toBeUndefined();
  });
  it('preserves Fabric semantic proof from bootstrap through real evidence and a third installation', async () => {
    const bootstrap = await generatedLauncher(2020),
      real = await generatedLauncher(2021),
      third = await generatedLauncher(2022);
    expect(new Set([bootstrap.sha256, real.sha256, third.sha256]).size).toBe(3);
    const vanilla = { path: 'server.jar', sha256: 'a'.repeat(64), size: 100 };
    const promoted = promoteMinecraftInstallationEvidence([bootstrap, vanilla], [real, vanilla]);
    expect(promoted[0]).toEqual(real);
    const subsequent = promoteMinecraftInstallationEvidence(promoted, [third, vanilla]);
    expect(subsequent[0]).toEqual(third);
    expect(subsequent[0]?.jarEntriesSha256).toBe(bootstrap.jarEntriesSha256);
    expect(() =>
      promoteMinecraftInstallationEvidence(promoted, [
        { ...third, jarEntriesSha256: 'b'.repeat(64) },
        vanilla,
      ]),
    ).toThrow();
    expect(() =>
      promoteMinecraftInstallationEvidence(promoted, [
        third,
        { ...vanilla, sha256: 'c'.repeat(64) },
      ]),
    ).toThrow();
    expect(() =>
      promoteMinecraftInstallationEvidence(promoted, [
        third,
        vanilla,
        { path: 'fabric-server-launcher.properties', sha256: 'd'.repeat(64), size: 20 },
      ]),
    ).toThrow();
  });
  it('registers a separately scoped bootstrap manifest without claiming Minecraft capabilities', () => {
    expect(minecraftBootstrapManifest.id).toBe('m4-bootstrap');
    expect(minecraftBootstrapManifest.localizations.namespace).toBe('games.m4-bootstrap');
    expect(minecraftBootstrapManifest.runtimes).toHaveLength(5);
    expect(minecraftBootstrapManifest.capabilities.readiness).toBe(false);
    expect(minecraftBootstrapManifest.capabilities.mods).toBe(false);
  });
  it('accepts the bounded input up to the intentionally unavailable durable ledger', async () => {
    const f = fixture();
    await expect(f.adapter.updateBuild(301, f.input)).rejects.toThrow();
    expect(f.ledger.events).toHaveLength(1);
    expect(f.ledger.events[0]?.event).toBe('mutation.updateBuild.attempted');
    // The missing durable proof blocks effects even for an otherwise safe envelope.
    expect(f.updateBuild).not.toHaveBeenCalled();
  });
  for (const field of ['memory', 'disk', 'cpu'] as const) {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      it(`rejects ${field}=${String(value)} before a remote mutation or ledger effect`, async () => {
        const f = fixture();
        await expect(f.adapter.updateBuild(301, { ...f.input, [field]: value })).rejects.toThrow();
        expect(f.updateBuild).not.toHaveBeenCalled();
        expect(f.ledger.events).toEqual([]);
      });
    }
  }
  for (const field of ['memory', 'disk'] as const) {
    it(`rejects fractional ${field} limits`, async () => {
      const f = fixture();
      await expect(f.adapter.updateBuild(301, { ...f.input, [field]: 1.5 })).rejects.toThrow();
      expect(f.updateBuild).not.toHaveBeenCalled();
    });
  }
  it('does not enable unapproved unlimited swap', async () => {
    const f = fixture();
    await expect(f.adapter.updateBuild(301, { ...f.input, swap: -1 })).rejects.toThrow();
    expect(f.updateBuild).not.toHaveBeenCalled();
  });
});
