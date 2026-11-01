import { createTestDatabase } from '@nickhosting/database/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkedObservation, observeLocalHost } from './admission.js';
import { refreshHostObservations } from './host-observations.js';
import { managementFixture } from './test-fixtures.js';

describe('shared host observations', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let fixture: Awaited<ReturnType<typeof managementFixture>>;
  const env = { NH_OBSERVER_ID: 'isolated-observer' };
  const sampler = vi.fn(async () => ({
    totalMemoryMiB: 8192,
    availableMemoryMiB: 4096,
    cpuCapacityPercent: 400,
    cpuBusyPercent: 10,
    availableDiskMiB: 10000,
    observedAt: new Date().toISOString(),
  }));
  beforeEach(async () => {
    database = await createTestDatabase();
    fixture = await managementFixture(database.db);
    await refreshHostObservations(database.db, env, { sampler });
    sampler.mockClear();
  });
  afterEach(async () => {
    await database?.destroy();
  });
  async function stale() {
    await database.db.deleteFrom('host_observations').execute();
  }
  it('reuses a fresh persisted observation across callers without sampling', async () => {
    await refreshHostObservations(database.db, env, { sampler });
    await refreshHostObservations(database.db, env, { sampler });
    expect(sampler).not.toHaveBeenCalled();
  });
  it('collects once for simultaneous stale requests and periodic work', async () => {
    await stale();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        refreshHostObservations(database.db, env, { sampler, force: i === 0 }),
      ),
    );
    expect(sampler).toHaveBeenCalledTimes(1);
    const row = await database.db
      .selectFrom('host_observations')
      .selectAll()
      .where('host_id', '=', fixture.hostId)
      .executeTakeFirstOrThrow();
    expect(row.observer_id).toBe(env.NH_OBSERVER_ID);
  });
  it('rejects observations older than four seconds even with a larger configured maximum', async () => {
    await fixture.observe({}, new Date(Date.now() - 4500));
    await refreshHostObservations(
      database.db,
      { ...env, NH_OBSERVATION_MAX_AGE_SECONDS: '30' },
      { sampler },
    );
    expect(sampler).toHaveBeenCalledTimes(1);
  });
  it('periodic collection renews a request-fresh sample and deduplicates the same tick', async () => {
    const row = await database.db
      .selectFrom('host_observations')
      .selectAll()
      .executeTakeFirstOrThrow();
    await fixture.observe(
      { ...row.snapshot, observedAt: new Date(row.observed_at.getTime() - 1500).toISOString() },
      new Date(row.observed_at.getTime() - 1500),
    );
    await refreshHostObservations(database.db, env, { sampler });
    expect(sampler).not.toHaveBeenCalled();
    await refreshHostObservations(database.db, env, { sampler, force: true });
    await refreshHostObservations(database.db, env, { sampler, force: true });
    expect(sampler).toHaveBeenCalledTimes(1);
  });
  it.each(['future', 'wrong-observer'])('does not reuse a %s observation', async (kind) => {
    if (kind === 'future') await fixture.observe({}, new Date(Date.now() + 60000));
    else
      await database.db.updateTable('host_observations').set({ observer_id: 'foreign' }).execute();
    await refreshHostObservations(database.db, env, { sampler });
    expect(sampler).toHaveBeenCalledTimes(1);
    await expect(checkedObservation(database.db, fixture.hostId, env)).resolves.toBeDefined();
  });
  it('never overwrites a newer published observation with an older completed sample', async () => {
    const before = await database.db
      .selectFrom('host_observations')
      .selectAll()
      .executeTakeFirstOrThrow();
    await observeLocalHost(database.db, fixture.hostId, env.NH_OBSERVER_ID, {}, env, async () => ({
      ...(await sampler()),
      observedAt: new Date(before.observed_at.getTime() - 1000).toISOString(),
    }));
    const after = await database.db
      .selectFrom('host_observations')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(after.observed_at).toEqual(before.observed_at);
    expect(after.snapshot).toEqual(before.snapshot);
  });
  it('refreshes cached observations after a disk-path change', async () => {
    await database.db
      .updateTable('physical_hosts')
      .set({ local_disk_path: '/isolated-new-disk' })
      .where('id', '=', fixture.hostId)
      .execute();
    await refreshHostObservations(database.db, env, { sampler });
    expect(sampler).toHaveBeenCalledTimes(1);
    expect(sampler).toHaveBeenCalledWith('/isolated-new-disk');
  });
  it('does not sample hosts assigned to another observer', async () => {
    await stale();
    await refreshHostObservations(database.db, { NH_OBSERVER_ID: 'other-observer' }, { sampler });
    expect(sampler).not.toHaveBeenCalled();
  });
  it('propagates collection failure without renewing the old observation', async () => {
    await stale();
    await expect(
      refreshHostObservations(database.db, env, {
        sampler: async () => {
          throw new Error('collector unavailable');
        },
      }),
    ).rejects.toThrow('collector unavailable');
    expect(await database.db.selectFrom('host_observations').selectAll().execute()).toEqual([]);
  });
});
