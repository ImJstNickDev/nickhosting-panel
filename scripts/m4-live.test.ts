import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { canonicalMinecraftJarSha256 } from '../games/minecraft/src/generated-launcher.js';
import { readMinecraftFrame } from '../games/minecraft/src/protocol.js';
import { defaultGatewayDataPolicy } from '../packages/core/src/gateway-config.js';
import {
  type PterodactylAdapter,
  PterodactylError,
} from '../packages/pterodactyl-adapter/src/index.js';
import {
  guardMinecraftLiveAdapter,
  type MinecraftLiveLedger,
  type MinecraftLivePlan,
} from './m4-live.js';
import {
  cleanupMinecraftLiveBackups,
  createMinecraftLiveProtocolClient,
  finalizeMinecraftLiveCleanup,
  type MinecraftLiveBackupJob,
  type MinecraftLiveBackupPreparation,
  minecraftBootstrapManifest,
  minecraftLiveGatewayDataPolicy,
  minecraftLiveProviderFailure,
  minecraftLiveReadyRoute,
  promoteMinecraftInstallationEvidence,
} from './m4-live-scenario.js';

describe('independent live-client handshake evidence', () => {
  it.each([
    ['26.1', 775],
    ['1.21.4', 769],
  ] as const)(
    'observes the installed library sending %s protocol %i on loopback',
    async (release, expectedProtocol) => {
      const sockets = new Set<Socket>();
      let received!: (frame: Buffer) => void;
      let failed!: (error: Error) => void;
      const wire = new Promise<Buffer>((resolveWire, rejectWire) => {
        received = resolveWire;
        failed = rejectWire;
      });
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('error', failed);
        let pending = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          try {
            pending = Buffer.concat([pending, chunk]);
            if (pending.length > 4096) throw new Error('Fixture handshake exceeds its bound');
            const frame = readMinecraftFrame(pending, 4096);
            if (frame) {
              socket.removeAllListeners('data');
              received(frame.body);
            }
          } catch (error) {
            failed(error as Error);
          }
        });
      });
      const timeout = setTimeout(() => failed(new Error('Loopback handshake timeout')), 5000);
      let observed: ReturnType<typeof createMinecraftLiveProtocolClient> | undefined;
      try {
        await new Promise<void>((listening, rejectListen) => {
          server.once('error', rejectListen);
          server.listen(0, '127.0.0.1', listening);
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture address');
        expect(address.address).toBe('127.0.0.1');
        observed = createMinecraftLiveProtocolClient(
          '127.0.0.1',
          address.port,
          release,
          'M4Fixture',
        );
        observed.client.on('error', failed);
        expect(() => observed?.protocolEvidence()).toThrow('No unique valid emitted');
        const frame = await wire;
        let offset = 0;
        const integer = () => {
          let value = 0;
          for (let index = 0; index < 5; index++) {
            const byte = frame[offset++];
            if (byte === undefined) throw new Error('Truncated fixture integer');
            value += (byte & 0x7f) * 2 ** (7 * index);
            if (!(byte & 0x80)) return value;
          }
          throw new Error('Oversized fixture integer');
        };
        expect(integer()).toBe(0);
        const protocolId = integer();
        const hostnameLength = integer();
        expect(frame.subarray(offset, offset + hostnameLength).toString('utf8')).toBe('127.0.0.1');
        offset += hostnameLength;
        expect(frame.readUInt16BE(offset)).toBe(address.port);
        offset += 2;
        const nextState = integer();
        expect(offset).toBe(frame.length);
        expect(protocolId).toBe(expectedProtocol);
        expect(nextState).toBe(2);
        expect(observed.protocolEvidence()).toEqual({
          release,
          protocolId,
          nextState,
          source: 'outbound-set_protocol',
        });
        expect(Object.isFrozen(observed.protocolEvidence())).toBe(true);
        // 1.68.0's type declaration incorrectly advertises this absent property.
        expect(observed.client.protocolVersion).toBeUndefined();
        // A later duplicate cannot inherit the first observed handshake, even if
        // the library also rejects it because it has already entered LOGIN.
        try {
          observed.client.write('set_protocol', {
            protocolVersion: expectedProtocol,
            serverHost: '127.0.0.1',
            serverPort: address.port,
            nextState: 2,
          });
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
        expect(() => observed?.protocolEvidence()).toThrow('No unique valid emitted');
      } finally {
        clearTimeout(timeout);
        observed?.client.end();
        observed?.client.socket.destroy();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((closed) => server.close(() => closed()));
      }
    },
  );
});

