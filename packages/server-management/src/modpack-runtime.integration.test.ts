import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ApplicationServer } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attestMinecraftRuntimeInstallation } from './minecraft-content.js';
import { requireMinecraftChoice, resolveFabricCreationChoice } from './minecraft-registry.js';
import {
  type ConfigureModpackRuntimeOptions,
  configureModpackRuntime,
  type ModpackRuntimeTransition,
  modpackMappingCompatible,
  resolveModpackRuntime,
} from './modpack-runtime.js';
import { managementFixture } from './test-fixtures.js';

vi.mock('./minecraft-registry.js', async (original) => ({
  ...(await original<typeof import('./minecraft-registry.js')>()),
  requireMinecraftChoice: vi.fn(),
  resolveFabricCreationChoice: vi.fn(),
}));
vi.mock('./minecraft-runtime-evidence.js', async (original) => ({
  ...(await original<typeof import('./minecraft-runtime-evidence.js')>()),
  minecraftProvisionEnvironment: vi.fn(async () => ({
    MC_VERSION: '1.21.1',
    LOADER_VERSION: '0.16.10',
  })),
  assertMinecraftEggEnvironment: vi.fn(async () => {}),
  assertMinecraftRemoteLaunch: vi.fn(async () => {}),
}));
vi.mock('./minecraft-content.js', async (original) => ({
  ...(await original<typeof import('./minecraft-content.js')>()),
  attestMinecraftRuntimeInstallation: vi.fn(async (context) => {
    await context.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: true })
      .where('server_id', '=', context.server.id)
      .execute();
    return { files: [] };
  }),
}));

type Choice = Awaited<ReturnType<typeof requireMinecraftChoice>>;
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(() => {
  vi.clearAllMocks();
});

async function fixture() {
  const f = await managementFixture(database.db, { interactive: true });
  const serverId = await f.server();
  await f.db
    .insertInto('game_integrations')
    .values({ id: 'minecraft', version: '1', manifest: {} })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'minecraft', runtime_id: 'vanilla' })
    .where('id', '=', f.mappingId)
    .execute();
  const source = await f.db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', f.mappingId)
    .executeTakeFirstOrThrow();
  const mappingId = randomUUID();
  await f.db
    .insertInto('runtime_egg_mappings')
    .values({
      ...source,
      id: mappingId,
      runtime_id: 'fabric',
      egg_id: 2,
      startup: 'java fabric.jar',
      docker_image: 'fixture/fabric:21',
      environment: '{}',
      port_roles: JSON.stringify(source.port_roles),
      feature_limits: JSON.stringify(source.feature_limits),
    })
    .execute();
  const mapping = await f.db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', mappingId)
    .executeTakeFirstOrThrow();
  const target = {
    minecraftVersion: '1.21.1',
    loader: 'fabric' as const,
    loaderVersion: '0.16.10',
  };
  const binding = { combinationId: randomUUID(), mappingId, target };
  const sourceCombinationId = randomUUID();
  const choiceMapping = {
    profile: 'fabric',
    release: '1.21.1',
    image: 'fixture/fabric:21',
    imageJavaMajor: 21,
    declaredEggVariables: ['MC_VERSION', 'LOADER_VERSION'],
    bindings: { release: 'MC_VERSION', loaderVersion: 'LOADER_VERSION' },
    fixedVariables: {},
    installationKind: 'fabric-installer',
    artifactPaths: { server: 'server.jar' },
    supportedProperties: [],
  };
  for (const [id, map, combination] of [
    [sourceCombinationId, f.mappingId, { release: '1.21.1', profile: 'vanilla' }],
    [
      binding.combinationId,
      mappingId,
      {
        release: target.minecraftVersion,
        profile: target.loader,
        loaderVersion: target.loaderVersion,
      },
    ],
  ] as const) {
    await f.db
      .insertInto('minecraft_combinations')
      .values({
        id,
        mapping_id: map,
        identity_digest: id.replaceAll('-', '').repeat(2),
        mapping_digest: 'd'.repeat(64),
        combination: JSON.stringify(combination),
        resolved_runtime: '{}',
        binding: JSON.stringify(choiceMapping),
      })
      .execute();
  }
  const row = await f.db
    .selectFrom('minecraft_combinations')
    .selectAll()
    .where('id', '=', binding.combinationId)
    .executeTakeFirstOrThrow();
  const choice = {
    row,
    mapping,
    mappingDigest: 'digest',
    combination: row.combination,
    capabilities: { installation: true, gateway: true },
  } as unknown as Choice;
  vi.mocked(requireMinecraftChoice).mockImplementation(async (_db, _context, id) => {
    if (id !== choice.row.id) throw new Error('Unselected runtime choice');
    return choice;
  });
  vi.mocked(resolveFabricCreationChoice).mockRejectedValue(
    new Error('Unexpected latest-loader lookup'),
  );
  const configuration = {
    properties: { 'level-name': 'existing-world' },
    players: { ops: [{ name: 'KeepMe' }] },
  };
  await f.db
    .insertInto('minecraft_server_profiles')
    .values({
      server_id: serverId,
      combination_id: sourceCombinationId,
      configuration: JSON.stringify(configuration),
      installed: true,
    })
    .execute();
  const server = await f.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow();
  const allocations = await f.db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', serverId)
    .execute();
  let remote = {
    id: server.pterodactyl_id,
    uuid: server.pterodactyl_uuid,
    identifier: server.pterodactyl_identifier,
    external_id: server.external_id,
    node: f.providerNodeId,
    user: server.provider_user_id,
    allocation: allocations.find((a) => a.is_primary)?.pterodactyl_allocation_id,
    egg: source.egg_id,
    container: { image: source.docker_image, startup_command: source.startup, environment: {} },
    relationships: {
      allocations: {
        data: allocations.map((a) => ({
          attributes: {
            id: a.pterodactyl_allocation_id,
            assigned: true,
            ip: a.address,
            port: a.port,
          },
        })),
      },
    },
  } as unknown as ApplicationServer;
  const adapter = {
    ...f.adapter,
    getApplicationServer: vi.fn(async () => structuredClone(remote)),
    updateStartup: vi.fn(async (_id, value) => {
      remote = {
        ...remote,
        egg: value.egg,
        container: {
          ...remote.container,
          image: value.image,
          startup_command: value.startup,
          environment: value.environment,
        },
      };
      return structuredClone(remote);
    }),
    reinstallWithConfirmation: vi.fn(async (_id, _identifier, options) => {
      if (!(await options.authorize())) throw new Error('Authority refused');
      await options.onConfirmed();
      return { confirmed: true };
    }),
  } as unknown as typeof f.adapter;
  const operation = await f.db
    .selectFrom('server_operations')
    .select('job_id')
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
  let journal: ModpackRuntimeTransition | null = null;
  const states: string[] = [];
  const options: ConfigureModpackRuntimeOptions = {
    db: f.db,
    adapter,
    serverId,
    operationId: operation.job_id,
    context: f.context,
    binding,
    readTransition: async () => journal,
    saveTransition: async (value) => {
      journal = structuredClone(value);
      states.push(value.state);
    },
    authorize: vi.fn(async () => {}),
    assertStopped: vi.fn(async () => {}),
    contentOptions: {},
  };
  return {
    ...f,
    serverId,
    source,
    mapping,
    allocations,
    binding,
    choice,
    sourceCombinationId,
    configuration,
    adapter,
    options,
    states,
    journal: () => journal,
    changeRemote: (patch: Partial<ApplicationServer>) => {
      remote = { ...remote, ...patch };
    },
  };
}

