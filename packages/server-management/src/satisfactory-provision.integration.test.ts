import { randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type {
  ApplicationServer,
  ProvisionPlan,
  PterodactylAdapter,
  Resources,
} from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { satisfactoryManifest } from '../../../games/satisfactory/src/manifest.js';
import { reserveInstallation, reserveStart } from './admission.js';
import { getGatewayState } from './gateway-orchestration.js';
import { getGatewaySnapshot } from './gateway-registry.js';
import {
  type LifecycleOptions,
  processServerOperation,
  reconcileManagedServer,
} from './lifecycle.js';
import { createManagedServer, setRuntimeMapping } from './registry.js';
import { authorizeQueuedEffect, createManagementRuntime } from './runtime.js';
import { readSatisfactoryTlsIdentity } from './satisfactory-tls.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 37) } });
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

describe('Satisfactory application provision lifecycle', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    'creates three permanent routes and uploads persistent TLS before optional initial start (autoStart=%s, missingOutputs=%s)',
    async (autoStart, missingOutputs) => {
      const f = await managementFixture(database.db, { interactive: true });
      await f.db
        .insertInto('game_integrations')
        .values({
          id: 'satisfactory',
          version: satisfactoryManifest.version,
          manifest: satisfactoryManifest,
        })
        .onConflict((c) => c.column('id').doUpdateSet({ manifest: satisfactoryManifest }))
        .execute();
      await f.db
        .insertInto('game_rollouts')
        .values({ integration_id: 'satisfactory', state: 'public', allowlist: [] })
        .onConflict((c) => c.column('integration_id').doNothing())
        .execute();
      vi.mocked(f.adapter.getEgg).mockResolvedValue({
        id: 24,
        nest: 5,
        name: 'Satisfactory',
        docker_images: { SteamCMD: 'ghcr.io/ptero-eggs/steamcmd:debian' },
        config: { stop: '^C' },
      } as never);
      const mapping = await setRuntimeMapping(f.db, f.adapter, f.owner, {
        gameId: 'satisfactory',
        runtimeId: 'dedicated',
        nodeId: f.nodeId,
        nestId: 5,
        eggId: 24,
        imageMode: 'integration',
        startup:
          './Engine/Binaries/Linux/*-Linux-Shipping FactoryGame -Port={{SERVER_PORT}} -ReliablePort={{RELIABLE_PORT}} -ExternalReliablePort={{RELIABLE_PORT}}',
        environment: { SRCDS_APPID: '1690800', SRCDS_BETAID: '', AUTO_UPDATE: '1' },
        portRoles: [
          { role: 'game', protocols: ['tcp', 'udp'], primary: true },
          {
            role: 'reliable',
            protocols: ['tcp'],
            primary: false,
            environmentVariable: 'RELIABLE_PORT',
          },
        ],
        featureLimits: { databases: 0, allocations: 2, backups: 1 },
        enabled: true,
      });
      const env = {
        NH_GATEWAY_ENABLED: 'true',
        NH_GATEWAY_ID: randomUUID(),
        NH_GATEWAY_PHYSICAL_HOST_ID: f.hostId,
        NH_STORAGE_POLICY: 'PER_USER_BUDGET',
      };
      const request = f.input({
        mappingId: mapping.id,
        autoStart,
        satisfactory: { branch: 'experimental', autoUpdate: false },
      });
      const created = await createManagedServer(f.db, f.adapter, f.context, request, env, {
        codec,
      });
      expect(
        await createManagedServer(f.db, f.adapter, f.context, request, env, { codec }),
      ).toEqual(created);
      const stored = await f.db
        .selectFrom('server_operations')
        .selectAll()
        .where('job_id', '=', created.jobId)
        .executeTakeFirstOrThrow();
      const plan = stored.plan.provision as ProvisionPlan;
      expect(plan).toMatchObject({
        eggId: 24,
        dockerImage: 'ghcr.io/ptero-eggs/steamcmd:debian',
        environment: {
          SRCDS_APPID: '1690800',
          SRCDS_BETAID: 'experimental',
          AUTO_UPDATE: '0',
          RELIABLE_PORT: '20001',
        },
        allocation: { default: f.inventory[0]?.id, additional: [f.inventory[1]?.id] },
      });
      expect(plan.startup).toBe(
        './Engine/Binaries/Linux/*-Linux-Shipping FactoryGame -Port=20000 -ReliablePort=20001 -ExternalReliablePort=20001',
      );
      const routes = () =>
        f.db
          .selectFrom('gateway_routes')
          .selectAll()
          .where('server_id', '=', created.serverId)
          .execute();
      expect(await routes()).toHaveLength(3);
      expect((await routes()).every((r) => !r.enabled)).toBe(true);
      expect(JSON.stringify(stored.plan)).not.toContain('PRIVATE KEY');
      const identity = await readSatisfactoryTlsIdentity(f.db, codec, created.serverId);
      expect(identity).toBeDefined();
      let remote: ApplicationServer | undefined;
      let state: Resources['current_state'] = 'offline';
      let clock = new Date();
      const files = new Map<string, Uint8Array>();
      const directories = new Set([
        'FactoryGame',
        'Engine',
        'Engine/Binaries',
        'Engine/Binaries/Linux',
      ]);
      const effects: string[] = [];
      const adapter = {
        ...f.adapter,
        findServerByExternalId: vi.fn(async () => remote ?? null),
        createServer: vi.fn(async (input: ProvisionPlan) => {
          effects.push('create');
          remote = {
            id: 90000 + Number(autoStart) + Number(missingOutputs) * 2,
            uuid: randomUUID(),
            identifier: randomUUID().slice(0, 8),
            external_id: input.externalId,
            name: input.name,
            description: '',
            suspended: false,
            limits: input.limits,
            feature_limits: input.featureLimits,
            user: input.userId,
            node: f.providerNodeId,
            allocation: input.allocation.default,
            nest: 5,
            egg: 24,
            status: null,
            container: {
              startup_command: input.startup,
              image: input.dockerImage,
              installed: true,
            },
            created_at: clock.toISOString(),
            updated_at: clock.toISOString(),
            relationships: {
              allocations: {
                object: 'list',
                data: f.inventory
                  .slice(0, 2)
                  .map((a) => ({ attributes: { ...a, assigned: true } })),
              },
            },
          };
          return remote;
        }),
        getApplicationServer: vi.fn(async () => {
          if (!remote) throw new Error('fixture server absent');
          return remote;
        }),
        confirmInstallation: vi.fn(
          async (
            _id: number,
            _identifier: string,
            callbacks: { authorize(): Promise<boolean>; onConfirmed(): Promise<void> },
          ) => {
            expect(await callbacks.authorize()).toBe(true);
            await callbacks.onConfirmed();
            return { confirmed: true };
          },
        ),
        getResources: vi.fn(async () => ({
          current_state: state,
          is_suspended: false,
          resources: {
            memory_bytes: 0,
            cpu_absolute: 0,
            disk_bytes: 1,
            network_rx_bytes: 0,
            network_tx_bytes: 0,
            uptime: 1,
          },
        })),
        listFiles: vi.fn(async (_id: string, root: string) =>
          root === 'Engine/Binaries/Linux'
            ? missingOutputs
              ? []
              : [
                  {
                    name: 'FactoryServer-Linux-Shipping',
                    is_file: true,
                    is_symlink: false,
                    size: 1,
                  },
                ]
            : [...directories]
                .filter((p) => p.split('/').slice(0, -1).join('/') === root)
                .map((p) => ({ name: p.split('/').at(-1), is_file: false, is_symlink: false })),
        ),
        createDirectory: vi.fn(async (_id: string, root: string, name: string) => {
          directories.add([root, name].filter(Boolean).join('/'));
        }),
        uploadFile: vi.fn(
          async (
            _id: string,
            path: string,
            input: {
              privateFile: boolean;
              body: ReadableStream<Uint8Array>;
              authorize(): Promise<void>;
            },
          ) => {
            expect(state).toBe('offline');
            expect(input.privateFile).toBe(true);
            await input.authorize();
            files.set(path, new Uint8Array(await new Response(input.body).arrayBuffer()));
            effects.push(path);
          },
        ),
        readFile: vi.fn(async (_id: string, path: string) => files.get(path) ?? new Uint8Array()),
        power: vi.fn(async () => {
          expect(files.size).toBe(2);
          effects.push('start');
          state = 'running';
        }),
      } as unknown as PterodactylAdapter;
      const runtime = await createManagementRuntime({ db: f.db, codec, adapter, env });
      const options: LifecycleOptions = {
        adapter,
        env,
        now: () => clock,
        settleMs: 1,
        configureGameProvision: runtime.lifecycle.configureGameProvision,
        authorizeEffect: async (jobId, serverId, db) => {
          await authorizeQueuedEffect(db, jobId, serverId, env, adapter);
        },
        reserveInstallation: (serverId, jobId, db) => reserveInstallation(db, serverId, jobId, env),
        reserveStart: (serverId, jobId, action, db) =>
          reserveStart(db, serverId, jobId, action, env),
        confirmAlreadyStopped: async () => state === 'offline',
      };
      const first = await processServerOperation(f.db, created.jobId, options);
      if (missingOutputs) {
        expect(first).toBe('failed');
        expect(
          await f.db
            .selectFrom('managed_servers')
            .select(['installation_state', 'active_operation_id'])
            .where('id', '=', created.serverId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ installation_state: 'failed', active_operation_id: null });
        expect(adapter.power).not.toHaveBeenCalled();
        expect(adapter.uploadFile).not.toHaveBeenCalled();
        expect((await routes()).every((route) => !route.enabled)).toBe(true);
        expect(await reconcileManagedServer(f.db, created.serverId, options)).toBe('observed');
        expect(
          (
            await f.db
              .selectFrom('managed_servers')
              .select('installation_state')
              .where('id', '=', created.serverId)
              .executeTakeFirstOrThrow()
          ).installation_state,
        ).toBe('failed');
        return;
      }
      if (autoStart) {
        expect(first).toBe('waiting');
        clock = new Date(clock.getTime() + 30000);
        expect(await processServerOperation(f.db, created.jobId, options)).toBe('succeeded');
      } else expect(first).toBe('succeeded');
      expect(adapter.createServer).toHaveBeenCalledTimes(1);
      expect(effects.slice(0, 3)).toEqual([
        'create',
        'FactoryGame/Certificates/cert_chain.pem',
        'FactoryGame/Certificates/private_key.pem',
      ]);
      expect(adapter.power).toHaveBeenCalledTimes(autoStart ? 1 : 0);
      expect(
        Buffer.from(
          files.get('FactoryGame/Certificates/cert_chain.pem') ?? new Uint8Array(),
        ).toString(),
      ).toBe(identity?.certificatePem);
      expect(
        Buffer.from(
          files.get('FactoryGame/Certificates/private_key.pem') ?? new Uint8Array(),
        ).toString(),
      ).toBe(identity?.privateKeyPem);
      expect((await routes()).every((r) => r.enabled)).toBe(true);
      const gateway = await getGatewayState(f.db, created.serverId, { env, now: () => clock });
      expect(gateway).toMatchObject({
        enabled: true,
        protocolId: 'satisfactory',
        gameVersion: 'dedicated',
      });
      const snapshot = await getGatewaySnapshot(f.db, env);
      expect(
        snapshot.routes
          .filter((r) => r.serverId === created.serverId)
          .map((r) => `${r.protocol?.role}:${r.public.transport}`)
          .sort(),
      ).toEqual(['game:tcp', 'game:udp', 'reliable:tcp']);
      expect(await readSatisfactoryTlsIdentity(f.db, codec, created.serverId)).toEqual(identity);
    },
  );
});