describe('live provider diagnostics', () => {
  it('changes fixture cadence without extending any timeout or safety bound', () => {
    const { pollIntervalMs, probeIntervalMs, ...bounds } = minecraftLiveGatewayDataPolicy;
    const {
      pollIntervalMs: _poll,
      probeIntervalMs: _probe,
      ...defaults
    } = defaultGatewayDataPolicy;
    expect(bounds).toEqual(defaults);
    expect(pollIntervalMs).toBe(5000);
    expect(probeIntervalMs).toBe(5000);
  });
  it('retains bounded status/retry information without URLs, credentials or provider bodies', async () => {
    const response = new Response('private provider body', {
      status: 429,
      headers: { 'Retry-After': '60', 'Set-Cookie': 'private=value' },
    });
    expect(
      minecraftLiveProviderFailure(
        response,
        'https://private.invalid/api/application/nodes?token=private',
      ),
    ).toEqual({
      status: 429,
      scope: 'application',
      retryAfterSeconds: 60,
    });
    expect(await response.text()).toBe('private provider body');
  });
  it.each(['999999999999', 'private header value', '-1'])(
    'omits unbounded retry headers: %s',
    (retry) => {
      expect(
        minecraftLiveProviderFailure(
          new Response(null, { status: 503, headers: { 'Retry-After': retry } }),
          'https://private.invalid/transfer/private-token',
        ),
      ).toEqual({ status: 503, scope: 'transfer' });
    },
  );
});

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

function backupFixture() {
  const { ledger } = fixture();
  ledger.runId = randomUUID();
  const asset = ledger.assets[0];
  if (!asset) throw new Error('Missing fixture');
  const now = Date.now();
  asset.createdAt = new Date(now - 30000).toISOString();
  const ownerId = randomUUID();
  const backupId = randomUUID();
  const job: MinecraftLiveBackupJob = {
    jobId: randomUUID(),
    serverId: asset.managedServerId,
    actorId: ownerId,
    subjectId: ownerId,
    resourceOwnerId: ownerId,
    supportSessionId: null,
    state: 'succeeded',
    action: 'minecraft-content',
    plan: { backupId, minecraftContent: { backupBefore: true } },
    createdAt: new Date(now - 20000),
    completedAt: new Date(now - 1000),
  };
  const prepared: MinecraftLiveBackupPreparation = {
    jobId: job.jobId,
    serverId: asset.managedServerId,
    actorId: ownerId,
    subjectId: ownerId,
    supportSessionId: null,
    messageKey: 'servers.operation.effect_prepared',
    data: { phase: 'backup' },
    createdAt: new Date(now - 15000),
  };
  const backup = {
    uuid: backupId,
    name: `nickhosting-operation-${job.jobId}`,
    is_successful: true,
    is_locked: false,
    ignored_files: [],
    checksum: 'sha1:isolated-fixture',
    bytes: 4096,
    created_at: new Date(now - 10000).toISOString(),
    completed_at: new Date(now - 5000).toISOString(),
  };
  const inventory = new Map<string, typeof backup>([[backupId, backup]]);
  const order: string[] = [];
  const prove = vi.fn(async () => {
    order.push('prove');
  });
  const listBackups = vi.fn(async () => [...inventory.values()]);
  const getBackup = vi.fn(async (_identifier: string, id: string) => {
    const value = inventory.get(id);
    if (!value) throw new PterodactylError('not_found', 'client', 'rejected', 404);
    return { ...value };
  });
  const deleteBackup = vi.fn(async (_identifier: string, id: string) => {
    order.push('delete');
    inventory.delete(id);
  });
  const options = {
    asset,
    ledger,
    ownerId,
    jobs: [job],
    preparations: [prepared],
    adapter: { listBackups, getBackup, deleteBackup },
    prove,
    event: vi.fn(async (event: string, details: Record<string, unknown>) => {
      order.push(event);
      ledger.events.push({ at: new Date().toISOString(), event, details });
    }),
  };
  return { options, backup, job, prepared, inventory, order, ...options.adapter };
}

