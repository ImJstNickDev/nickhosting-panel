import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checkStorage } from './admission.js';
import { storageCommitments } from './storage-accounting.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let id: string;
beforeEach(async () => {
  database = await createTestDatabase();
  f = await managementFixture(database.db);
  id = await f.server({ limits: { ...f.limits, disk: 0 } });
});
afterEach(async () => {
  await database?.destroy();
});
async function sample(diskMiB: number, backupMiB: number | null, at = new Date()) {
  await f.db.deleteFrom('server_metrics').where('server_id', '=', id).execute();
  await f.db
    .insertInto('server_metrics')
    .values({
      server_id: id,
      observed_at: at,
      disk_bytes: String(diskMiB * 1048576),
      backup_bytes: backupMiB === null ? null : String(backupMiB * 1048576),
      memory_bytes: '0',
      cpu_percent: 0,
      network_rx_bytes: '0',
      network_tx_bytes: '0',
    })
    .execute();
}
async function commitment() {
  const server = await f.db
    .selectFrom('managed_servers')
    .select(['id', 'limits', 'pterodactyl_id'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return (await storageCommitments(f.db, [{ ...server, feature_limits: { backups: 1 } }])).get(id);
}
it('charges retained backups after live files shrink and refuses pool overcommit', async () => {
  await sample(1024, 20 * 1024);
  expect(await commitment()).toBe(21 * 1024);
  await f.db
    .updateTable('physical_hosts')
    .set({ storage_pool_mib: String(22 * 1024) })
    .where('id', '=', f.hostId)
    .execute();
  await expect(
    f.db.transaction().execute((tx) => checkStorage(tx, f.context.subjectUserId, f.hostId, 2048)),
  ).rejects.toMatchObject({ code: 'storage_exhausted' });
  await f.db
    .transaction()
    .execute((tx) => checkStorage(tx, f.context.subjectUserId, f.hostId, 512));
});
it('requires fresh complete disk and backup observations rather than treating unknown as empty', async () => {
  await sample(1024, null);
  await expect(commitment()).rejects.toMatchObject({ code: 'integration_unavailable' });
  await sample(1024, 0, new Date(0));
  await expect(commitment()).rejects.toMatchObject({ code: 'integration_unavailable' });
  await sample(1024, 0, new Date(Date.now() + 60_000));
  await expect(commitment()).rejects.toMatchObject({ code: 'integration_unavailable' });
  await sample(1024, 0);
  expect(await commitment()).toBe(2048);
});
it('keeps bootstrap working space bounded before provider provisioning exists', async () => {
  const result = await storageCommitments(
    f.db,
    [
      {
        id: randomUUID(),
        limits: { disk: 0 },
        feature_limits: { backups: 2 },
        pterodactyl_id: null,
      },
    ],
    { NH_DEFAULT_SERVER_STORAGE_MIB: '512' },
  );
  expect([...result.values()]).toEqual([1536]);
});
