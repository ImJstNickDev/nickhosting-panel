import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { expect, it } from 'vitest';
import { getPlatformQuota, getPlatformUserProfile } from './platform-queries.js';
import { managementFixture } from './test-fixtures.js';

it('loads the Owner profile in one read and shared capacity in a fixed number of reads for 0–30 hosts', async () => {
  const database = await createTestDatabase();
  try {
    const f = await managementFixture(database.db);
    const host = await f.db
      .selectFrom('physical_hosts')
      .selectAll()
      .where('id', '=', f.hostId)
      .executeTakeFirstOrThrow();
    const hosts = Array.from({ length: 29 }, () => ({
      ...host,
      id: randomUUID(),
      upload_policy: null,
    }));
    await f.db.insertInto('physical_hosts').values(hosts).execute();
    await f.db
      .insertInto('managed_nodes')
      .values(
        hosts.map(({ id }, i) => ({
          id: randomUUID(),
          physical_host_id: id,
          pterodactyl_node_id: 1000000 + i,
          provision_user_id: 1,
        })),
      )
      .execute();
    const sample = await f.db
      .selectFrom('host_observations')
      .select('snapshot')
      .where('host_id', '=', f.hostId)
      .executeTakeFirstOrThrow();
    const ids = [f.hostId, ...hosts.map((h) => h.id)];
    let statements = 0;
    const measured = f.db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        statements++;
        return result;
      },
    });
    const profile = await getPlatformUserProfile(measured, f.owner, f.context.subjectUserId);
    expect(profile.id).toBe(f.context.subjectUserId);
    expect(profile).not.toHaveProperty('quota');
    expect(statements).toBe(1);
    for (const count of [0, 1, 8, 30]) {
      await f.db.updateTable('managed_nodes').set({ enabled: false }).execute();
      if (count)
        await f.db
          .updateTable('managed_nodes')
          .set({ enabled: true })
          .where('physical_host_id', 'in', ids.slice(0, count))
          .execute();
      const at = new Date();
      await f.db
        .insertInto('host_observations')
        .values(
          ids.map((id) => ({
            host_id: id,
            observer_id: host.observer_id,
            observed_at: at,
            snapshot: JSON.stringify({
              ...sample.snapshot,
              availableDiskMiB: 1,
              observedAt: at.toISOString(),
            }),
          })),
        )
        .onConflict((c) =>
          c.column('host_id').doUpdateSet((eb) => ({
            observed_at: eb.ref('excluded.observed_at'),
            snapshot: eb.ref('excluded.snapshot'),
          })),
        )
        .execute();
      statements = 0;
      const quota = await getPlatformQuota(measured, f.context);
      expect(quota.sharedStorageAvailableBytes).toBe(count ? count * 1048576 : null);
      expect(statements).toBeLessThanOrEqual(6);
    }
    statements = 0;
    const personal = await getPlatformQuota(measured, f.context, undefined, {
      NH_STORAGE_POLICY: 'PER_USER_BUDGET',
    });
    expect(personal.sharedStorageAvailableBytes).toBeNull();
    expect(personal.limits.storageMiB).toBeGreaterThan(0);
    expect(statements).toBeLessThanOrEqual(5);
  } finally {
    await database.destroy();
  }
});