describe('M4 live test backup cleanup provenance', () => {
  it('persists the exact deletion intent, deletes the owned backup, then verifies provider absence', async () => {
    const f = backupFixture();
    await cleanupMinecraftLiveBackups(f.options);
    expect(f.deleteBackup).toHaveBeenCalledExactlyOnceWith(
      f.options.asset.identifier,
      f.backup.uuid,
    );
    expect(f.order.indexOf('cleanup.backup.delete-intent')).toBeLessThan(f.order.indexOf('delete'));
    expect(f.order.indexOf('delete')).toBeLessThan(
      f.order.indexOf('cleanup.backup.provider-deletion-confirmed'),
    );
    expect(f.options.ledger.events.at(-1)?.details).toMatchObject({
      verifiedBackupCount: 1,
      directStorageErasureVerified: false,
    });
    expect(f.options.prove).toHaveBeenCalled();
  });
  it('rejects unknown backups before deleting even the known backup', async () => {
    const f = backupFixture();
    const unknown = randomUUID();
    f.inventory.set(unknown, { ...f.backup, uuid: unknown });
    await expect(cleanupMinecraftLiveBackups(f.options)).rejects.toThrow('Unknown backup');
    expect(f.deleteBackup).not.toHaveBeenCalled();
  });
  it('does not infer ownership from the generated name or list alone', async () => {
    const f = backupFixture();
    f.options.jobs = [];
    await expect(cleanupMinecraftLiveBackups(f.options)).rejects.toThrow('Unknown backup');
    expect(f.deleteBackup).not.toHaveBeenCalled();
  });
  it('requires the actual durable creation event, not only a plan reference', async () => {
    const f = backupFixture();
    f.prepared.data.phase = 'restore';
    await expect(cleanupMinecraftLiveBackups(f.options)).rejects.toThrow('Unknown backup');
    expect(f.deleteBackup).not.toHaveBeenCalled();
  });
  for (const field of ['actorId', 'subjectId', 'resourceOwnerId', 'serverId'] as const) {
    it(`refuses a mismatched ${field}`, async () => {
      const f = backupFixture();
      f.job[field] = randomUUID();
      await expect(cleanupMinecraftLiveBackups(f.options)).rejects.toThrow();
      expect(f.deleteBackup).not.toHaveBeenCalled();
    });
  }
  it('rejects an active job, ambiguous creation attempts, or a non-creation action', async () => {
    for (const mutation of [
      (f: ReturnType<typeof backupFixture>) => {
        f.job.state = 'running';
      },
      (f: ReturnType<typeof backupFixture>) => {
        f.options.preparations.push({ ...f.prepared });
      },
      (f: ReturnType<typeof backupFixture>) => {
        f.job.action = 'restore';
      },
    ]) {
      const f = backupFixture();
      mutation(f);
      await expect(cleanupMinecraftLiveBackups(f.options)).rejects.toThrow();
      expect(f.deleteBackup).not.toHaveBeenCalled();
    }
  });
  it('rejects old, locked, incomplete or changed backups', async () => {
    for (const change of [
      { created_at: new Date(0).toISOString() },
      { is_locked: true },
      { completed_at: null },
      { uuid: randomUUID() },
    ]) {
      const f = backupFixture();
      f.getBackup.mockResolvedValueOnce({ ...f.backup, ...change } as typeof f.backup);
      await expect(cleanupMinecraftLiveBackups(f.options)).rejects.toThrow();
      expect(f.deleteBackup).not.toHaveBeenCalled();
    }
    const f = backupFixture();
    f.getBackup
      .mockResolvedValueOnce(f.backup)
      .mockResolvedValueOnce({ ...f.backup, checksum: 'changed-after-proof' });
    await expect(cleanupMinecraftLiveBackups(f.options)).rejects.toThrow('Backup changed');
    expect(f.deleteBackup).not.toHaveBeenCalled();
  });
  it('retains uncertainty after a lost response; an explicit rerun can confirm the exact absent backup', async () => {
    const f = backupFixture();
    f.deleteBackup.mockImplementationOnce(async (_identifier, id) => {
      f.inventory.delete(id);
      throw new PterodactylError('unavailable', 'client', 'unknown');
    });
    await expect(cleanupMinecraftLiveBackups(f.options)).rejects.toThrow('uncertain');
    expect(f.options.ledger.events.at(-1)?.event).toBe('cleanup.backup.deletion-uncertain');
    expect(f.order).not.toContain('cleanup.backup.provider-deletion-confirmed');
    await cleanupMinecraftLiveBackups(f.options);
    expect(f.deleteBackup).toHaveBeenCalledTimes(1);
    expect(f.order).toContain('cleanup.backup.provider-absence-reconciled');
  });
  it('never retries an unresolved deletion while the backup still exists', async () => {
    const f = backupFixture();
    f.deleteBackup.mockRejectedValueOnce(new Error('unavailable'));
    await expect(cleanupMinecraftLiveBackups(f.options)).rejects.toThrow('uncertain');
    await expect(cleanupMinecraftLiveBackups(f.options)).rejects.toThrow(
      'Unresolved deletion intent',
    );
    expect(f.deleteBackup).toHaveBeenCalledTimes(1);
  });
  it('cannot reconcile an absent backup without the exact prior run and identity-bound intent', async () => {
    const f = backupFixture();
    f.inventory.clear();
    await expect(cleanupMinecraftLiveBackups(f.options)).rejects.toThrow('no durable');
    expect(f.deleteBackup).not.toHaveBeenCalled();
  });
  it('does not treat permission or transport failures as backup absence', async () => {
    for (const error of [
      new PterodactylError('permission_denied', 'client', 'rejected', 403),
      new PterodactylError('unavailable', 'client', 'unknown'),
      new PterodactylError('not_found', 'application', 'rejected', 404),
    ]) {
      const f = backupFixture();
      f.getBackup
        .mockResolvedValueOnce(f.backup)
        .mockResolvedValueOnce(f.backup)
        .mockRejectedValueOnce(error);
      await expect(cleanupMinecraftLiveBackups(f.options)).rejects.toThrow('uncertain');
      expect(f.order).not.toContain('cleanup.backup.provider-deletion-confirmed');
    }
  });
  it('requires durable intent persistence before the remote effect', async () => {
    const f = backupFixture();
    const record = f.options.event.getMockImplementation();
    f.options.event.mockImplementation(async (name, details) => {
      if (name === 'cleanup.backup.delete-intent') throw new Error('fsync failed');
      await record?.(name, details);
    });
    await expect(cleanupMinecraftLiveBackups(f.options)).rejects.toThrow('fsync failed');
    expect(f.deleteBackup).not.toHaveBeenCalled();
  });
  it('allows a conclusively empty backup inventory for assets that never created one', async () => {
    const f = backupFixture();
    f.options.jobs = [];
    f.options.preparations = [];
    f.inventory.clear();
    await cleanupMinecraftLiveBackups(f.options);
    expect(f.deleteBackup).not.toHaveBeenCalled();
    expect(f.options.ledger.events.at(-1)?.details?.verifiedBackupCount).toBe(0);
  });
});

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
    // Manual stop intentionally revokes the policy generation. Even after the
    // data plane has committed the new stopped route, the old policy can never
    // satisfy this wait; only the freshly read post-stop generation is eligible.
    const postStopGeneration = randomUUID();
    const stoppedState = {
      ...state,
      state: 'manually_stopped' as const,
      generation: postStopGeneration,
      sleepEligibleAt: null,
    };
    const { sleepEligibleAt: _manualIdleDeadline, ...beforeStoppedRoute } = route;
    const stoppedRoute = {
      ...beforeStoppedRoute,
      mode: 'manually_stopped' as const,
      generation: postStopGeneration,
    };
    const stoppedSnapshot = { ...snapshot, routes: [stoppedRoute] };
    expect(
      minecraftLiveReadyRoute(
        stoppedState,
        stoppedSnapshot,
        health,
        serverId,
        generation,
        now,
        'manually_stopped',
      ),
    ).toBeUndefined();
    expect(
      minecraftLiveReadyRoute(
        stoppedState,
        snapshot,
        health,
        serverId,
        postStopGeneration,
        now,
        'manually_stopped',
      ),
    ).toBeUndefined();
    expect(
      minecraftLiveReadyRoute(
        stoppedState,
        stoppedSnapshot,
        health,
        serverId,
        postStopGeneration,
        now,
        'manually_stopped',
      ),
    ).toBe(stoppedRoute);
    expect(
      minecraftLiveReadyRoute(
        stoppedState,
        stoppedSnapshot,
        { ...health, revision: health.revision - 1 },
        serverId,
        postStopGeneration,
        now,
        'manually_stopped',
      ),
    ).toBeUndefined();
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
