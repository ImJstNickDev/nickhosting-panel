import { randomUUID } from 'node:crypto';
import { type AuthContext, authSessionId } from '@nickhosting/core';
import { recordAudit } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import { minecraftDigest, minecraftManifest } from '@nickhosting/minecraft';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUserLimits } from './admission.js';
import { setGatewayPolicy } from './gateway-orchestration.js';
import { minecraftMappingDigest } from './minecraft-registry.js';
import {
  deletePlatformProject,
  getPlatformConnections,
  getPlatformJob,
  getPlatformProject,
  getPlatformQuota,
  getPlatformServer,
  getPlatformSleepPolicy,
  getPlatformTransfers,
  getPlatformUser,
  listPlatformActivity,
  listPlatformAudit,
  listPlatformGames,
  listPlatformMetrics,
  listPlatformProjects,
  listPlatformServers,
  listPlatformUsers,
  lookupProjectCollaborator,
  retryPlatformJob,
  updatePlatformProject,
  updatePlatformServer,
} from './platform-queries.js';
import { createProject, enqueueServerOperation, setProjectMember } from './registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
});
afterAll(async () => {
  await database?.destroy();
});
async function peer() {
  return managementFixture(f.db, { interactive: true });
}

async function installedMinecraft() {
  const id = await f.server();
  await f.db
    .insertInto('game_integrations')
    .values({
      id: 'minecraft',
      version: minecraftManifest.version,
      manifest: minecraftManifest,
    })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'minecraft', runtime_id: 'vanilla' })
    .where('id', '=', f.mappingId)
    .execute();
  const mapping = await f.db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', f.mappingId)
    .executeTakeFirstOrThrow();
  const combination = {
    release: '26.1',
    releaseType: 'release',
    protocolId: 775,
    family: 'netty',
    transfer: true,
    profile: 'vanilla',
    javaMajor: 25,
    runtimeDigest: 'a'.repeat(64),
    protocolSource: { url: 'https://example.test/fixture', sha256: 'b'.repeat(64) },
  };
  const choiceId = randomUUID();
  await f.db
    .insertInto('minecraft_combinations')
    .values({
      id: choiceId,
      mapping_id: f.mappingId,
      combination: JSON.stringify(combination),
      resolved_runtime: '{}',
      binding: '{}',
      mapping_digest: minecraftMappingDigest(mapping),
      identity_digest: minecraftDigest(combination),
      enabled: false,
    })
    .execute();
  await f.db
    .insertInto('minecraft_server_profiles')
    .values({ server_id: id, combination_id: choiceId, configuration: '{}', installed: true })
    .execute();
  return { id, choiceId, combination };
}

describe('initial sleep policy proposal', () => {
  it('reads a compiled installed binding without writes and saves only through the explicit policy action', async () => {
    const { id } = await installedMinecraft();
    const before = await f.db
      .selectFrom('managed_servers')
      .select(['intent', 'readiness'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const proposal = await getPlatformSleepPolicy(f.db, f.context, id);
    expect(proposal).toMatchObject({
      policy: null,
      state: null,
      proposedPolicy: {
        protocolId: 'minecraft-java',
        gameVersion: '26.1',
        enabled: false,
        idleTimeoutSeconds: null,
        mode: 'manually_stopped',
      },
    });
    expect(
      await f.db
        .selectFrom('gateway_server_states')
        .select('server_id')
        .where('server_id', '=', id)
        .execute(),
    ).toEqual([]);
    expect(
      await f.db
        .selectFrom('managed_servers')
        .select(['intent', 'readiness'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    await setGatewayPolicy(f.db, f.context, id, proposal.proposedPolicy, { initializeOnly: true });
    const saved = await getPlatformSleepPolicy(f.db, f.context, id);
    expect(saved.proposedPolicy).toBeNull();
    expect(saved.policy).toEqual(proposal.proposedPolicy);
    expect(saved.state).toMatchObject({ enabled: false, state: 'manually_stopped' });
    await expect(getPlatformSleepPolicy(f.db, (await peer()).context, id)).rejects.toThrow();
  });
  it('initializes once under concurrent requests and cannot overwrite an existing policy', async () => {
    const { id } = await installedMinecraft();
    const proposal = (await getPlatformSleepPolicy(f.db, f.context, id)).proposedPolicy;
    const results = await Promise.allSettled(
      [1, 2].map(() => setGatewayPolicy(f.db, f.context, id, proposal, { initializeOnly: true })),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const before = await f.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', id)
      .executeTakeFirstOrThrow();
    await expect(
      setGatewayPolicy(f.db, f.context, id, proposal, { initializeOnly: true }),
    ).rejects.toThrow('conflict');
    expect(
      await f.db
        .selectFrom('gateway_server_states')
        .selectAll()
        .where('server_id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
  });
  it('rechecks maintenance, active operations and disabled defaults at initialization', async () => {
    const { id } = await installedMinecraft();
    const proposal = (await getPlatformSleepPolicy(f.db, f.context, id)).proposedPolicy;
    await f.db
      .updateTable('managed_servers')
      .set({ intent: 'maintenance' })
      .where('id', '=', id)
      .execute();
    await expect(
      setGatewayPolicy(f.db, f.context, id, proposal, { initializeOnly: true }),
    ).rejects.toThrow('conflict');
    const fresh = (await getPlatformSleepPolicy(f.db, f.context, id)).proposedPolicy;
    expect(fresh?.mode).toBe('maintenance');
    for (const patch of [{ enabled: true }, { idleTimeoutSeconds: 60 }, { mode: 'auto' }])
      await expect(
        setGatewayPolicy(f.db, f.context, id, { ...fresh, ...patch }, { initializeOnly: true }),
      ).rejects.toThrow('validation_failed');
    const job = await f.db
      .selectFrom('server_operations')
      .select('job_id')
      .where('server_id', '=', id)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: job.job_id })
      .where('id', '=', id)
      .execute();
    await expect(
      setGatewayPolicy(f.db, f.context, id, fresh, { initializeOnly: true }),
    ).rejects.toThrow('conflict');
    expect(
      await f.db
        .selectFrom('gateway_server_states')
        .select('server_id')
        .where('server_id', '=', id)
        .execute(),
    ).toEqual([]);
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null })
      .where('id', '=', id)
      .execute();
    await setGatewayPolicy(f.db, f.context, id, fresh, { initializeOnly: true });
    expect((await getPlatformSleepPolicy(f.db, f.context, id)).state?.state).toBe('maintenance');
  });
  it('does not propose automation for uninstalled, direct, stale or undeclared combinations', async () => {
    const { id, choiceId, combination } = await installedMinecraft();
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: false })
      .where('server_id', '=', id)
      .execute();
    expect((await getPlatformSleepPolicy(f.db, f.context, id)).proposedPolicy).toBeNull();
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: true })
      .where('server_id', '=', id)
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ connection_mode: 'direct' })
      .where('id', '=', id)
      .execute();
    expect((await getPlatformSleepPolicy(f.db, f.context, id)).proposedPolicy).toBeNull();
    await f.db
      .updateTable('managed_servers')
      .set({ connection_mode: 'gateway' })
      .where('id', '=', id)
      .execute();
    await f.db
      .updateTable('minecraft_combinations')
      .set({ combination: JSON.stringify({ ...combination, family: 'unknown', protocolId: null }) })
      .where('id', '=', choiceId)
      .execute();
    expect((await getPlatformSleepPolicy(f.db, f.context, id)).proposedPolicy).toBeNull();
    await f.db
      .updateTable('minecraft_combinations')
      .set({ combination: JSON.stringify(combination), mapping_digest: '0'.repeat(64) })
      .where('id', '=', choiceId)
      .execute();
    expect((await getPlatformSleepPolicy(f.db, f.context, id)).proposedPolicy).toBeNull();
  });
});

