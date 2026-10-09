import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { GameManifest } from '@nickhosting/game-sdk';
import type { Allocation, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import { vi } from 'vitest';
import { createManagedServer } from './registry.js';

let sequence = 100;
/** A persisted ambiguous upload, without contacting any file provider. */
export async function pendingUploadFixture(db: Kysely<Database>, serverId: string) {
  const server = await db
    .selectFrom('managed_servers as server')
    .innerJoin('managed_nodes as node', 'node.id', 'server.node_id')
    .select(['server.owner_id', 'node.physical_host_id'])
    .where('server.id', '=', serverId)
    .executeTakeFirstOrThrow();
  const claimId = randomUUID();
  await db
    .insertInto('upload_ingestion_claims')
    .values({
      id: claimId,
      physical_host_id: server.physical_host_id,
      server_id: serverId,
      actor_user_id: server.owner_id,
      declared_bytes: '1024',
      reserved_bytes: '67584',
      scope: JSON.stringify({ fixture: true }),
      scope_hash: '0'.repeat(64),
    })
    .execute();
  return claimId;
}
export async function managementFixture(db: Kysely<Database>) {
  const ownerId = 'isolated-platform-owner';
  const userId = randomUUID();
  await sql`insert into "user" (id,name,email,role,"emailVerified") values (${ownerId},'Owner','owner@example.test','owner',true) on conflict(id) do nothing`.execute(
    db,
  );
  await sql`insert into "user" (id,name,email,role,"emailVerified") values (${userId},'User',${`${userId}@example.test`},'user',true)`.execute(
    db,
  );
  const context: AuthContext = {
    actorUserId: userId,
    subjectUserId: userId,
    role: 'user',
    sessionType: 'regular',
    ownerElevation: false,
  };
  const owner: AuthContext = {
    actorUserId: ownerId,
    subjectUserId: ownerId,
    role: 'owner',
    sessionType: 'regular',
    ownerElevation: false,
  };
  const hostId = randomUUID(),
    nodeId = randomUUID(),
    mappingId = randomUUID(),
    gameId = `fixture-${randomUUID()}`;
  const providerNodeId = ++sequence;
  const manifest: GameManifest = {
    id: gameId,
    version: '1.0.0',
    nameKey: `games.${gameId}.name`,
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
        nameKey: `games.${gameId}.runtime`,
        supportedGameVersions: ['1'],
        supports: {},
      },
    ],
    wizard: { steps: [] },
    management: [],
    contentProviders: [],
    localizations: { namespace: `games.${gameId}`, locales: ['en', 'it'] },
  };
  await db
    .insertInto('game_integrations')
    .values({ id: gameId, version: '1.0.0', manifest })
    .execute();
  await db
    .insertInto('game_rollouts')
    .values({ integration_id: gameId, state: 'public', allowlist: [] })
    .execute();
  await db
    .insertInto('physical_hosts')
    .values({
      id: hostId,
      name: 'isolated-test-host',
      memory_limit_mib: 8192,
      cpu_limit_percent: 800,
      storage_pool_mib: '1000000',
      memory_headroom_mib: 256,
      cpu_headroom_percent: 20,
      disk_headroom_mib: '256',
      local_disk_path: '/isolated-fixture',
      observer_id: 'isolated-observer',
    })
    .execute();
  await db
    .insertInto('managed_nodes')
    .values({
      id: nodeId,
      physical_host_id: hostId,
      pterodactyl_node_id: providerNodeId,
      provision_user_id: 1,
    })
    .execute();
  await db
    .insertInto('runtime_egg_mappings')
    .values({
      id: mappingId,
      game_id: gameId,
      runtime_id: 'fixture',
      node_id: nodeId,
      nest_id: 1,
      egg_id: 1,
      docker_image: 'fixture/image:1',
      startup: 'fixture',
      environment: '{}',
      port_roles: JSON.stringify([{ role: 'game', protocols: ['tcp', 'udp'], primary: true }]),
      feature_limits: JSON.stringify({ databases: 0, allocations: 3, backups: 1 }),
    })
    .execute();
  const inventory: Allocation[] = Array.from({ length: 100 }, (_, index) => ({
    id: ++sequence,
    ip: '10.0.0.2',
    port: 20000 + index,
    assigned: false,
  }));
  const backendAllocationPool = {
    allocations: inventory.map((allocation) => ({
      allocationId: allocation.id,
      address: allocation.ip,
      port: allocation.port,
    })),
    gatewayBindAddresses: ['192.0.2.10'],
  };
  await db
    .updateTable('managed_nodes')
    .set({ backend_allocation_pool: JSON.stringify(backendAllocationPool) })
    .where('id', '=', nodeId)
    .execute();
  const adapter = {
    listAllocations: vi.fn(async () => structuredClone(inventory)),
    getNode: vi.fn(async () => ({ id: providerNodeId })),
    listUsers: vi.fn(async () => [{ id: 1 }]),
    getEgg: vi.fn(async () => ({
      id: 1,
      nest: 1,
      docker_image: 'fixture/image:1',
      config: { stop: 'stop' },
      docker_images: { fixture: 'fixture/image:1' },
    })),
  } as unknown as PterodactylAdapter;
  async function observe(patch: Record<string, unknown> = {}, at = new Date()) {
    const snapshot = {
      totalMemoryMiB: 8192,
      availableMemoryMiB: 8192,
      cpuCapacityPercent: 800,
      cpuBusyPercent: 0,
      availableDiskMiB: 1000000,
      managed: {},
      observedAt: at.toISOString(),
      ...patch,
    };
    await db
      .insertInto('host_observations')
      .values({
        host_id: hostId,
        observer_id: 'isolated-observer',
        snapshot: JSON.stringify(snapshot),
        observed_at: at,
      })
      .onConflict((c) =>
        c.column('host_id').doUpdateSet({ snapshot: JSON.stringify(snapshot), observed_at: at }),
      )
      .execute();
  }
  await observe();
  const limits = { memory: 128, cpu: 10, disk: 64, swap: 0, io: 500 };
  const input = (patch: Record<string, unknown> = {}) => ({
    idempotencyKey: randomUUID(),
    mappingId,
    name: 'isolated-server',
    limits,
    autoStart: false,
    ...patch,
  });
  async function server(patch: Record<string, unknown> = {}) {
    const created = await createManagedServer(db, adapter, context, input(patch));
    // A completed fixture provision: external behavior is exercised in lifecycle tests.
    const providerId = ++sequence;
    await db
      .updateTable('managed_servers')
      .set({
        pterodactyl_id: providerId,
        pterodactyl_uuid: randomUUID(),
        pterodactyl_identifier: `fixture${providerId}`,
        installation_state: 'installed',
        runtime_state: 'offline',
        active_operation_id: null,
      })
      .where('id', '=', created.serverId)
      .execute();
    await db
      .updateTable('operation_jobs')
      .set({ state: 'succeeded', completed_at: new Date() })
      .where('id', '=', created.jobId)
      .execute();
    await db
      .updateTable('server_operations')
      .set({ phase: 'complete', effect_state: 'confirmed' })
      .where('job_id', '=', created.jobId)
      .execute();
    await db.deleteFrom('job_outbox').where('job_id', '=', created.jobId).execute();
    return created.serverId;
  }
  return {
    db,
    context,
    owner,
    hostId,
    nodeId,
    mappingId,
    gameId,
    providerNodeId,
    manifest,
    inventory,
    backendAllocationPool,
    adapter,
    observe,
    limits,
    input,
    server,
  };
}
