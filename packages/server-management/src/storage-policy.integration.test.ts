import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { assertStoragePolicyIdle, getSettings, updateSettings } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ApplicationServer, BuildUpdate, Resources } from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getPlatformQuota } from './platform-queries.js';
import { createStoragePolicyService, type StoragePolicyTransition } from './storage-policy.js';
import { managementFixture, pendingUploadFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let service: ReturnType<typeof createStoragePolicyService>;
let serverId: string;
let remote: ApplicationServer;
let diskBytes: number;
const sync = vi.fn(async () => {});
function body(value: StoragePolicyTransition, disk = 256, quotaMiB = 1024) {
  return {
    users: value.users.map((u) => ({
      userId: u.userId,
      quotaMiB,
      servers: u.servers.map((s) => ({ serverId: s.serverId, diskMiB: disk })),
    })),
  };
}
async function preview() {
  return service.preview(f.owner, { policy: 'PER_USER_BUDGET', defaultUserStorageMiB: 1024 });
}
beforeEach(async () => {
  database = await createTestDatabase();
  f = await managementFixture(database.db, { interactive: true });
  serverId = await f.server({ limits: { ...f.limits, disk: 0 } });
  const row = await f.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow();
  const allocation = await f.db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
  remote = {
    id: row.pterodactyl_id,
    uuid: row.pterodactyl_uuid,
    identifier: row.pterodactyl_identifier,
    external_id: row.external_id,
    user: row.provider_user_id,
    node: f.providerNodeId,
    allocation: allocation.pterodactyl_allocation_id,
    limits: { ...row.limits },
    feature_limits: { databases: 0, allocations: 3, backups: 1 },
    relationships: {
      allocations: {
        data: [
          {
            attributes: {
              id: allocation.pterodactyl_allocation_id,
              ip: allocation.address,
              port: allocation.port,
              assigned: true,
            },
          },
        ],
      },
    },
  } as ApplicationServer;
  diskBytes = 100 * 1048576;
  sync.mockReset();
  f.adapter.getApplicationServer = vi.fn(async () => structuredClone(remote));
  f.adapter.getResources = vi.fn(
    async () =>
      ({
        current_state: 'running',
        is_suspended: false,
        resources: {
          disk_bytes: diskBytes,
          memory_bytes: 0,
          cpu_absolute: 0,
          network_rx_bytes: 0,
          network_tx_bytes: 0,
          uptime: 1000,
        },
      }) as Resources,
  );
  f.adapter.listBackups = vi.fn(async () => []);
  f.adapter.updateBuild = vi.fn(async (_id: number, build: BuildUpdate) => {
    remote.limits = { ...remote.limits, ...build };
    delete (remote.limits as Record<string, unknown>).allocation;
    delete (remote.limits as Record<string, unknown>).feature_limits;
    return structuredClone(remote);
  });
  service = createStoragePolicyService({ db: f.db, adapter: f.adapter, reconcileSftp: sync });
});
afterEach(async () => {
  await database?.destroy();
});

it('previews fresh usage and backup reservations without provider changes; Owner-only and environment locks', async () => {
  await expect(
    service.preview(f.context, { policy: 'PER_USER_BUDGET', defaultUserStorageMiB: 1024 }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  const value = await preview();
  expect(value).toMatchObject({
    status: 'draft',
    policy: 'PER_USER_BUDGET',
    users: [
      {
        quotaMiB: 1024,
        requiredMiB: 456,
        servers: [
          { usageBytes: 100 * 1048576, minimumDiskMiB: 228, proposedDiskMiB: 228, backupSlots: 1 },
        ],
      },
    ],
  });
  await service.processPending();
  expect(f.adapter.updateBuild).not.toHaveBeenCalled();
  const locked = createStoragePolicyService({
    db: f.db,
    adapter: f.adapter,
    env: { NH_STORAGE_POLICY: 'GLOBAL_POOL' },
  });
  await expect(
    locked.preview(f.owner, { policy: 'PER_USER_BUDGET', defaultUserStorageMiB: 1024 }),
  ).rejects.toMatchObject({ code: 'conflict' });
  const second = await preview();
  expect((await service.get(f.owner, value.id)).status).toBe('superseded');
  expect(second.id).not.toBe(value.id);
});

it('keeps failed observations unknown and never treats them as zero', async () => {
  vi.mocked(f.adapter.getResources).mockRejectedValue(new DomainError('integration_unavailable'));
  const value = await preview();
  expect(value.users[0]?.servers[0]).toMatchObject({
    usageBytes: null,
    minimumDiskMiB: null,
    proposedDiskMiB: null,
    status: 'blocked',
  });
  await expect(service.apply(f.owner, value.id, body(value))).rejects.toMatchObject({
    code: 'validation_failed',
  });
  expect(f.adapter.updateBuild).not.toHaveBeenCalled();
});

it('rejects below-usage caps, aggregate overbudget, duplicate inputs and oversized host allocations', async () => {
  const value = await preview();
  await expect(service.apply(f.owner, value.id, body(value, 128))).rejects.toMatchObject({
    code: 'validation_failed',
  });
  await expect(service.apply(f.owner, value.id, body(value, 600))).rejects.toMatchObject({
    code: 'storage_exhausted',
  });
  const duplicate = body(value);
  const first = duplicate.users[0];
  if (!first) throw new Error('Expected fixture user');
  duplicate.users.push(first);
  await expect(service.apply(f.owner, value.id, duplicate)).rejects.toMatchObject({
    code: 'validation_failed',
  });
  await f.db
    .updateTable('physical_hosts')
    .set({ storage_pool_mib: '400' })
    .where('id', '=', f.hostId)
    .execute();
  await expect(service.apply(f.owner, value.id, body(value))).rejects.toMatchObject({
    code: 'storage_exhausted',
  });
  expect(f.adapter.updateBuild).not.toHaveBeenCalled();
});

it('applies provider and SFTP caps before committing policy and durable independent user budgets', async () => {
  const value = await preview();
  await service.apply(f.owner, value.id, body(value));
  expect((await getSettings(f.db)).values.storagePolicy).toBe('GLOBAL_POOL');
  await expect(assertStoragePolicyIdle(f.db)).rejects.toMatchObject({ code: 'conflict' });
  await service.processPending();
  expect(await service.get(f.owner, value.id)).toMatchObject({
    status: 'completed',
    users: [{ servers: [{ status: 'applied', currentDiskMiB: 256 }] }],
  });
  expect(remote.limits.disk).toBe(256);
  expect(sync).toHaveBeenCalledWith(expect.anything(), serverId, 256);
  expect((await getSettings(f.db)).values.storagePolicy).toBe('PER_USER_BUDGET');
  expect(await f.db.selectFrom('storage_user_budgets').selectAll().execute()).toMatchObject([
    { user_id: f.context.subjectUserId, storage_mib: null },
  ]);
  await service.processPending();
  await service.apply(f.owner, value.id, body(value));
  expect(f.adapter.updateBuild).toHaveBeenCalledTimes(1);
});

it('reconciles an uncertain PATCH by readback before retry, including service recreation', async () => {
  const value = await preview();
  await service.apply(f.owner, value.id, body(value));
  vi.mocked(f.adapter.updateBuild).mockImplementationOnce(async (_id, build) => {
    remote.limits.disk = build.disk;
    throw new Error('response lost');
  });
  await service.processPending();
  expect((await service.get(f.owner, value.id)).status).toBe('blocked');
  expect((await getSettings(f.db)).values.storagePolicy).toBe('GLOBAL_POOL');
  service = createStoragePolicyService({ db: f.db, adapter: f.adapter, reconcileSftp: sync });
  await service.retry(f.owner, value.id);
  await service.processPending();
  expect((await service.get(f.owner, value.id)).status).toBe('completed');
  expect(f.adapter.updateBuild).toHaveBeenCalledTimes(1);
});

it('keeps partial SFTP failures fenced and resumes without replaying confirmed provider changes', async () => {
  const value = await preview();
  await service.apply(f.owner, value.id, body(value));
  sync.mockRejectedValueOnce(new DomainError('integration_unavailable'));
  await service.processPending();
  expect(await service.get(f.owner, value.id)).toMatchObject({
    status: 'blocked',
    users: [{ servers: [{ currentDiskMiB: 256, proposedDiskMiB: 256, status: 'blocked' }] }],
  });
  await expect(preview()).rejects.toMatchObject({ code: 'conflict' });
  await expect(updateSettings(f.db, f.owner, { instanceName: 'Blocked' })).rejects.toMatchObject({
    code: 'conflict',
  });
  await service.retry(f.owner, value.id);
  await service.processPending();
  expect((await service.get(f.owner, value.id)).status).toBe('completed');
  expect(f.adapter.updateBuild).toHaveBeenCalledTimes(1);
  expect(sync).toHaveBeenCalledTimes(2);
});

it('remeasures before effects and lets Owner revise a blocked plan when content grew', async () => {
  const value = await preview();
  await service.apply(f.owner, value.id, body(value));
  diskBytes = 300 * 1048576;
  await service.processPending();
  const blocked = await service.get(f.owner, value.id);
  expect(blocked).toMatchObject({
    status: 'blocked',
    errorCode: 'storage_exhausted',
    users: [{ servers: [{ minimumDiskMiB: 428, status: 'blocked' }] }],
  });
  expect(f.adapter.updateBuild).not.toHaveBeenCalled();
  await service.apply(f.owner, value.id, body(blocked, 512, 2048));
  await service.processPending();
  expect((await service.get(f.owner, value.id)).status).toBe('completed');
});

it('rejects changed ownership/inventory and active uploads before starting a transition', async () => {
  const value = await preview();
  const claim = await pendingUploadFixture(f.db, serverId);
  await expect(service.apply(f.owner, value.id, body(value))).rejects.toMatchObject({
    code: 'conflict',
  });
  await f.db.deleteFrom('upload_ingestion_claims').where('id', '=', claim).execute();
  await f.db
    .updateTable('managed_servers')
    .set({ owner_id: f.owner.actorUserId })
    .where('id', '=', serverId)
    .execute();
  await expect(service.apply(f.owner, value.id, body(value))).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(f.adapter.updateBuild).not.toHaveBeenCalled();
});

it('rechecks current Owner authority and provider provenance before effects', async () => {
  const value = await preview();
  await service.apply(f.owner, value.id, body(value));
  await f.db
    .updateTable('user')
    .set({ role: 'operator' })
    .where('id', '=', f.owner.actorUserId)
    .execute();
  await service.processPending();
  expect(
    (
      await f.db
        .selectFrom('storage_policy_transitions')
        .selectAll()
        .where('id', '=', value.id)
        .executeTakeFirst()
    )?.error_code,
  ).toBe('forbidden');
  expect(f.adapter.updateBuild).not.toHaveBeenCalled();
  await f.db
    .updateTable('user')
    .set({ role: 'owner' })
    .where('id', '=', f.owner.actorUserId)
    .execute();
  await service.retry(f.owner, value.id);
  remote.uuid = randomUUID();
  await service.processPending();
  expect((await service.get(f.owner, value.id)).errorCode).toBe('provenance_mismatch');
  expect(f.adapter.updateBuild).not.toHaveBeenCalled();
});

it('blocks generic settings bypass and handles an explicitly applied global unlimited transition', async () => {
  await expect(
    updateSettings(f.db, f.owner, { storagePolicy: 'PER_USER_BUDGET' }),
  ).rejects.toMatchObject({ code: 'conflict' });
  const finite = await preview();
  await service.apply(f.owner, finite.id, body(finite));
  await service.processPending();
  const global = await service.preview(f.owner, {
    policy: 'GLOBAL_POOL',
    defaultUserStorageMiB: 1024,
  });
  await service.apply(f.owner, global.id, body(global, 0));
  expect((await getSettings(f.db)).values.storagePolicy).toBe('PER_USER_BUDGET');
  await service.processPending();
  expect(remote.limits.disk).toBe(0);
  expect((await getSettings(f.db)).values.storagePolicy).toBe('GLOBAL_POOL');
  expect((await service.get(f.owner, global.id)).status).toBe('completed');
});

it('checks existing backup bytes and blocks an unfinished backup', async () => {
  const backup = {
    uuid: randomUUID(),
    is_successful: true,
    is_locked: false,
    name: 'fixture',
    ignored_files: [],
    checksum: null,
    bytes: 600 * 1048576,
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  };
  vi.mocked(f.adapter.listBackups).mockResolvedValue([backup]);
  const value = await preview();
  expect(value.users[0]?.servers[0]?.minimumDiskMiB).toBe(600);
  vi.mocked(f.adapter.listBackups).mockResolvedValue([{ ...backup, completed_at: null }]);
  const busy = await preview();
  expect(busy.users[0]?.servers[0]).toMatchObject({
    usageBytes: null,
    errorCode: 'resources_unavailable',
  });
});

it('keeps actual occupied storage charged in unlimited mode and rejects insufficient host headroom', async () => {
  const value = await service.preview(f.owner, {
    policy: 'GLOBAL_POOL',
    defaultUserStorageMiB: 1024,
  });
  await f.db
    .updateTable('physical_hosts')
    .set({ storage_pool_mib: '80' })
    .where('id', '=', f.hostId)
    .execute();
  await expect(service.apply(f.owner, value.id, body(value, 0))).rejects.toMatchObject({
    code: 'storage_exhausted',
  });
  await f.db
    .updateTable('physical_hosts')
    .set({ storage_pool_mib: '1000000' })
    .where('id', '=', f.hostId)
    .execute();
  await f.observe({ availableDiskMiB: 100 });
  await expect(service.apply(f.owner, value.id, body(value, 0))).rejects.toMatchObject({
    code: 'storage_exhausted',
  });
  expect(f.adapter.updateBuild).not.toHaveBeenCalled();
});

it('can revise an uncertain prior absolute cap without treating the recorded effect as external drift', async () => {
  const value = await preview();
  await service.apply(f.owner, value.id, body(value));
  vi.mocked(f.adapter.updateBuild).mockImplementationOnce(async (_id, build) => {
    remote.limits.disk = build.disk;
    throw new Error('response lost');
  });
  await service.processPending();
  const blocked = await service.get(f.owner, value.id);
  await service.apply(f.owner, value.id, body(blocked, 512, 2048));
  await service.processPending();
  expect((await service.get(f.owner, value.id)).status).toBe('completed');
  expect(remote.limits.disk).toBe(512);
});

it('refreshes a blocked transition without effects, preserving accepted edits and uncertain intent', async () => {
  const value = await preview();
  await service.apply(f.owner, value.id, body(value, 300, 2048));
  sync.mockRejectedValueOnce(new DomainError('integration_unavailable'));
  await service.processPending();
  const before = await f.db
    .selectFrom('storage_policy_transitions')
    .select('plan')
    .where('id', '=', value.id)
    .executeTakeFirstOrThrow();
  diskBytes = 180 * 1048576;
  const refreshed = await service.refresh(f.owner, value.id);
  expect(refreshed).toMatchObject({
    id: value.id,
    status: 'blocked',
    errorCode: null,
    users: [
      {
        quotaMiB: 2048,
        requiredMiB: 600,
        servers: [
          {
            usageBytes: 180 * 1048576,
            minimumDiskMiB: 308,
            proposedDiskMiB: 300,
            currentDiskMiB: 300,
          },
        ],
      },
    ],
  });
  const after = await f.db
    .selectFrom('storage_policy_transitions')
    .select('plan')
    .where('id', '=', value.id)
    .executeTakeFirstOrThrow();
  expect((after.plan as { attemptedDiskMiB: unknown }).attemptedDiskMiB).toEqual(
    (before.plan as { attemptedDiskMiB: unknown }).attemptedDiskMiB,
  );
  expect(f.adapter.updateBuild).toHaveBeenCalledTimes(1);
  expect(sync).toHaveBeenCalledTimes(1);
  await service.processPending();
  expect(sync).toHaveBeenCalledTimes(1);
  await expect(service.retry(f.owner, value.id)).rejects.toMatchObject({
    code: 'validation_failed',
  });
  await service.apply(f.owner, value.id, body(refreshed, 400, 2048));
  await service.processPending();
  expect((await service.get(f.owner, value.id)).status).toBe('completed');
});

it('keeps refresh failures unknown and recovers measurements on the same blocked ID', async () => {
  const value = await preview();
  await expect(service.refresh(f.owner, value.id)).rejects.toMatchObject({ code: 'conflict' });
  await service.apply(f.owner, value.id, body(value));
  sync.mockRejectedValueOnce(new DomainError('integration_unavailable'));
  await service.processPending();
  vi.mocked(f.adapter.getResources).mockRejectedValueOnce(
    new DomainError('integration_unavailable'),
  );
  const unknown = await service.refresh(f.owner, value.id);
  expect(unknown).toMatchObject({
    id: value.id,
    status: 'blocked',
    users: [
      {
        servers: [
          {
            usageBytes: null,
            observedAt: null,
            minimumDiskMiB: null,
            proposedDiskMiB: 256,
            status: 'blocked',
          },
        ],
      },
    ],
  });
  await expect(service.retry(f.owner, value.id)).rejects.toMatchObject({
    code: 'validation_failed',
  });
  const known = await service.refresh(f.owner, value.id);
  expect(known.users[0]?.servers[0]).toMatchObject({
    usageBytes: 100 * 1048576,
    minimumDiskMiB: 228,
    proposedDiskMiB: 256,
  });
  await service.retry(f.owner, value.id);
  await service.processPending();
  expect((await service.get(f.owner, value.id)).status).toBe('completed');
  expect(f.adapter.updateBuild).toHaveBeenCalledTimes(1);
});

it('can refresh after cleanup while an unlimited transition was blocked over its host pool', async () => {
  const value = await service.preview(f.owner, {
    policy: 'GLOBAL_POOL',
    defaultUserStorageMiB: 1024,
  });
  await f.db
    .updateTable('physical_hosts')
    .set({ storage_pool_mib: '150' })
    .where('id', '=', f.hostId)
    .execute();
  await service.apply(f.owner, value.id, body(value, 0));
  diskBytes = 200 * 1048576;
  await service.processPending();
  expect((await service.get(f.owner, value.id)).errorCode).toBe('storage_exhausted');
  diskBytes = 50 * 1048576;
  await f.observe();
  const refreshed = await service.refresh(f.owner, value.id);
  expect(refreshed.users[0]?.servers[0]).toMatchObject({
    usageBytes: 50 * 1048576,
    proposedDiskMiB: 0,
  });
  await service.retry(f.owner, value.id);
  await service.processPending();
  expect((await service.get(f.owner, value.id)).status).toBe('completed');
});

it('prefers durable budgets over active legacy overrides and ignores expired legacy budgets in previews', async () => {
  await f.db
    .insertInto('resource_user_limits')
    .values({
      user_id: f.context.subjectUserId,
      memory_mib: 1024,
      cpu_percent: 100,
      storage_mib: '2048',
      expires_at: new Date(Date.now() + 60000),
    })
    .execute();
  expect((await preview()).users[0]?.quotaMiB).toBe(2048);
  await f.db
    .insertInto('storage_user_budgets')
    .values({ user_id: f.context.subjectUserId, storage_mib: '3072' })
    .execute();
  expect((await preview()).users[0]?.quotaMiB).toBe(3072);
  await f.db
    .updateTable('storage_user_budgets')
    .set({ storage_mib: null })
    .where('user_id', '=', f.context.subjectUserId)
    .execute();
  expect((await preview()).users[0]?.quotaMiB).toBe(1024);
  await f.db
    .deleteFrom('storage_user_budgets')
    .where('user_id', '=', f.context.subjectUserId)
    .execute();
  await f.db
    .updateTable('resource_user_limits')
    .set({ expires_at: new Date(Date.now() - 1000) })
    .where('user_id', '=', f.context.subjectUserId)
    .execute();
  expect((await preview()).users[0]?.quotaMiB).toBe(1024);
});

it('preserves default inheritance without reviving legacy storage limits', async () => {
  await f.db
    .insertInto('resource_user_limits')
    .values({
      user_id: f.context.subjectUserId,
      memory_mib: 1024,
      cpu_percent: 100,
      storage_mib: '2048',
      expires_at: new Date(Date.now() + 60000),
    })
    .execute();
  await f.db
    .insertInto('storage_user_budgets')
    .values({ user_id: f.context.subjectUserId, storage_mib: null })
    .execute();
  const value = await preview();
  await service.apply(f.owner, value.id, body(value, 256, 1024));
  await service.processPending();
  expect((await getPlatformQuota(f.db, f.context)).limits.storageMiB).toBe(1024);
  await updateSettings(f.db, f.owner, { defaultUserStorageMiB: 1536 });
  expect((await getPlatformQuota(f.db, f.context)).limits.storageMiB).toBe(1536);
  expect(
    (
      await f.db
        .selectFrom('storage_user_budgets')
        .selectAll()
        .where('user_id', '=', f.context.subjectUserId)
        .executeTakeFirst()
    )?.storage_mib,
  ).toBeNull();
  expect(
    (
      await f.db
        .selectFrom('resource_user_limits')
        .selectAll()
        .where('user_id', '=', f.context.subjectUserId)
        .executeTakeFirst()
    )?.storage_mib,
  ).toBe('2048');
});

it('keeps explicit storage exceptions independent of later defaults and legacy expiry', async () => {
  const value = await preview();
  await service.apply(f.owner, value.id, body(value, 256, 2048));
  await service.processPending();
  await updateSettings(f.db, f.owner, { defaultUserStorageMiB: 1536 });
  expect((await getPlatformQuota(f.db, f.context)).limits.storageMiB).toBe(2048);
  expect(
    (
      await f.db
        .selectFrom('storage_user_budgets')
        .selectAll()
        .where('user_id', '=', f.context.subjectUserId)
        .executeTakeFirst()
    )?.storage_mib,
  ).toBe('2048');
});

it('preserves an explicit exception equal to the new default instead of silently turning it into inheritance', async () => {
  await f.db
    .insertInto('storage_user_budgets')
    .values({ user_id: f.context.subjectUserId, storage_mib: '1024' })
    .execute();
  const value = await preview();
  await service.apply(f.owner, value.id, body(value, 256, 1024));
  await service.processPending();
  await updateSettings(f.db, f.owner, { defaultUserStorageMiB: 1536 });
  expect((await getPlatformQuota(f.db, f.context)).limits.storageMiB).toBe(1024);
  expect(
    (
      await f.db
        .selectFrom('storage_user_budgets')
        .selectAll()
        .where('user_id', '=', f.context.subjectUserId)
        .executeTakeFirst()
    )?.storage_mib,
  ).toBe('1024');
});