describe('Modpacks exact supported runtime transition', () => {
  it('selects the exact existing loader and never consults a latest-loader choice', async () => {
    const f = await fixture();
    expect(await resolveModpackRuntime({ ...f.options, target: f.binding.target })).toEqual(
      f.binding,
    );
    expect(resolveFabricCreationChoice).not.toHaveBeenCalled();
    expect(requireMinecraftChoice).toHaveBeenCalledTimes(2);
  });
  it('blocks undeclared Forge/NeoForge without resolving any combination', async () => {
    const f = await fixture();
    for (const loader of ['forge', 'neoforge'] as const)
      expect(
        await resolveModpackRuntime({ ...f.options, target: { ...f.binding.target, loader } }),
      ).toBeNull();
    expect(requireMinecraftChoice).not.toHaveBeenCalled();
  });
  it('rejects mappings that would change the node, port roles, protocols, or allocation limits', async () => {
    const f = await fixture();
    const server = { node_id: f.nodeId };
    expect(modpackMappingCompatible(server, f.source, f.mapping, f.allocations)).toBe(true);
    expect(
      modpackMappingCompatible(
        server,
        f.source,
        { ...f.mapping, node_id: randomUUID() },
        f.allocations,
      ),
    ).toBe(false);
    expect(
      modpackMappingCompatible(server, f.source, { ...f.mapping, port_roles: [] }, f.allocations),
    ).toBe(false);
    expect(
      modpackMappingCompatible(
        server,
        f.source,
        { ...f.mapping, port_roles: [{ role: 'game', protocols: ['tcp'], primary: true }] },
        f.allocations,
      ),
    ).toBe(false);
    expect(
      modpackMappingCompatible(
        server,
        f.source,
        { ...f.mapping, feature_limits: { ...f.mapping.feature_limits, allocations: 99 } },
        f.allocations,
      ),
    ).toBe(false);
  });
  it('journals one installer and preserves settings, player ACLs, node and owned ports', async () => {
    const f = await fixture();
    await configureModpackRuntime(f.options);
    expect(f.states).toEqual([
      'planned',
      'startup-dispatched',
      'startup-confirmed',
      'installation-dispatched',
      'installation-confirmed',
      'verified',
    ]);
    const profile = await f.db
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    expect(profile).toMatchObject({
      combination_id: f.binding.combinationId,
      configuration: f.configuration,
      installed: true,
    });
    const server = await f.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    expect(server).toMatchObject({
      node_id: f.nodeId,
      mapping_id: f.mapping.id,
      installation_state: 'installed',
    });
    expect(
      await f.db
        .selectFrom('server_allocations')
        .selectAll()
        .where('server_id', '=', f.serverId)
        .execute(),
    ).toEqual(f.allocations);
    expect(f.adapter.updateStartup).toHaveBeenCalledWith(
      server.pterodactyl_id,
      expect.objectContaining({
        environment: { MC_VERSION: '1.21.1', LOADER_VERSION: '0.16.10' },
        skip_scripts: false,
      }),
    );
    await configureModpackRuntime(f.options);
    expect(f.adapter.updateStartup).toHaveBeenCalledTimes(1);
    expect(f.adapter.reinstallWithConfirmation).toHaveBeenCalledTimes(1);
    expect(attestMinecraftRuntimeInstallation).toHaveBeenCalledTimes(1);
  });
  it('never repeats an installer when its dispatched outcome is ambiguous', async () => {
    const f = await fixture();
    vi.mocked(f.adapter.reinstallWithConfirmation).mockRejectedValue(new Error('Connection lost'));
    await expect(configureModpackRuntime(f.options)).rejects.toThrow('Connection lost');
    expect(f.journal()?.state).toBe('installation-dispatched');
    await expect(configureModpackRuntime(f.options)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect(f.adapter.reinstallWithConfirmation).toHaveBeenCalledTimes(1);
    expect(attestMinecraftRuntimeInstallation).not.toHaveBeenCalled();
  });
  it('refreshes the existing Gateway generation/version while preserving Owner policy', async () => {
    const f = await fixture();
    await f.db
      .updateTable('managed_servers')
      .set({ connection_mode: 'gateway' })
      .where('id', '=', f.serverId)
      .execute();
    const generation = randomUUID();
    await f.db
      .insertInto('gateway_server_states')
      .values({
        server_id: f.serverId,
        generation,
        enabled: false,
        protocol_id: 'minecraft-java',
        game_version: '1.20.1',
        state: 'online',
        idle_timeout_seconds: 123,
        idle_timeout_inherited: false,
        owner_idle_timeout_seconds: 456,
        owner_auto_wake_override: false,
        readiness_timeout_seconds: 321,
        readiness_max_age_seconds: 20,
        estimate_max_age_seconds: 500,
        wake_retry_seconds: 9,
        wake_job_id: null,
        sleep_job_id: null,
        process_started_at: '2026-01-01T00:00:00Z',
        readiness_observed_at: new Date(),
        startup_deadline_at: null,
        idle_since: new Date(),
        last_observed_at: new Date(),
        last_activity_at: new Date(),
        blocked_until: null,
        error_code: null,
      })
      .execute();
    await configureModpackRuntime(f.options);
    const policy = await f.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    expect(policy.generation).not.toBe(generation);
    expect(policy).toMatchObject({
      game_version: '1.21.1',
      enabled: false,
      idle_timeout_seconds: 123,
      owner_idle_timeout_seconds: 456,
      owner_auto_wake_override: false,
      readiness_timeout_seconds: 321,
      process_started_at: null,
      readiness_observed_at: null,
      idle_since: null,
    });
    await configureModpackRuntime(f.options);
    expect(
      (
        await f.db
          .selectFrom('gateway_server_states')
          .select('generation')
          .where('server_id', '=', f.serverId)
          .executeTakeFirstOrThrow()
      ).generation,
    ).toBe(policy.generation);
  });
  it('requires persisted confirmation even when the adapter returns confirmed', async () => {
    const f = await fixture();
    vi.mocked(f.adapter.reinstallWithConfirmation).mockResolvedValue({ confirmed: true } as never);
    await expect(configureModpackRuntime(f.options)).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect(f.journal()?.state).toBe('installation-dispatched');
    expect(attestMinecraftRuntimeInstallation).not.toHaveBeenCalled();
  });
  it('reserves installer capacity before changing provider startup', async () => {
    const f = await fixture();
    await f.observe({ availableMemoryMiB: 0 });
    await expect(configureModpackRuntime(f.options)).rejects.toMatchObject({
      code: 'resources_unavailable',
    });
    expect(f.adapter.updateStartup).not.toHaveBeenCalled();
    expect(f.adapter.reinstallWithConfirmation).not.toHaveBeenCalled();
  });
  it('refuses mismatched provider identity and does not change any runtime', async () => {
    const f = await fixture();
    f.changeRemote({ node: f.providerNodeId + 1 });
    await expect(configureModpackRuntime(f.options)).rejects.toMatchObject({
      code: 'provenance_mismatch',
    });
    expect(f.adapter.updateStartup).not.toHaveBeenCalled();
    expect(f.adapter.reinstallWithConfirmation).not.toHaveBeenCalled();
  });
});