describe('M5 platform browser queries and metadata', () => {
  it('exposes the authoritative creation storage policy and Owner default', async () => {
    const shared = await getPlatformQuota(f.db, f.context, f.context.subjectUserId, {
      NH_DEFAULT_SERVER_STORAGE_MIB: '8192',
    });
    expect(shared.creationStorage).toEqual({ mode: 'shared', defaultDiskMiB: 0 });
    const personal = await getPlatformQuota(f.db, f.context, f.context.subjectUserId, {
      NH_STORAGE_POLICY: 'PER_USER_BUDGET',
    });
    expect(personal.creationStorage).toEqual({ mode: 'limited', defaultDiskMiB: 4096 });
  });
  it('keeps Home disk usage across worker polling gaps and expires the oldest contributor at 30 seconds', async () => {
    const ids = await Promise.all([f.server(), f.server()]);
    const at = Date.now();
    for (const [index, id] of ids.entries()) {
      await f.db.deleteFrom('server_metrics').where('server_id', '=', id).execute();
      await f.db
        .insertInto('server_metrics')
        .values({
          server_id: id,
          observed_at: new Date(at + index * 1000),
          disk_bytes: String((index + 1) * 1048576),
          memory_bytes: '0',
          cpu_percent: 0,
          network_rx_bytes: '0',
          network_tx_bytes: '0',
        })
        .execute();
    }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at + 5000);
    try {
      const quota = await getPlatformQuota(f.db, f.context, undefined, {
        NH_OBSERVATION_MAX_AGE_SECONDS: '4',
      });
      const expected = { bytes: 3 * 1048576, expiresAt: new Date(at + 30000).toISOString() };
      expect(quota.storageUsage).toEqual(expected);
      expect(quota.measured.some((sample) => sample.stale)).toBe(true);
      clock.mockReturnValue(at + 29999);
      expect((await getPlatformQuota(f.db, f.context)).storageUsage).toEqual(expected);
      clock.mockReturnValue(at + 30000);
      expect((await getPlatformQuota(f.db, f.context)).storageUsage).toEqual({
        bytes: null,
        expiresAt: null,
      });
    } finally {
      clock.mockRestore();
    }
  });
  it('does not invent Home disk totals for missing, negative, future or unsafe measurements', async () => {
    expect((await getPlatformQuota(f.db, f.context)).storageUsage).toEqual({
      bytes: 0,
      expiresAt: null,
    });
    const id = await f.server();
    await f.db.deleteFrom('server_metrics').where('server_id', '=', id).execute();
    const unknown = { bytes: null, expiresAt: null };
    expect((await getPlatformQuota(f.db, f.context)).storageUsage).toEqual(unknown);
    const metric = {
      server_id: id,
      observed_at: new Date(),
      disk_bytes: '-1',
      memory_bytes: '0',
      cpu_percent: 0,
      network_rx_bytes: '0',
      network_tx_bytes: '0',
    };
    // The authoritative store rejects negative measurements before they can be displayed.
    await expect(f.db.insertInto('server_metrics').values(metric).execute()).rejects.toMatchObject({
      code: '23514',
    });
    expect((await getPlatformQuota(f.db, f.context)).storageUsage).toEqual(unknown);
    await f.db
      .insertInto('server_metrics')
      .values({ ...metric, observed_at: new Date(Date.now() + 60000), disk_bytes: '1' })
      .execute();
    expect((await getPlatformQuota(f.db, f.context)).storageUsage).toEqual(unknown);
    await f.db
      .updateTable('server_metrics')
      .set({ observed_at: new Date(), disk_bytes: '9007199254740992' })
      .where('server_id', '=', id)
      .execute();
    expect((await getPlatformQuota(f.db, f.context)).storageUsage).toEqual(unknown);
    await f.db
      .updateTable('server_metrics')
      .set({ disk_bytes: String(Number.MAX_SAFE_INTEGER) })
      .where('server_id', '=', id)
      .execute();
    const second = await f.server();
    await f.db.deleteFrom('server_metrics').where('server_id', '=', second).execute();
    await f.db
      .insertInto('server_metrics')
      .values({ ...metric, server_id: second, observed_at: new Date(), disk_bytes: '1' })
      .execute();
    expect((await getPlatformQuota(f.db, f.context)).storageUsage).toEqual(unknown);
  });
  it('paginates scoped servers without duplicates or timestamp precision omissions, validates filters, treats wildcard search literally', async () => {
    const ids = await Promise.all([
      f.server({ name: 'A_100%' }),
      f.server({ name: 'A_100%' }),
      f.server({ name: 'Elsewhere' }),
    ]);
    const other = await peer();
    await other.server({ name: 'A_100%' });
    await sql`update managed_servers set created_at='2026-01-01T00:00:00.123456Z' where owner_id=${f.context.subjectUserId}`.execute(
      f.db,
    );
    let after: string | null = null;
    const found: string[] = [];
    do {
      const page = await listPlatformServers(f.db, f.context, {
        limit: 1,
        ...(after ? { cursor: after } : {}),
      });
      found.push(...page.items.map((r) => r.id));
      after = page.nextCursor;
    } while (after);
    expect(found.sort()).toEqual(ids.sort());
    expect(
      (
        await listPlatformServers(f.db, f.context, {
          q: '_100%',
          state: 'offline',
          gameId: f.gameId,
        })
      ).items,
    ).toHaveLength(2);
    await expect(listPlatformServers(f.db, f.context, { cursor: 'invalid' })).rejects.toThrow(
      'validation_failed',
    );
    const malformedUuid = Buffer.from(
      JSON.stringify({ at: new Date().toISOString(), id: 'not-a-uuid' }),
    ).toString('base64url');
    for (const list of [listPlatformServers, listPlatformProjects, listPlatformActivity]) {
      await expect(list(f.db, f.context, { cursor: malformedUuid })).rejects.toMatchObject({
        code: 'validation_failed',
      });
    }
    // Identity/audit IDs are text columns. Their opaque cursors remain valid.
    await expect(
      listPlatformUsers(f.db, f.owner, { cursor: malformedUuid }),
    ).resolves.toHaveProperty('items');
    await expect(
      listPlatformAudit(f.db, f.owner, { cursor: malformedUuid }),
    ).resolves.toHaveProperty('items');
    await expect(listPlatformServers(f.db, f.context, { limit: 101 })).rejects.toThrow(
      'validation_failed',
    );
    expect(JSON.stringify(await listPlatformServers(f.db, f.context))).not.toMatch(
      /pterodactyl|external_id|startup|docker_image|environment|10\.0\.0\.2/,
    );
  });
  it('paginates filtered inventories and returns scoped facets without foreign identities', async () => {
    const project = await createProject(f.db, f.context, { name: 'Browser group' });
    const ids = await Promise.all([
      f.server({ name: 'Browser A', projectId: project.id }),
      f.server({ name: 'Browser B', projectId: project.id }),
      f.server({ name: 'Browser C' }),
    ]);
    const foreign = await peer();
    const foreignId = await foreign.server({ name: 'Browser foreign' });
    await f.db
      .updateTable('managed_servers')
      .set({ runtime_state: 'running' })
      .where('id', '=', ids[0] ?? '')
      .execute();
    const first = await listPlatformServers(f.db, f.context, { page: 1, limit: 2 });
    const second = await listPlatformServers(f.db, f.context, { page: 2, limit: 2 });
    expect(first).toMatchObject({ total: 3, page: 1, totalPages: 2 });
    expect(second).toMatchObject({ total: 3, page: 2, totalPages: 2 });
    expect([...first.items, ...second.items].map((row) => row.id).sort()).toEqual(ids.sort());
    expect(first.filterOptions).toEqual({
      games: [{ id: f.gameId, nameKey: `games.${f.gameId}.name` }],
      runtimes: ['fixture'],
      versions: [],
      projects: [{ id: project.id, name: 'Browser group' }],
      owners: [],
    });
    const filtered = await listPlatformServers(f.db, f.context, {
      q: 'Browser',
      gameId: f.gameId,
      runtimeId: 'fixture',
      projectId: project.id,
      ownerId: f.context.subjectUserId,
      state: 'running',
      page: 8,
      limit: 1,
    });
    expect(filtered).toMatchObject({ total: 1, page: 1, totalPages: 1 });
    expect(filtered.items).toHaveLength(1);
    expect((await listPlatformServers(f.db, f.context, { runtimeId: 'missing' })).total).toBe(0);
    expect((await listPlatformServers(f.db, f.context, { projectId: 'none' })).total).toBe(1);
    expect(
      (await listPlatformServers(f.db, f.context, { ownerId: foreign.context.subjectUserId }))
        .total,
    ).toBe(0);
    await expect(listPlatformServers(f.db, f.context, { scope: 'others' })).rejects.toThrow(
      'forbidden',
    );
    await expect(
      listPlatformServers(f.db, f.context, { page: 1, cursor: first.nextCursor }),
    ).rejects.toThrow('validation_failed');
    await f.db
      .updateTable('managed_servers')
      .set({ owner_id: f.owner.subjectUserId })
      .where('id', '=', foreignId)
      .execute();
    const mine = await listPlatformServers(f.db, f.owner, { scope: 'mine' });
    expect(mine.items.map((row) => row.id)).toContain(foreignId);
    expect(mine.filterOptions.owners).toEqual([]);
    const others = await listPlatformServers(f.db, f.owner, {
      scope: 'others',
      ownerId: f.context.subjectUserId,
    });
    expect(others.items.map((row) => row.id).sort()).toEqual(ids.sort());
    expect(others.filterOptions.owners).toContainEqual({
      id: f.context.subjectUserId,
      name: 'User',
    });
    expect(others.filterOptions.owners.map((row) => row.id)).not.toContain(f.owner.subjectUserId);
    expect(JSON.stringify(others.filterOptions)).not.toContain('@example.test');
  });
  it('combines selected owners with other filters and paginates without broadening authority', async () => {
    const other = await peer();
    const ids = [
      await f.server({ name: 'Selected fleet A' }),
      await other.server({ name: 'Selected fleet B' }),
    ];
    await other.server({ name: 'Unmatched name' });
    const outsiders = await peer();
    await outsiders.server({ name: 'Selected fleet private' });
    const ownerIds = [
      f.context.subjectUserId,
      other.context.subjectUserId,
      f.context.subjectUserId,
    ];
    const filters = { scope: 'others', ownerIds, q: 'Selected fleet', state: 'offline', limit: 1 };
    const first = await listPlatformServers(f.db, f.owner, { ...filters, page: 1 });
    const second = await listPlatformServers(f.db, f.owner, { ...filters, page: 2 });
    expect(first).toMatchObject({ total: 2, totalPages: 2, page: 1 });
    expect(second).toMatchObject({ total: 2, totalPages: 2, page: 2 });
    expect([...first.items, ...second.items].map((server) => server.id).sort()).toEqual(ids.sort());
    const narrowed = await listPlatformServers(f.db, f.owner, {
      ...filters,
      gameId: f.gameId,
      runtimeId: 'fixture',
    });
    expect(narrowed.total).toBe(1);
    expect(narrowed.items[0]?.ownerId).toBe(f.context.subjectUserId);
    const ordinary = await listPlatformServers(f.db, f.context, { ownerIds, q: 'Selected fleet' });
    expect(ordinary.total).toBe(1);
    expect(ordinary.items[0]?.ownerId).toBe(f.context.subjectUserId);
    expect(ordinary.filterOptions.owners).toEqual([]);
    expect(ordinary.filterOptions.games.map((game) => game.id)).toEqual([f.gameId]);
    expect(
      (
        await listPlatformServers(f.db, f.owner, {
          ...filters,
          ownerIds: [outsiders.context.subjectUserId],
        })
      ).total,
    ).toBe(1);
    expect(
      (await listPlatformServers(f.db, f.owner, { ownerId: other.context.subjectUserId })).total,
    ).toBe(2);
  });
  it('validates owner arrays and rejects mixing legacy and multi-owner filters', async () => {
    for (const input of [
      { ownerIds: [] },
      { ownerIds: [''] },
      { ownerIds: ['x'.repeat(129)] },
      { ownerIds: Array.from({ length: 101 }, () => 'same') },
      { ownerIds: 'one' },
      { ownerIds: [null] },
      { ownerIds: ['one'], ownerId: 'one' },
    ])
      await expect(listPlatformServers(f.db, f.owner, input)).rejects.toThrow('validation_failed');
  });
  it('keeps collaborator visibility while mine excludes shared servers and uses installed releases only', async () => {
    const { id, choiceId } = await installedMinecraft();
    const other = await peer();
    const project = await createProject(f.db, f.context, { name: 'Shared browser group' });
    await f.db
      .updateTable('managed_servers')
      .set({ project_id: project.id })
      .where('id', '=', id)
      .execute();
    await setProjectMember(f.db, f.context, project.id, {
      userId: other.context.subjectUserId,
      role: 'viewer',
    });
    const visible = await listPlatformServers(f.db, other.context, {
      gameId: 'minecraft',
      runtimeId: 'vanilla',
      version: '26.1',
    });
    expect(visible.items.map((row) => row.id)).toEqual([id]);
    expect(visible.filterOptions.versions).toEqual(['26.1']);
    expect((await listPlatformServers(f.db, other.context, { scope: 'mine' })).items).toEqual([]);
    expect(
      (await listPlatformServers(f.db, other.context, { gameId: 'missing' })).filterOptions
        .versions,
    ).toEqual([]);
    expect(
      (await listPlatformServers(f.db, other.context, { runtimeId: 'missing' })).filterOptions
        .versions,
    ).toEqual([]);
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: false })
      .where('server_id', '=', id)
      .execute();
    expect((await listPlatformServers(f.db, other.context, { version: '26.1' })).total).toBe(0);
    expect((await listPlatformServers(f.db, other.context)).filterOptions.versions).toEqual([]);
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: true })
      .where('server_id', '=', id)
      .execute();
    await f.db
      .updateTable('minecraft_combinations')
      .set({ mapping_id: other.mappingId })
      .where('id', '=', choiceId)
      .execute();
    expect((await listPlatformServers(f.db, other.context)).filterOptions.versions).toEqual([]);
  });
  it('describes the installed runtime and release without presenting uninstalled or mismatched profiles', async () => {
    const { id, choiceId, combination } = await installedMinecraft();
    const expected = {
      runtimeId: 'vanilla',
      runtimeNameKey: 'games.minecraft.runtimes.vanilla',
      version: '26.1',
    };
    expect(await getPlatformServer(f.db, f.context, id)).toMatchObject(expected);
    expect(
      (await listPlatformServers(f.db, f.context)).items.find((server) => server.id === id),
    ).toMatchObject(expected);
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ runtime_id: 'fabric' })
      .where('id', '=', f.mappingId)
      .execute();
    await f.db
      .updateTable('minecraft_combinations')
      .set({
        combination: JSON.stringify({ ...combination, release: '1.21.11', profile: 'fabric' }),
      })
      .where('id', '=', choiceId)
      .execute();
    const replacement = {
      runtimeId: 'fabric',
      runtimeNameKey: 'games.minecraft.runtimes.fabric',
      version: '1.21.11',
    };
    expect(await getPlatformServer(f.db, f.context, id)).toMatchObject(replacement);
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: false })
      .where('server_id', '=', id)
      .execute();
    expect(await getPlatformServer(f.db, f.context, id)).toMatchObject({
      ...replacement,
      version: null,
    });
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: true })
      .where('server_id', '=', id)
      .execute();
    const other = await peer();
    await f.db
      .updateTable('minecraft_combinations')
      .set({ mapping_id: other.mappingId })
      .where('id', '=', choiceId)
      .execute();
    expect(await getPlatformServer(f.db, f.context, id)).toMatchObject({
      ...replacement,
      version: null,
    });
    const unrelated = await other.server();
    expect(await getPlatformServer(f.db, other.context, unrelated)).toMatchObject({
      version: null,
    });
  });
  it('exposes configured wake without claiming live readiness or ignoring disabled scopes', async () => {
    const { id } = await installedMinecraft();
    const env = {
      NH_GATEWAY_ENABLED: 'true',
      NH_GATEWAY_ID: randomUUID(),
      NH_GATEWAY_PHYSICAL_HOST_ID: f.hostId,
    };
    await f.db
      .updateTable('managed_servers')
      .set({ intent: 'auto_wake_enabled', connection_mode: 'gateway' })
      .where('id', '=', id)
      .execute();
    expect((await getPlatformServer(f.db, f.context, id, env)).wakeEnabled).toBe(false);
    await sql`insert into gateway_server_states
      (server_id,generation,enabled,protocol_id,game_version,state,readiness_timeout_seconds,readiness_max_age_seconds,estimate_max_age_seconds,wake_retry_seconds)
      values (${id},${randomUUID()},true,'minecraft-java','26.1','sleeping',50,10,3600,30)`.execute(
      f.db,
    );
    expect((await getPlatformServer(f.db, f.context, id, env)).wakeEnabled).toBe(true);
    expect(
      await updatePlatformServer(f.db, f.context, id, { name: 'Wake metadata' }, env),
    ).toMatchObject({ name: 'Wake metadata', wakeEnabled: true });
    expect(
      (await listPlatformServers(f.db, f.context, {}, env)).items.find((server) => server.id === id)
        ?.wakeEnabled,
    ).toBe(true);
    expect(
      (await getPlatformServer(f.db, f.context, id, { ...env, NH_GATEWAY_ENABLED: 'false' }))
        .wakeEnabled,
    ).toBe(false);
    expect(
      (await getPlatformServer(f.db, f.context, id, { NH_GATEWAY_ENABLED: 'true' })).wakeEnabled,
    ).toBe(false);
    await f.db
      .updateTable('gateway_server_states')
      .set({ enabled: false })
      .where('server_id', '=', id)
      .execute();
    expect((await getPlatformServer(f.db, f.context, id, env)).wakeEnabled).toBe(false);
    await f.db
      .updateTable('gateway_server_states')
      .set({ enabled: true, state: 'blocked', blocked_until: new Date(Date.now() + 60000) })
      .where('server_id', '=', id)
      .execute();
    // A temporary admission block does not disable the configured wake policy.
    expect(await getPlatformServer(f.db, f.context, id, env)).toMatchObject({
      wakeEnabled: true,
      sleepState: 'blocked',
    });
    for (const intent of ['manually_stopped', 'maintenance'] as const) {
      await f.db.updateTable('managed_servers').set({ intent }).where('id', '=', id).execute();
      expect((await getPlatformServer(f.db, f.context, id, env)).wakeEnabled).toBe(false);
    }
    await f.db
      .updateTable('managed_servers')
      .set({ intent: 'auto_wake_enabled', connection_mode: 'direct' })
      .where('id', '=', id)
      .execute();
    expect((await getPlatformServer(f.db, f.context, id, env)).wakeEnabled).toBe(false);
    await f.db
      .updateTable('managed_servers')
      .set({ connection_mode: 'gateway' })
      .where('id', '=', id)
      .execute();
    await f.db
      .updateTable('game_integrations')
      .set({
        manifest: {
          ...minecraftManifest,
          capabilities: { ...minecraftManifest.capabilities, wake: 'unsupported' },
        },
      })
      .where('id', '=', 'minecraft')
      .execute();
    try {
      expect((await getPlatformServer(f.db, f.context, id, env)).wakeEnabled).toBe(false);
    } finally {
      await f.db
        .updateTable('game_integrations')
        .set({ manifest: minecraftManifest })
        .where('id', '=', 'minecraft')
        .execute();
    }
  });
  it('derives viewer/operator/manager actions while keeping first-start denial separate from current state', async () => {
    const other = await peer(),
      project = await createProject(f.db, f.context, { name: 'Shared' }),
      id = await f.server({ projectId: project.id });
    await setProjectMember(f.db, f.context, project.id, {
      userId: other.context.subjectUserId,
      role: 'viewer',
    });
    expect(await getPlatformServer(f.db, other.context, id)).toMatchObject({
      permissions: { read: true, operate: false, manage: false },
      availableActions: { start: false },
    });
    await setProjectMember(f.db, f.context, project.id, {
      userId: other.context.subjectUserId,
      role: 'operator',
    });
    expect(await getPlatformServer(f.db, other.context, id)).toMatchObject({
      permissions: { operate: true, manage: false },
    });
    await f.db
      .insertInto('server_events')
      .values({
        server_id: id,
        job_id: null,
        actor_id: f.context.actorUserId,
        subject_id: f.context.subjectUserId,
        support_session_id: null,
        message_key: 'servers.operation.initial_start_denied',
        data: '{}',
      })
      .execute();
    expect(await getPlatformServer(f.db, f.context, id)).toMatchObject({
      runtimeState: 'offline',
      firstStart: { outcome: 'denied' },
    });
    await setProjectMember(f.db, f.context, project.id, {
      userId: other.context.subjectUserId,
      role: null,
    });
    await expect(getPlatformServer(f.db, other.context, id)).rejects.toThrow('not_found');
  });
  it('offers stop only online and Kill only for an eligible active stop with a process baseline', async () => {
    const id = await f.server();
    expect((await getPlatformServer(f.db, f.context, id)).availableActions).toMatchObject({
      stop: false,
      kill: false,
    });
    await f.db
      .updateTable('managed_servers')
      .set({ runtime_state: 'running' })
      .where('id', '=', id)
      .execute();
    expect((await getPlatformServer(f.db, f.context, id)).availableActions).toMatchObject({
      stop: true,
      kill: false,
    });
    const queued = await enqueueServerOperation(f.db, f.context, id, {
      action: 'stop',
      idempotencyKey: randomUUID(),
    });
    await f.db
      .updateTable('server_operations')
      .set({ phase: 'power', effect_started_at: new Date() })
      .where('job_id', '=', queued.jobId)
      .execute();
    expect((await getPlatformServer(f.db, f.context, id)).availableActions).toMatchObject({
      stop: false,
      kill: false,
    });
    await f.db
      .updateTable('server_operations')
      .set({ plan: JSON.stringify({ stopProcessStartedAt: new Date().toISOString() }) })
      .where('job_id', '=', queued.jobId)
      .execute();
    expect((await getPlatformServer(f.db, f.context, id)).availableActions.kill).toBe(true);
    const receipt = {
      key: 'fixture',
      actorId: f.context.actorUserId,
      subjectId: f.context.subjectUserId,
      sessionId: 'private',
      supportId: null,
      state: 'requested',
    };
    await f.db
      .updateTable('operation_jobs')
      .set({ policy_snapshot: JSON.stringify({ stopEscalation: receipt }) })
      .where('id', '=', queued.jobId)
      .execute();
    expect((await getPlatformServer(f.db, f.context, id)).availableActions.kill).toBe(false);
    await f.db
      .updateTable('operation_jobs')
      .set({
        policy_snapshot: JSON.stringify({ stopEscalation: { ...receipt, state: 'rejected' } }),
      })
      .where('id', '=', queued.jobId)
      .execute();
    expect((await getPlatformServer(f.db, f.context, id)).availableActions.kill).toBe(true);
    const publicJob = await getPlatformJob(f.db, f.context, queued.jobId);
    expect(JSON.stringify(publicJob)).not.toContain('private');
    expect(JSON.stringify(publicJob)).not.toContain('stopEscalation');
  });
  it('permits safe names, limits project regrouping to owner-controlled boundaries, and never edits provider identity', async () => {
    const other = await peer(),
      project = await createProject(f.db, f.context, { name: 'Shared' }),
      next = await createProject(f.db, f.context, { name: 'Next' }),
      foreign = await createProject(f.db, other.context, { name: 'Foreign' });
    const id = await f.server({ projectId: project.id });
    const before = await f.db
      .selectFrom('managed_servers')
      .select(['pterodactyl_id', 'external_id', 'mapping_id', 'owner_id', 'node_id'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    await setProjectMember(f.db, f.context, project.id, {
      userId: other.context.subjectUserId,
      role: 'manager',
    });
    expect(await updatePlatformServer(f.db, other.context, id, { name: 'Renamed' })).toMatchObject({
      name: 'Renamed',
    });
    await expect(
      updatePlatformServer(f.db, other.context, id, { projectId: foreign.id }),
    ).rejects.toThrow('forbidden');
    await expect(
      updatePlatformServer(f.db, f.context, id, { projectId: foreign.id }),
    ).rejects.toThrow('forbidden');
    await expect(
      updatePlatformServer(f.db, f.context, id, { mappingId: f.mappingId }),
    ).rejects.toThrow('validation_failed');
    expect(await updatePlatformServer(f.db, f.context, id, { projectId: next.id })).toMatchObject({
      projectId: next.id,
    });
    await updatePlatformServer(f.db, f.context, id, { projectId: null });
    expect(
      await f.db
        .selectFrom('managed_servers')
        .select(['pterodactyl_id', 'external_id', 'mapping_id', 'owner_id', 'node_id'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    const audit = await listPlatformAudit(f.db, f.owner, { action: 'server.metadata.updated' });
    expect(audit.items.find((r) => r.metadata.projectId === null)).toBeDefined();
  });
  it('lists projects and names without unrelated email disclosure; exact collaborator lookup is project-owner only', async () => {
    const other = await peer(),
      project = await createProject(f.db, f.context, { name: 'Shared' });
    const email = `${other.context.subjectUserId}@example.test`;
    expect(await lookupProjectCollaborator(f.db, f.context, project.id, { email })).toEqual({
      user: { id: other.context.subjectUserId, name: 'User' },
    });
    expect(
      await lookupProjectCollaborator(f.db, f.context, project.id, {
        email: 'unknown@example.test',
      }),
    ).toEqual({ user: null });
    await expect(
      lookupProjectCollaborator(f.db, other.context, project.id, { email }),
    ).rejects.toThrow('forbidden');
    await setProjectMember(f.db, f.context, project.id, {
      userId: other.context.subjectUserId,
      role: 'manager',
    });
    const detail = await getPlatformProject(f.db, other.context, project.id);
    expect(detail.canManage).toBe(false);
    expect(detail.members).toEqual([
      { id: other.context.subjectUserId, name: 'User', role: 'manager' },
    ]);
    await expect(
      lookupProjectCollaborator(f.db, other.context, project.id, { email }),
    ).rejects.toThrow('forbidden');
    expect(
      (await listPlatformProjects(f.db, other.context, { q: 'Shared' })).items.map((r) => r.id),
    ).toEqual([project.id]);
    await updatePlatformProject(f.db, f.context, project.id, { name: 'Updated' });
    expect((await getPlatformProject(f.db, f.context, project.id)).name).toBe('Updated');
  });
  it('deletes only grouping/membership and preserves servers, allocations and provider identity', async () => {
    const other = await peer(),
      project = await createProject(f.db, f.context, { name: 'Shared' }),
      id = await f.server({ projectId: project.id });
    await setProjectMember(f.db, f.context, project.id, {
      userId: other.context.subjectUserId,
      role: 'viewer',
    });
    await expect(deletePlatformProject(f.db, f.context, project.id, {})).rejects.toThrow(
      'validation_failed',
    );
    expect(await deletePlatformProject(f.db, f.context, project.id, { confirm: true })).toEqual({
      detachedServers: 1,
    });
    expect(await getPlatformServer(f.db, f.context, id)).toMatchObject({ projectId: null });
    expect(
      await f.db
        .selectFrom('server_allocations')
        .select('id')
        .where('server_id', '=', id)
        .execute(),
    ).toHaveLength(1);
    await expect(getPlatformServer(f.db, other.context, id)).rejects.toThrow('not_found');
  });
  it('revalidates session after the resource lock and refuses revoked metadata writes', async () => {
    const id = await f.server();
    let release!: () => void, locked!: () => void;
    const barrier = new Promise<void>((r) => {
        locked = r;
      }),
      wait = new Promise<void>((r) => {
        release = r;
      });
    const holding = f.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':resources',0))`.execute(
        tx,
      );
      locked();
      await wait;
    });
    await barrier;
    const mutation = updatePlatformServer(f.db, f.context, id, { name: 'Denied' });
    await f.db
      .deleteFrom('session')
      .where('id', '=', f.context[authSessionId] ?? '')
      .execute();
    release();
    await holding;
    await expect(mutation).rejects.toThrow('unauthenticated');
    expect((await getPlatformServer(f.db, f.context, id)).name).toBe('isolated-server');
  });
  it('distinguishes configured storage, active reservations and measured usage; supports expired overrides and unlimited counts', async () => {
    const id = await f.server();
    await setUserLimits(f.db, f.owner, {
      userId: f.context.subjectUserId,
      memoryMiB: 256,
      cpuPercent: 50,
      storageMiB: 512,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      reason: 'Isolated quota test',
    });
    const before = await getPlatformQuota(f.db, f.context);
    expect(before).toMatchObject({
      limits: { memoryMiB: 256, cpuPercent: 50, storageMiB: null, serverCount: null },
      committed: { memoryMiB: 0, cpuPercent: 0, storageMiB: 128, serverCount: 1 },
      missingMeasurements: [id],
    });
    await enqueueServerOperation(f.db, f.context, id, {
      action: 'start',
      idempotencyKey: randomUUID(),
    });
    expect(await getPlatformQuota(f.db, f.context)).toMatchObject({
      committed: { memoryMiB: 128, cpuPercent: 10 },
      measured: [],
    });
    await f.db
      .updateTable('resource_user_limits')
      .set({ expires_at: new Date(0) })
      .where('user_id', '=', f.context.subjectUserId)
      .execute();
    expect((await getPlatformQuota(f.db, f.context)).override?.active).toBe(false);
    await expect(getPlatformQuota(f.db, f.context, f.owner.subjectUserId)).rejects.toThrow(
      'forbidden',
    );
  });
  it('reports a personal unlimited exception as unbounded and creates without a disk cap', async () => {
    await f.db
      .insertInto('storage_user_budgets')
      .values({ user_id: f.context.subjectUserId, storage_mib: '0' })
      .execute();
    const env = { NH_STORAGE_POLICY: 'PER_USER_BUDGET' };
    expect(await getPlatformQuota(f.db, f.context, f.context.subjectUserId, env)).toMatchObject({
      storageBudgetMiB: 0,
      storageBudgetOverrideMiB: 0,
      limits: { storageMiB: null },
      remaining: { storageMiB: null },
      creationStorage: { mode: 'shared', defaultDiskMiB: 0 },
    });
    await f.db
      .updateTable('storage_user_budgets')
      .set({ storage_mib: null })
      .where('user_id', '=', f.context.subjectUserId)
      .execute();
    expect(
      (await getPlatformQuota(f.db, f.context, f.context.subjectUserId, env)).limits.storageMiB,
    ).toBeGreaterThan(0);
  });
  it('reports actual shared filesystem space once per active host even before the first server', async () => {
    await f.db
      .updateTable('physical_hosts')
      .set({ enabled: false })
      .where('id', '!=', f.hostId)
      .execute();
    const node = await f.db
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', f.nodeId)
      .executeTakeFirstOrThrow();
    await f.db
      .insertInto('managed_nodes')
      .values({
        id: randomUUID(),
        physical_host_id: node.physical_host_id,
        provision_user_id: node.provision_user_id,
        pterodactyl_node_id: node.pterodactyl_node_id + 1000000,
      })
      .execute();
    await f.observe({ availableDiskMiB: 2048.5 });
    expect(await getPlatformQuota(f.db, f.context)).toMatchObject({
      sharedStorageAvailableBytes: 2048.5 * 1048576,
      remaining: { storageMiB: null },
      committed: { serverCount: 0 },
    });
    expect(
      await getPlatformQuota(f.db, f.context, f.context.subjectUserId, {
        NH_STORAGE_POLICY: 'PER_USER_BUDGET',
      }),
    ).toMatchObject({ sharedStorageAvailableBytes: null });
  });
  it('does not show stale or partial shared disk totals and excludes disabled hosts', async () => {
    await f.db
      .updateTable('physical_hosts')
      .set({ enabled: false })
      .where('id', '!=', f.hostId)
      .execute();
    const second = await peer();
    await f.observe({ availableDiskMiB: 2048 });
    await second.observe({ availableDiskMiB: 1024 });
    expect((await getPlatformQuota(f.db, f.context)).sharedStorageAvailableBytes).toBe(
      3072 * 1048576,
    );
    await second.observe({ availableDiskMiB: 1024 }, new Date(Date.now() - 10000));
    expect((await getPlatformQuota(f.db, f.context)).sharedStorageAvailableBytes).toBeNull();
    const hostOverride = {
      id: second.hostId,
      name: 'Overridden shared host',
      memoryLimitMiB: 8192,
      cpuLimitPercent: 800,
      storagePoolMiB: 1000000,
      memoryHeadroomMiB: 256,
      cpuHeadroomPercent: 20,
      diskHeadroomMiB: 256,
      localDiskPath: '/isolated-fixture',
      observerId: 'isolated-observer',
    };
    const overrideEnv = (enabled: boolean) => ({
      NH_HOST_POLICIES: JSON.stringify({ [second.hostId]: { ...hostOverride, enabled } }),
    });
    expect(
      (await getPlatformQuota(f.db, f.context, f.context.subjectUserId, overrideEnv(false)))
        .sharedStorageAvailableBytes,
    ).toBe(2048 * 1048576);
    await f.db
      .updateTable('physical_hosts')
      .set({ enabled: false })
      .where('id', '=', second.hostId)
      .execute();
    expect((await getPlatformQuota(f.db, f.context)).sharedStorageAvailableBytes).toBe(
      2048 * 1048576,
    );
    await second.observe({ availableDiskMiB: 1024 });
    expect(
      (await getPlatformQuota(f.db, f.context, f.context.subjectUserId, overrideEnv(true)))
        .sharedStorageAvailableBytes,
    ).toBe(3072 * 1048576);
    await f.observe({ availableDiskMiB: 0 });
    expect((await getPlatformQuota(f.db, f.context)).sharedStorageAvailableBytes).toBe(0);
  });
  it('provides Owner directory/detail and audit quota history without credentials and refuses ordinary access', async () => {
    await expect(listPlatformUsers(f.db, f.context)).rejects.toThrow('forbidden');
    const users = await listPlatformUsers(f.db, f.owner, { q: f.context.subjectUserId });
    expect(users.items.map((u) => u.id)).toEqual([f.context.subjectUserId]);
    expect(await getPlatformUser(f.db, f.owner, f.context.subjectUserId)).toMatchObject({
      id: f.context.subjectUserId,
      quota: { userId: f.context.subjectUserId },
    });
    await setUserLimits(f.db, f.owner, {
      userId: f.context.subjectUserId,
      memoryMiB: 512,
      cpuPercent: 100,
      storageMiB: 1000,
      reason: 'Isolated quota history',
    });
    const history = await listPlatformAudit(f.db, f.owner, {
      action: 'resource.user_limits.updated',
      userId: f.context.subjectUserId,
    });
    expect(history.items).toHaveLength(1);
    expect(history.items[0]?.metadata.memoryMiB).toBe(512);
    expect(JSON.stringify(users)).not.toMatch(/password|token|secret|twoFactor/);
    await expect(listPlatformAudit(f.db, f.context)).rejects.toThrow('forbidden');
  });
  it('scopes Activity and job detail consistently to project membership and enforces immediate revocation', async () => {
    const other = await peer(),
      project = await createProject(f.db, f.context, { name: 'Operations' }),
      id = await f.server({ projectId: project.id });
    const queued = await enqueueServerOperation(f.db, f.context, id, {
      action: 'backup',
      idempotencyKey: randomUUID(),
    });
    await expect(getPlatformJob(f.db, other.context, queued.jobId)).rejects.toThrow('not_found');
    await setProjectMember(f.db, f.context, project.id, {
      userId: other.context.subjectUserId,
      role: 'viewer',
    });
    expect(await getPlatformJob(f.db, other.context, queued.jobId)).toMatchObject({
      serverId: id,
      state: 'queued',
    });
    expect(
      (
        await listPlatformActivity(f.db, other.context, { state: 'queued', serverId: id })
      ).items.map((j) => j.id),
    ).toEqual([queued.jobId]);
    await setProjectMember(f.db, f.context, project.id, {
      userId: other.context.subjectUserId,
      role: null,
    });
    await expect(getPlatformJob(f.db, other.context, queued.jobId)).rejects.toThrow('not_found');
    expect((await listPlatformActivity(f.db, other.context)).items).toHaveLength(0);
  });
  it('exposes only valid acknowledged file transfer counters to authorized job readers', async () => {
    const id = await f.server();
    const queued = await enqueueServerOperation(f.db, f.context, id, {
      action: 'backup',
      idempotencyKey: randomUUID(),
    });
    expect((await getPlatformJob(f.db, f.context, queued.jobId)).fileTransfer).toBeUndefined();
    const counters = {
      completedFiles: 1,
      totalFiles: 3,
      completedBytes: 1024,
      totalBytes: 4096,
    };
    const plan = {
      backupComplete: true,
      fileTransfer: {
        ...counters,
        id: randomUUID(),
        digest: 'a'.repeat(64),
        sourcePath: '/private/staging/source',
      },
    };
    await f.db
      .updateTable('server_operations')
      .set({ plan: JSON.stringify(plan) })
      .where('job_id', '=', queued.jobId)
      .execute();
    const detail = await getPlatformJob(f.db, f.context, queued.jobId);
    expect(detail.fileTransfer).toEqual(counters);
    expect(detail.backupResult?.state).toBe('succeeded');
    expect(JSON.stringify(detail)).not.toContain('/private/staging/source');
    expect(JSON.stringify(detail)).not.toContain('a'.repeat(64));
    await expect(getPlatformJob(f.db, (await peer()).context, queued.jobId)).rejects.toThrow(
      'not_found',
    );
    await f.db
      .updateTable('server_operations')
      .set({ action: 'minecraft-content' })
      .where('job_id', '=', queued.jobId)
      .execute();
    expect(await getPlatformJob(f.db, f.context, queued.jobId)).toMatchObject({
      fileTransfer: counters,
      backupResult: null,
    });
    for (const invalid of [
      { ...counters, completedFiles: 4 },
      { ...counters, completedBytes: 4097 },
      { ...counters, completedFiles: -1 },
      { ...counters, totalFiles: 0 },
      { ...counters, totalBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...counters, completedFiles: 0.5 },
    ]) {
      await f.db
        .updateTable('server_operations')
        .set({ plan: JSON.stringify({ fileTransfer: invalid }) })
        .where('job_id', '=', queued.jobId)
        .execute();
      expect((await getPlatformJob(f.db, f.context, queued.jobId)).fileTransfer).toBeUndefined();
    }
  });
  it('creates idempotent new intent for proved no-effect failure but never resets or replays uncertainty', async () => {
    const id = await f.server(),
      old = await enqueueServerOperation(f.db, f.context, id, {
        action: 'backup',
        idempotencyKey: randomUUID(),
      });
    await f.db
      .updateTable('operation_jobs')
      .set({ state: 'failed', error_code: 'integration_unavailable', completed_at: new Date() })
      .where('id', '=', old.jobId)
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null })
      .where('id', '=', id)
      .execute();
    await f.db
      .updateTable('server_operations')
      .set({ phase: 'failed', effect_state: 'uncertain', effect_started_at: new Date() })
      .where('job_id', '=', old.jobId)
      .execute();
    await expect(
      retryPlatformJob(f.db, f.context, old.jobId, { idempotencyKey: randomUUID() }),
    ).rejects.toThrow('operation_uncertain');
    await f.db
      .updateTable('server_operations')
      .set({ effect_state: 'none', effect_started_at: null })
      .where('job_id', '=', old.jobId)
      .execute();
    const input = { idempotencyKey: randomUUID() };
    const result = await retryPlatformJob(f.db, f.context, old.jobId, input);
    expect(result.jobId).not.toBe(old.jobId);
    expect(await retryPlatformJob(f.db, f.context, old.jobId, input)).toEqual(result);
    expect((await getPlatformJob(f.db, f.context, old.jobId)).state).toBe('failed');
  });
  it('offers Owner uncertainty review only after the safety interval and never for power effects', async () => {
    const id = await f.server();
    const queued = await enqueueServerOperation(f.db, f.context, id, {
      action: 'backup',
      idempotencyKey: randomUUID(),
    });
    await f.db
      .updateTable('server_operations')
      .set({ effect_state: 'uncertain', effect_started_at: new Date() })
      .where('job_id', '=', queued.jobId)
      .execute();
    expect((await getPlatformJob(f.db, f.context, queued.jobId)).ownerRecovery).toBeNull();
    expect((await getPlatformJob(f.db, f.owner, queued.jobId)).ownerRecovery?.available).toBe(
      false,
    );
    await f.db
      .updateTable('server_operations')
      .set({ effect_started_at: new Date(Date.now() - 121000) })
      .where('job_id', '=', queued.jobId)
      .execute();
    expect((await getPlatformJob(f.db, f.owner, queued.jobId)).ownerRecovery?.available).toBe(true);
    for (const action of ['start', 'stop', 'restart'] as const) {
      await f.db
        .updateTable('server_operations')
        .set({ action })
        .where('job_id', '=', queued.jobId)
        .execute();
      expect((await getPlatformJob(f.db, f.owner, queued.jobId)).ownerRecovery).toBeNull();
    }
    await f.db
      .updateTable('server_operations')
      .set({ action: 'provision', phase: 'initial_start' })
      .where('job_id', '=', queued.jobId)
      .execute();
    expect((await getPlatformJob(f.db, f.owner, queued.jobId)).ownerRecovery).toBeNull();
    await f.db
      .updateTable('server_operations')
      .set({ action: 'backup', phase: 'prepared' })
      .where('job_id', '=', queued.jobId)
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null })
      .where('id', '=', id)
      .execute();
    expect((await getPlatformJob(f.db, f.owner, queued.jobId)).ownerRecovery).toBeNull();
  });
  it('exposes configured multiport routes without mistaking a snapshot lease for listener readiness', async () => {
    const id = await f.server();
    const before = await getPlatformConnections(f.db, f.context, id);
    expect(
      before.ports.every(
        (p) => p.status === 'unconfigured' && p.hostname === null && p.port === null,
      ),
    ).toBe(true);
    const allocation = await f.db
      .selectFrom('server_allocations')
      .select('id')
      .where('server_id', '=', id)
      .executeTakeFirstOrThrow();
    await f.db
      .insertInto('gateway_routes')
      .values({
        id: randomUUID(),
        gateway_id: randomUUID(),
        server_id: id,
        allocation_id: allocation.id,
        public_address: '192.0.2.50',
        public_port: 22222,
        transport: 'tcp',
        payload_hash: null,
        lease_expires_at: new Date(Date.now() + 60000),
      })
      .execute();
    const result = await getPlatformConnections(f.db, f.context, id, {
      NH_STATIC_GAME_HOSTNAME: 'play.example.test',
    });
    expect(result.ports).toEqual(
      expect.arrayContaining([
        {
          role: 'game',
          primary: true,
          transport: 'tcp',
          port: 22222,
          hostname: 'play.example.test',
          displayAddress: 'play.example.test:22222',
          status: 'configured',
        },
        {
          role: 'game',
          primary: true,
          transport: 'udp',
          port: null,
          hostname: null,
          displayAddress: null,
          status: 'unconfigured',
        },
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('10.0.0.2');
    await f.db
      .updateTable('gateway_routes')
      .set({ lease_expires_at: new Date(0) })
      .where('server_id', '=', id)
      .execute();
    expect((await getPlatformConnections(f.db, f.context, id)).ports[0]?.status).toBe(
      'unavailable',
    );
  });
  it('withholds raw endpoints for DNS integrations until confirmed and preserves confirmed addresses during rename', async () => {
    const id = await f.server();
    await f.db
      .updateTable('game_integrations')
      .set({
        manifest: {
          ...((
            await f.db
              .selectFrom('game_integrations')
              .select('manifest')
              .where('id', '=', f.gameId)
              .executeTakeFirstOrThrow()
          ).manifest as object),
          connection: {
            mode: 'custom-subdomain',
            zoneSettingKey: 'cloudflareZoneId',
            srv: { service: '_minecraft', proto: 'tcp' },
          },
        },
      })
      .where('id', '=', f.gameId)
      .execute();
    const allocation = await f.db
      .selectFrom('server_allocations')
      .select('id')
      .where('server_id', '=', id)
      .executeTakeFirstOrThrow();
    await f.db
      .insertInto('gateway_routes')
      .values({
        id: randomUUID(),
        gateway_id: randomUUID(),
        server_id: id,
        allocation_id: allocation.id,
        public_address: '192.0.2.50',
        public_port: 22222,
        transport: 'tcp',
        payload_hash: null,
        lease_expires_at: new Date(Date.now() + 60000),
      })
      .execute();
    await f.db
      .updateTable('server_allocations')
      .set({ direct_endpoint: JSON.stringify({ hostname: '192.0.2.51', port: 22222 }) })
      .where('server_id', '=', id)
      .execute();
    const assignmentId = randomUUID();
    const confirmed = {
      hostname: 'old.example.test',
      port: 22222,
      displayAddress: 'old.example.test',
      records: [{ type: 'SRV', data: { port: 22222 } }],
    };
    for (const mode of ['gateway', 'direct'] as const) {
      await f.db
        .updateTable('managed_servers')
        .set({ connection_mode: mode })
        .where('id', '=', id)
        .execute();
      const result = await getPlatformConnections(f.db, f.context, id);
      expect(result.hostname).toBeNull();
      expect(result.ports.every((p) => p.hostname === null && p.displayAddress === null)).toBe(
        true,
      );
    }
    await f.db
      .insertInto('dns_assignments')
      .values({
        id: assignmentId,
        server_id: id,
        hostname: 'new.example.test',
        ownership_token: randomUUID(),
        plan: JSON.stringify({ connection: { ...confirmed, hostname: 'new.example.test' } }),
        ledger: JSON.stringify([]),
        state: 'uncertain',
      })
      .execute();
    let result = await getPlatformConnections(f.db, f.context, id);
    expect(result.addressState).toBe('uncertain');
    expect(result.primaryDnsAssignmentId).toBe(assignmentId);
    expect(result.ports.every((p) => p.displayAddress === null)).toBe(true);
    for (const state of ['pending', 'uncertain'] as const) {
      await f.db
        .updateTable('dns_assignments')
        .set({
          state,
          plan: JSON.stringify({
            connection: { ...confirmed, hostname: 'new.example.test' },
            confirmedConnection: confirmed,
          }),
        })
        .where('id', '=', assignmentId)
        .execute();
      result = await getPlatformConnections(f.db, f.context, id);
      expect(result.hostname).toBe('old.example.test');
      expect(result.ports.find((p) => p.transport === 'tcp')?.displayAddress).toBe(
        'old.example.test',
      );
    }
    const original = await f.db
      .selectFrom('server_allocations')
      .selectAll()
      .where('id', '=', allocation.id)
      .executeTakeFirstOrThrow();
    const secondaryId = randomUUID();
    await f.db
      .insertInto('server_allocations')
      .values({
        ...original,
        id: secondaryId,
        role: 'query',
        is_primary: false,
        pterodactyl_allocation_id: original.pterodactyl_allocation_id + 1,
        port: 22223,
        protocols: ['tcp'],
        direct_endpoint: JSON.stringify({ hostname: '192.0.2.52', port: 22223 }),
      })
      .execute();
    await f.db
      .insertInto('gateway_routes')
      .values({
        id: randomUUID(),
        gateway_id: randomUUID(),
        server_id: id,
        allocation_id: secondaryId,
        public_address: '192.0.2.52',
        public_port: 22223,
        transport: 'tcp',
        payload_hash: null,
        lease_expires_at: new Date(Date.now() + 60000),
      })
      .execute();
    await f.db
      .insertInto('gateway_routes')
      .values({
        id: randomUUID(),
        gateway_id: randomUUID(),
        server_id: id,
        allocation_id: allocation.id,
        public_address: '192.0.2.99',
        public_port: 22222,
        transport: 'udp',
        payload_hash: null,
        lease_expires_at: new Date(Date.now() + 60000),
      })
      .execute();
    for (const mode of ['direct', 'gateway'] as const) {
      await f.db
        .updateTable('managed_servers')
        .set({ connection_mode: mode })
        .where('id', '=', id)
        .execute();
      result = await getPlatformConnections(f.db, f.context, id);
      expect(result.ports.find((p) => p.role === 'query')?.displayAddress).toBeNull();
      if (mode === 'gateway') {
        expect(result.ports.find((p) => p.primary && p.transport === 'tcp')?.displayAddress).toBe(
          'old.example.test',
        );
        expect(
          result.ports.find((p) => p.primary && p.transport === 'udp')?.displayAddress,
        ).toBeNull();
      }
      if (mode === 'direct')
        await f.db
          .updateTable('server_allocations')
          .set({ direct_endpoint: JSON.stringify({ hostname: '192.0.2.51', port: 22223 }) })
          .where('id', '=', secondaryId)
          .execute();
      else
        await f.db
          .updateTable('gateway_routes')
          .set({ public_address: '192.0.2.50' })
          .where('allocation_id', '=', secondaryId)
          .execute();
      result = await getPlatformConnections(f.db, f.context, id);
      expect(result.ports.find((p) => p.role === 'query')?.displayAddress).toBe(
        'old.example.test:22223',
      );
    }
    await f.db
      .updateTable('game_integrations')
      .set({
        manifest: {
          ...((
            await f.db
              .selectFrom('game_integrations')
              .select('manifest')
              .where('id', '=', f.gameId)
              .executeTakeFirstOrThrow()
          ).manifest as object),
          connection: { mode: 'shared-host', defaultLabel: 'shared', allowCustomSubdomain: false },
        },
      })
      .where('id', '=', f.gameId)
      .execute();
    await f.db.deleteFrom('dns_assignments').where('id', '=', assignmentId).execute();
    result = await getPlatformConnections(f.db, f.context, id);
    expect(result.ports.every((p) => p.hostname === null && p.displayAddress === null)).toBe(true);
  });
  it('uses frozen direct endpoints without claiming reachability or falling back to private addresses', async () => {
    const id = await f.server();
    await f.db
      .updateTable('managed_servers')
      .set({ connection_mode: 'direct' })
      .where('id', '=', id)
      .execute();
    let result = await getPlatformConnections(f.db, f.context, id);
    expect(result.connectionMode).toBe('direct');
    expect(result.reachability).toBe('unverified');
    expect(result.ports.every((p) => p.hostname === null && p.status === 'unconfigured')).toBe(
      true,
    );
    await f.db
      .updateTable('server_allocations')
      .set({ direct_endpoint: JSON.stringify({ hostname: 'direct.example.test', port: 27090 }) })
      .where('server_id', '=', id)
      .execute();
    result = await getPlatformConnections(f.db, f.context, id, {
      NH_STATIC_GAME_HOSTNAME: 'ignored.example.test',
    });
    expect(
      result.ports.every(
        (p) =>
          p.hostname === 'direct.example.test' &&
          p.port === 27090 &&
          p.displayAddress === 'direct.example.test:27090' &&
          p.status === 'configured',
      ),
    ).toBe(true);
    expect(JSON.stringify(result.ports)).not.toContain('10.0.0.2');
    expect(await getPlatformSleepPolicy(f.db, f.context, id)).toEqual({
      policy: null,
      state: null,
      proposedPolicy: null,
      idleTimeout: null,
      policyControlsEditable: false,
    });
    await f.db
      .updateTable('managed_servers')
      .set({ runtime_state: 'running', readiness: 'loading' })
      .where('id', '=', id)
      .execute();
    const details = await getPlatformServer(f.db, f.context, id);
    expect(details.connectionMode).toBe('direct');
    expect(details.capabilities).toMatchObject({
      wake: 'unsupported',
      idleDetection: false,
      readiness: false,
    });
    expect(details.readiness).toBe('unknown');
    expect(details.runtimeState).toBe('running');
    expect(details.availableActions.restart).toBe(true);
  });
  it('reports transfer limits and unconfigured policies without secrets or filesystem paths', async () => {
    const id = await f.server(),
      env = {
        NH_PTERODACTYL_BASE_URL: 'https://panel.example.test',
        NH_PTERODACTYL_CLIENT_KEY: 'isolated-secret',
        NH_OBSERVER_ID: 'isolated-observer',
      };
    expect(await getPlatformTransfers(f.db, f.context, id, env)).toMatchObject({
      upload: { available: false, providerMaxFileBytes: null },
      download: { streaming: true, totalSizeLimitBytes: null },
      sftp: { retainedTransportRevocationLimited: true, endpoint: null, canIssue: false },
    });
    await f.db
      .updateTable('physical_hosts')
      .set({
        upload_policy: JSON.stringify({
          providerMaxFileBytes: 5_000_000_000,
          temporaryDiskPath: '/isolated-private-path',
          temporaryDiskBudgetBytes: 20_000_000_000,
          temporaryDiskHeadroomBytes: 10000,
        }),
      })
      .where('id', '=', f.hostId)
      .execute();
    const result = await getPlatformTransfers(f.db, f.context, id, env);
    expect(result.upload).toMatchObject({
      available: true,
      providerMaxFileBytes: 5_000_000_000,
      concurrency: 2,
      batchMaxFiles: 500,
      batchMaxBytes: Math.min(
        result.upload.serverDiskBytes ?? Number.MAX_SAFE_INTEGER,
        Math.floor((20_000_000_000 - 65536 * 2) / 2),
      ),
    });
    expect(
      (await getPlatformTransfers(f.db, f.context, id, { ...env, NH_UPLOAD_CONCURRENCY: '4' }))
        .upload.concurrency,
    ).toBe(4);
    await f.db.updateTable('provider_change_feeds').set({ enabled: false }).execute();
    expect((await getPlatformTransfers(f.db, f.context, id, env)).upload.available).toBe(false);
    await f.db.updateTable('provider_change_feeds').set({ enabled: true }).execute();

    expect(JSON.stringify(result)).not.toMatch(/isolated-secret|isolated-private-path/);
    expect(
      (
        await getPlatformTransfers(f.db, f.context, id, {
          ...env,
          NH_SFTP_PUBLIC_HOSTNAME: 'files.example.test',
          NH_SFTP_PUBLIC_PORT: '2022',
        })
      ).sftp,
    ).toMatchObject({ endpoint: { hostname: 'files.example.test', port: 2022 }, canIssue: true });
  });
  it('returns every editable sleep field and bounded metrics windows with honest missing history', async () => {
    const id = await f.server();
    expect(await getPlatformSleepPolicy(f.db, f.context, id)).toEqual({
      policy: null,
      state: null,
      proposedPolicy: null,
      idleTimeout: null,
      policyControlsEditable: false,
    });
    await f.db
      .insertInto('gateway_server_states')
      .values({
        server_id: id,
        generation: randomUUID(),
        enabled: false,
        protocol_id: 'fixture',
        game_version: '1',
        state: 'manually_stopped',
        idle_timeout_seconds: null,
        readiness_timeout_seconds: 50,
        readiness_max_age_seconds: 10,
        estimate_max_age_seconds: 3600,
        wake_retry_seconds: 30,
        wake_job_id: null,
        sleep_job_id: null,
        process_started_at: null,
        readiness_observed_at: null,
        startup_deadline_at: null,
        idle_since: null,
        last_observed_at: null,
        last_activity_at: null,
        blocked_until: null,
        error_code: null,
      })
      .execute();
    expect((await getPlatformSleepPolicy(f.db, f.context, id)).policy).toEqual({
      enabled: false,
      protocolId: 'fixture',
      gameVersion: '1',
      idleTimeoutSeconds: null,
      idleTimeoutInherited: false,
      readinessTimeoutSeconds: 50,
      readinessMaxAgeSeconds: 10,
      estimateMaxAgeSeconds: 3600,
      wakeRetrySeconds: 30,
      mode: 'manually_stopped',
    });
    for (const sec of [1, 2, 3])
      await f.db
        .insertInto('server_metrics')
        .values({
          server_id: id,
          observed_at: new Date(`2026-01-01T00:00:0${sec}Z`),
          memory_bytes: '100',
          cpu_percent: 10,
          disk_bytes: '200',
          network_rx_bytes: '300',
          network_tx_bytes: '400',
        })
        .execute();
    const first = await listPlatformMetrics(f.db, f.context, id, {
      limit: 1,
      from: '2026-01-01T00:00:02Z',
    });
    expect(first.items).toHaveLength(1);
    expect(
      (
        await listPlatformMetrics(f.db, f.context, id, {
          before: first.nextBefore,
          from: '2026-01-01T00:00:02Z',
        })
      ).items,
    ).toHaveLength(1);
  });
  it('returns stored Owner rollout/allowlists without publishing them to ordinary clients', async () => {
    await f.db
      .updateTable('game_rollouts')
      .set({ state: 'private-testing', allowlist: [f.context.subjectUserId] })
      .where('integration_id', '=', f.gameId)
      .execute();
    await expect(listPlatformGames(f.db, f.context)).rejects.toThrow('forbidden');
    expect((await listPlatformGames(f.db, f.owner)).find((g) => g.id === f.gameId)).toMatchObject({
      state: 'private-testing',
      allowlist: [f.context.subjectUserId],
    });
  });
  it('restricts support discovery to the subject instead of exposing Owner-wide lists', async () => {
    const other = await peer(),
      id = await f.server();
    await other.server();
    const now = new Date(),
      support: AuthContext = {
        ...f.owner,
        subjectUserId: f.context.subjectUserId,
        sessionType: 'support',
        ownerElevation: true,
        support: {
          id: randomUUID(),
          reason: 'Requested isolated support',
          startedAt: now,
          lastActivityAt: now,
          expiresAt: new Date(Date.now() + 60000),
          revokedAt: null,
        },
      };
    expect((await listPlatformServers(f.db, support)).items.map((r) => r.id)).toEqual([id]);
    const scoped = await listPlatformServers(f.db, support, {
      ownerIds: [f.context.subjectUserId, other.context.subjectUserId],
    });
    expect(scoped.filterOptions.games.map((game) => game.id)).toEqual([f.gameId]);
    expect(scoped.filterOptions.owners).toEqual([]);
    await expect(listPlatformServers(f.db, support, { scope: 'others' })).rejects.toThrow(
      'forbidden',
    );
    await expect(listPlatformUsers(f.db, support)).rejects.toThrow('forbidden');
    await recordAudit(f.db, f.owner, 'fixture.record', {});
    await expect(listPlatformAudit(f.db, support)).rejects.toThrow('forbidden');
  });
});
