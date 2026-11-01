import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ApplicationServer, Backup, Resources } from '@nickhosting/pterodactyl-adapter';
import { sql } from 'kysely';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkStorage } from './admission.js';
import { storageCommitments } from './storage-accounting.js';
import { refreshStorageObservations } from './storage-observations.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let serverId: string;
let remote: ApplicationServer;
let backups: Backup[];
const resources: Resources = {
  current_state: 'running',
  is_suspended: false,
  resources: {
    memory_bytes: 64 * 1048576,
    cpu_absolute: 12.5,
    disk_bytes: 100 * 1048576,
    network_rx_bytes: 13,
    network_tx_bytes: 17,
    uptime: 1000,
  },
};
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
  backups = [
    {
      uuid: randomUUID(),
      is_successful: true,
      is_locked: false,
      name: 'retained backup',
      ignored_files: [],
      checksum: null,
      bytes: 800 * 1048576,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    },
  ];
  f.adapter.getApplicationServer = vi.fn(async () => structuredClone(remote));
  f.adapter.getResources = vi.fn(async () => structuredClone(resources));
  f.adapter.listBackups = vi.fn(async () => structuredClone(backups));
  await f.db.deleteFrom('server_metrics').where('server_id', '=', serverId).execute();
});
afterEach(async () => {
  await database?.destroy();
});
async function commitments() {
  const server = await f.db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow();
  return storageCommitments(f.db, [{ ...server, feature_limits: { backups: 1 } }]);
}
it('refreshes admission evidence and charges retained backups larger than live data', async () => {
  await expect(commitments()).rejects.toMatchObject({ code: 'integration_unavailable' });
  expect(await refreshStorageObservations(f.db, f.adapter, {}, serverId)).toEqual({ observed: 1 });
  expect((await commitments()).get(serverId)).toBe(900);
  const metric = await f.db
    .selectFrom('server_metrics')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
  expect(metric).toMatchObject({
    disk_bytes: String(100 * 1048576),
    backup_bytes: String(800 * 1048576),
    memory_bytes: String(64 * 1048576),
    cpu_percent: 12.5,
    network_rx_bytes: '13',
    network_tx_bytes: '17',
  });
  await f.observe();
  await f.db
    .updateTable('physical_hosts')
    .set({ storage_pool_mib: '850' })
    .where('id', '=', f.hostId)
    .execute();
  await expect(
    f.db.transaction().execute((tx) => checkStorage(tx, f.context.subjectUserId, f.hostId, 0)),
  ).rejects.toMatchObject({ code: 'storage_exhausted' });
});
it.each(['unfinished', 'invalid-size', 'invalid-date', 'duplicate', 'unavailable'])(
  'fails closed for %s backup observations without inventing zero',
  async (kind) => {
    const first = backups[0];
    if (!first) throw new Error('Expected backup');
    if (kind === 'unfinished') first.completed_at = null;
    if (kind === 'invalid-size') first.bytes = Number.NaN;
    if (kind === 'invalid-date') first.completed_at = 'invalid';
    if (kind === 'duplicate') backups.push({ ...first });
    if (kind === 'unavailable')
      vi.mocked(f.adapter.listBackups).mockRejectedValue(new Error('not available'));
    await expect(refreshStorageObservations(f.db, f.adapter, {})).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
    expect(await f.db.selectFrom('server_metrics').selectAll().execute()).toHaveLength(0);
    await expect(commitments()).rejects.toMatchObject({ code: 'integration_unavailable' });
  },
);
it('corroborates provider identity before reading usage', async () => {
  remote.uuid = randomUUID();
  await expect(refreshStorageObservations(f.db, f.adapter, {})).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
  expect(f.adapter.getResources).not.toHaveBeenCalled();
  expect(await f.db.selectFrom('server_metrics').selectAll().execute()).toHaveLength(0);
});
it('does not publish observations after local identity or lifecycle changes during the provider read', async () => {
  vi.mocked(f.adapter.getResources).mockImplementationOnce(async () => {
    await f.db
      .updateTable('managed_servers')
      .set({ owner_id: f.owner.actorUserId, updated_at: new Date() })
      .where('id', '=', serverId)
      .execute();
    return structuredClone(resources);
  });
  await expect(refreshStorageObservations(f.db, f.adapter, {})).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
  expect(await f.db.selectFrom('server_metrics').selectAll().execute()).toHaveLength(0);
});
it('rejects stale samples instead of stamping slow provider reads as newly fresh', async () => {
  const started = Date.now();
  vi.mocked(f.adapter.listBackups).mockImplementationOnce(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(started + 10_000);
    return backups;
  });
  try {
    await expect(refreshStorageObservations(f.db, f.adapter, {})).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
  } finally {
    vi.restoreAllMocks();
  }
  expect(await f.db.selectFrom('server_metrics').selectAll().execute()).toHaveLength(0);
});
it('works on a pinned connection that already owns the server lock', async () => {
  await f.db.connection().execute(async (connection) => {
    const key = `:nickhosting:server:${serverId}`;
    await sql`select pg_advisory_lock(hashtextextended(current_schema() || ${key},0))`.execute(
      connection,
    );
    try {
      expect(await refreshStorageObservations(connection, f.adapter, {}, serverId)).toEqual({
        observed: 1,
      });
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${key},0))`.execute(
        connection,
      );
    }
  });
});
it('skips finite and unprovisioned servers without any provider traffic', async () => {
  await f.db
    .updateTable('managed_servers')
    .set({ limits: JSON.stringify({ ...f.limits, disk: 64 }) })
    .where('id', '=', serverId)
    .execute();
  expect(await refreshStorageObservations(f.db, f.adapter, {})).toEqual({ observed: 0 });
  await f.db
    .updateTable('managed_servers')
    .set({
      limits: JSON.stringify({ ...f.limits, disk: 0 }),
      pterodactyl_id: null,
      pterodactyl_uuid: null,
      pterodactyl_identifier: null,
    })
    .where('id', '=', serverId)
    .execute();
  expect(await refreshStorageObservations(f.db, f.adapter, {})).toEqual({ observed: 0 });
  expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
});
it('limits server-scoped collection to that physical host', async () => {
  const other = await managementFixture(f.db, { interactive: true });
  await other.server({ limits: { ...other.limits, disk: 0 } });
  expect(await refreshStorageObservations(f.db, f.adapter, {}, serverId)).toEqual({ observed: 1 });
  expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(1);
  expect(f.adapter.getApplicationServer).toHaveBeenCalledWith(remote.id);
});
it('waits for the companion read to finish even when one provider read fails', async () => {
  let complete: (value: Backup[]) => void = () => {
    throw new Error('Expected deferred read');
  };
  const backupRead = new Promise<Backup[]>((resolve) => {
    complete = resolve;
  });
  let finished = false;
  vi.mocked(f.adapter.getResources).mockRejectedValue(new DomainError('integration_unavailable'));
  vi.mocked(f.adapter.listBackups).mockImplementationOnce(async () => backupRead);
  const pending = refreshStorageObservations(f.db, f.adapter, {}).finally(() => {
    finished = true;
  });
  const outcome = expect(pending).rejects.toMatchObject({ code: 'integration_unavailable' });
  await vi.waitFor(() => expect(f.adapter.listBackups).toHaveBeenCalled());
  expect(finished).toBe(false);
  complete(backups);
  await outcome;
  expect(finished).toBe(true);
});

it.each(['mapping', 'host'] as const)(
  'scopes %s sampling away from an unavailable unrelated physical host',
  async (kind) => {
    const other = await managementFixture(f.db, { interactive: true });
    await other.server({ limits: { ...other.limits, disk: 0 } });
    vi.mocked(f.adapter.getApplicationServer).mockImplementation(async (id) => {
      if (id !== remote.id) throw new DomainError('integration_unavailable');
      return structuredClone(remote);
    });
    const scope = kind === 'mapping' ? { mappingId: f.mappingId } : { hostId: f.hostId };
    expect(await refreshStorageObservations(f.db, f.adapter, {}, scope)).toEqual({ observed: 1 });
    expect(f.adapter.getApplicationServer).toHaveBeenCalledTimes(1);
    expect(f.adapter.getApplicationServer).toHaveBeenCalledWith(remote.id);
    await expect(refreshStorageObservations(f.db, f.adapter, {})).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
  },
);

it('accepts concurrent telemetry timestamp, runtime and readiness updates with unchanged identity/configuration', async () => {
  vi.mocked(f.adapter.getResources).mockImplementationOnce(async () => {
    await f.db
      .updateTable('managed_servers')
      .set({
        runtime_state: 'running',
        readiness: 'ready',
        last_observed_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', serverId)
      .execute();
    return structuredClone(resources);
  });
  expect(await refreshStorageObservations(f.db, f.adapter, {}, { mappingId: f.mappingId })).toEqual(
    { observed: 1 },
  );
  expect((await commitments()).get(serverId)).toBe(900);
});

it('validates mapping and host scopes before provider access', async () => {
  await expect(
    refreshStorageObservations(f.db, f.adapter, {}, { mappingId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'not_found' });
  await expect(
    refreshStorageObservations(f.db, f.adapter, {}, { hostId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'not_found' });
  await expect(
    refreshStorageObservations(f.db, f.adapter, {}, { mappingId: 'invalid' }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  expect(f.adapter.getApplicationServer).not.toHaveBeenCalled();
});
