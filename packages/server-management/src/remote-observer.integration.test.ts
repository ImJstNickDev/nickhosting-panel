import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { serveHostObserver } from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagementRuntime } from './runtime.js';
import { managementFixture } from './test-fixtures.js';

describe('remote physical host observation persistence', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let fixture: Awaited<ReturnType<typeof managementFixture>>;
  let directory: string;
  let helper: Awaited<ReturnType<typeof serveHostObserver>> | undefined;
  const codec = new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } });
  const observerId = 'isolated-observer';
  // The helper owns disk interpretation. Distinct injected metrics prove Core
  // persists its sample instead of collecting namespace-local resource values.
  let diskPath: string;
  const containerObserver = {
    preflight: vi.fn(async () => {}),
    stopped: vi.fn(async () => true),
  };
  const sample = vi.fn(async () => ({
    totalMemoryMiB: 16384,
    availableMemoryMiB: 3072,
    cpuCapacityPercent: 800,
    cpuBusyPercent: 125,
    availableDiskMiB: 65536,
    observedAt: new Date().toISOString(),
  }));

  beforeEach(async () => {
    vi.clearAllMocks();
    database = await createTestDatabase();
    fixture = await managementFixture(database.db);
    directory = await mkdtemp(join(tmpdir(), 'nh-observer-db-'));
    diskPath = join(directory, 'host-only-data');
    await mkdir(diskPath);
    await fixture.db
      .updateTable('physical_hosts')
      .set({ local_disk_path: diskPath })
      .where('id', '=', fixture.hostId)
      .execute();
  });
  afterEach(async () => {
    await helper?.close();
    helper = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    await database?.destroy();
  });
  async function start(identity = observerId, allowedDiskPaths = [diskPath]) {
    const socket = join(directory, 'observer.sock');
    helper = await serveHostObserver({
      socket,
      dockerSocket: '/fixture-unused-docker.sock',
      observerId: identity,
      allowedDiskPaths,
      containerObserver,
      sample,
    });
    return createManagementRuntime({
      db: fixture.db,
      codec,
      adapter: fixture.adapter,
      env: { NH_OBSERVER_ID: observerId, NH_HOST_OBSERVER_SOCKET: socket },
    });
  }
  async function stored() {
    return fixture.db
      .selectFrom('host_observations')
      .selectAll()
      .where('host_id', '=', fixture.hostId)
      .executeTakeFirstOrThrow();
  }

  it('persists the fresh helper sample instead of API-local resource metrics', async () => {
    const runtime = await start();
    const before = Date.now();
    await runtime.refreshObservations();
    const observation = await stored();
    expect(sample).toHaveBeenCalledWith(diskPath);
    expect(observation.observer_id).toBe(observerId);
    expect(observation.snapshot).toMatchObject({
      totalMemoryMiB: 16384,
      availableMemoryMiB: 3072,
      cpuCapacityPercent: 800,
      cpuBusyPercent: 125,
      availableDiskMiB: 65536,
      managed: {},
    });
    expect(observation.observed_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(observation.snapshot.observedAt).toBe(observation.observed_at.toISOString());
  });

  it('rejects another helper identity without replacing the last known sample', async () => {
    const original = await stored();
    const runtime = await start('another-physical-host');
    await expect(runtime.refreshObservations()).rejects.toThrow();
    expect(await stored()).toEqual(original);
    // The response identity is checked before persistence, even when the
    // contacted helper can produce a structurally valid observation.
    expect(sample).toHaveBeenCalledOnce();
  });

  it('refuses an unapproved disk path without replacing the last known sample', async () => {
    const original = await stored();
    const runtime = await start(observerId, [directory]);
    await expect(runtime.refreshObservations()).rejects.toThrow();
    expect(await stored()).toEqual(original);
    expect(sample).not.toHaveBeenCalled();
  });

  it.each([
    ['stale', -10000],
    ['future', 10000],
  ] as const)('rejects a %s sample without refreshing stored evidence', async (_label, offset) => {
    const original = await stored();
    const runtime = await start();
    sample.mockResolvedValueOnce({
      totalMemoryMiB: 16384,
      availableMemoryMiB: 3072,
      cpuCapacityPercent: 800,
      cpuBusyPercent: 125,
      availableDiskMiB: 65536,
      observedAt: new Date(Date.now() + offset).toISOString(),
    });
    await expect(runtime.refreshObservations()).rejects.toThrow();
    expect(sample).toHaveBeenCalledOnce();
    expect(await stored()).toEqual(original);
  });
});
