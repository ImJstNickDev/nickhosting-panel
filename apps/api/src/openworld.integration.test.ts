import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { Egg, ProvisionPlan } from '@nickhosting/pterodactyl-adapter';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openworldStartup } from '../../../games/openworld/src/dashboard-launch.js';
import { openworldManifest, openworldRuntimeImage } from '../../../games/openworld/src/manifest.js';
import { processServerOperation } from '../../../packages/server-management/src/lifecycle.js';
import {
  listOpenworldReleases,
  readOpenworldInstallTicket,
} from '../../../packages/server-management/src/openworld-catalog.js';
import { createOpenworldModuleRuntime } from '../../../packages/server-management/src/openworld-module.js';
import { setRuntimeMapping } from '../../../packages/server-management/src/registry.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerOpenworldRoutes } from './openworld.js';
import { registerServerRoutes } from './servers.js';

vi.mock('../../../packages/server-management/src/openworld-catalog.js', async (load) => ({
  ...(await load<typeof import('../../../packages/server-management/src/openworld-catalog.js')>()),
  listOpenworldReleases: vi.fn(),
}));
const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 22) } });
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

it.each([
  ['a1.2.9', 'gateway'],
  ['a1.2.8', 'direct'],
] as const)(
  'pins %s in the creation API and selects %s transport with a private dashboard',
  async (version, mode) => {
    const f = await managementFixture(database.db, { interactive: true });
    const env = {
      NH_GATEWAY_ENABLED: 'true',
      NH_GATEWAY_ID: randomUUID(),
      NH_GATEWAY_PHYSICAL_HOST_ID: f.hostId,
      NH_STORAGE_POLICY: 'PER_USER_BUDGET',
      NH_PUBLIC_URL: 'https://panel.test',
    };
    const current = { version, sha256: '6'.repeat(64), size: 1234 };
    vi.mocked(listOpenworldReleases).mockResolvedValue([current]);
    await f.db
      .insertInto('game_integrations')
      .values({ id: 'openworld', version: '1.0.0', manifest: openworldManifest })
      .onConflict((c) => c.column('id').doNothing())
      .execute();
    await f.db
      .insertInto('game_rollouts')
      .values({ integration_id: 'openworld', state: 'public', allowlist: [] })
      .onConflict((c) => c.column('integration_id').doNothing())
      .execute();
    if (mode === 'direct') {
      const pool = (
        await f.db
          .selectFrom('managed_nodes')
          .select('backend_allocation_pool')
          .where('id', '=', f.nodeId)
          .executeTakeFirstOrThrow()
      ).backend_allocation_pool;
      const allocation = f.inventory[0];
      if (!pool || !allocation) throw new Error('Missing fixture allocation');
      allocation.ip = '192.0.2.120';
      pool.allocations[0] = {
        allocationId: allocation.id,
        address: allocation.ip,
        port: allocation.port,
        delivery: 'direct',
        directEndpoint: { hostname: 'instance.test', port: allocation.port },
      };
      await f.db
        .updateTable('managed_nodes')
        .set({ backend_allocation_pool: JSON.stringify(pool) })
        .where('id', '=', f.nodeId)
        .execute();
    }
    const egg = JSON.parse(
      await readFile(
        new URL('../../../games/openworld/egg/egg-openworld.json', import.meta.url),
        'utf8',
      ),
    );
    vi.mocked(f.adapter.getEgg).mockResolvedValue({
      id: 24,
      nest: 5,
      startup: egg.startup,
      config: { stop: egg.config.stop },
      docker_images: egg.docker_images,
      relationships: {
        variables: { object: 'list', data: egg.variables.map((v: unknown) => ({ attributes: v })) },
      },
    } as Egg);
    const mapping = await setRuntimeMapping(f.db, f.adapter, f.owner, {
      gameId: 'openworld',
      runtimeId: 'dedicated',
      nodeId: f.nodeId,
      nestId: 5,
      eggId: 24,
      imageMode: 'integration',
      startup: openworldStartup,
      environment: {},
      portRoles: [
        { role: 'game', primary: true, protocols: ['udp'] },
        {
          role: 'dashboard',
          primary: false,
          protocols: ['tcp'],
          environmentVariable: 'OW_WEB_PORT',
        },
      ],
      featureLimits: { databases: 0, allocations: 2, backups: 1 },
      enabled: true,
    });
    const app = new Hono<{ Variables: Variables }>();
    const options = {
      db: f.db,
      env,
      codec,
      principal: async () => f.context,
      management: async () =>
        ({
          adapter: f.adapter,
          refreshStorage: async () => {},
          refreshObservations: async () => {},
        }) as never,
      acquireUploadSlot: () => () => {},
    };
    registerOpenworldRoutes(app, options);
    registerServerRoutes(app, options);
    const choices = await app.request('/v1/games/openworld/choices');
    expect(await choices.json()).toMatchObject({
      versions: [version],
      mappings: expect.arrayContaining([expect.objectContaining({ mappingId: mapping.id })]),
    });
    const request = f.input({
      mappingId: mapping.id,
      game: { id: 'openworld', configuration: { version } },
    });
    const submit = async () =>
      app.request('/v1/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    const accepted = await submit();
    expect(accepted.status).toBe(202);
    const created = (await accepted.json()) as { serverId: string; jobId: string };
    vi.mocked(listOpenworldReleases).mockRejectedValue(new Error('upstream down'));
    expect(await (await submit()).json()).toEqual(created);
    const row = await f.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', created.serverId)
      .executeTakeFirstOrThrow();
    const allocations = await f.db
      .selectFrom('server_allocations')
      .selectAll()
      .where('server_id', '=', created.serverId)
      .execute();
    expect(row.connection_mode).toBe(mode);
    const dashboard = allocations.find((alloc) => alloc.role === 'dashboard');
    expect(dashboard).toMatchObject({
      private_only: true,
      direct_endpoint: null,
      is_primary: false,
    });
    expect(
      await f.db
        .selectFrom('openworld_server_profiles')
        .selectAll()
        .where('server_id', '=', row.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ server_id: row.id, ...current });
    const gateway = await f.db
      .selectFrom('gateway_routes')
      .selectAll()
      .where('server_id', '=', row.id)
      .execute();
    expect(gateway).toHaveLength(mode === 'gateway' ? 1 : 0);
    if (mode === 'gateway')
      expect(gateway[0]).toMatchObject({
        transport: 'udp',
        allocation_id: allocations.find((alloc) => alloc.is_primary)?.id,
      });
    const operation = await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', created.jobId)
      .executeTakeFirstOrThrow();
    expect(operation.plan.provision).toMatchObject({
      eggId: 24,
      dockerImage: openworldRuntimeImage,
      environment: { OW_VERSION: version, OW_SHA256: current.sha256, OW_WEB_PASSWORD: '' },
    });
    expect(JSON.stringify(operation.plan)).not.toContain('ticket=');
    let handedOff: ProvisionPlan | undefined;
    const adapter = {
      ...f.adapter,
      findServerByExternalId: async () => null,
      createServer: async (plan: ProvisionPlan) => {
        handedOff = plan;
        throw new Error('isolated handoff boundary');
      },
    };
    const module = createOpenworldModuleRuntime(codec, env);
    await processServerOperation(f.db, created.jobId, {
      adapter: adapter as typeof f.adapter,
      env,
      gameInstallerEnvironment: module.installerEnvironment,
      authorizeEffect: async () => {},
      reserveInstallation: async () => {},
    } as Parameters<typeof processServerOperation>[2]).catch(() => {});
    expect(handedOff).toMatchObject({
      environment: {
        OW_WEB_PORT: String(dashboard?.port),
        OW_WEB_PASSWORD: '',
        OW_VERSION: version,
      },
    });
    const ticket = new URL(String(handedOff?.environment.OW_DOWNLOAD_URL)).searchParams.get(
      'ticket',
    );
    expect(readOpenworldInstallTicket(codec, ticket ?? undefined)).toEqual(current);
  },
);
