import { randomUUID } from 'node:crypto';
import { createLogger } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  getGatewayState,
  type ManagementRuntime,
  setGatewayPolicy,
} from '@nickhosting/server-management';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { reconcileServers } from './reconcile.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
it('retired and invalid Gateway states cannot starve other servers or external recovery', async () => {
  const f = await managementFixture(database.db, { interactive: true });
  const ids = await Promise.all([f.server(), f.server(), f.server()]);
  for (const id of ids)
    await setGatewayPolicy(f.db, f.context, id, {
      enabled: true,
      protocolId: 'fixture',
      gameVersion: '1',
      idleTimeoutSeconds: null,
      readinessTimeoutSeconds: 1,
      readinessMaxAgeSeconds: 15,
      estimateMaxAgeSeconds: 60,
      wakeRetrySeconds: 1,
    });
  const [deleted, invalid, waiting] = ids;
  if (!deleted || !invalid || !waiting) throw new Error('Missing fixture');
  await f.db
    .updateTable('managed_servers')
    .set({ deleted_at: new Date() })
    .where('id', '=', deleted)
    .execute();
  await f.db
    .updateTable('managed_servers')
    .set({ pterodactyl_uuid: null, pterodactyl_id: null, pterodactyl_identifier: null })
    .where('id', '=', invalid)
    .execute();
  await f.db
    .updateTable('gateway_server_states')
    .set({ state: 'waking', startup_deadline_at: new Date(Date.now() - 2000) })
    .where('server_id', '=', waiting)
    .execute();
  const reconcile = vi.fn(async () => ({ external: { failed: 0 }, unavailable: [] }));
  const events: unknown[] = [];
  await reconcileServers(
    f.db,
    async () => ({ reconcile }) as unknown as ManagementRuntime,
    createLogger((record) => events.push(record)),
    {},
  );
  expect(reconcile).toHaveBeenCalledOnce();
  expect((await getGatewayState(f.db, waiting)).state).not.toBe('waking');
  expect(JSON.stringify(events)).toContain(invalid);
  expect(JSON.stringify(events)).not.toContain(deleted);
  // A separate missing provider ID does not create/import a new server.
  expect(
    await f.db.selectFrom('managed_servers').selectAll().where('id', '=', randomUUID()).execute(),
  ).toEqual([]);
});

it('continues credential recovery after the last server is deleted', async () => {
  const isolated = await createTestDatabase();
  try {
    const f = await managementFixture(isolated.db, { interactive: true });
    const serverId = await f.server();
    await f.db
      .insertInto('external_sftp_credentials')
      .values({
        id: randomUUID(),
        server_id: serverId,
        actor_id: f.context.actorUserId,
        envelope: JSON.stringify({ fixture: true }),
        provider_ref: null,
        expires_at: new Date(Date.now() + 60_000),
        state: 'revoking',
      })
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ deleted_at: new Date() })
      .where('id', '=', serverId)
      .execute();
    const reconcile = vi.fn(async () => ({ external: { failed: 0 }, unavailable: [] }));
    await reconcileServers(
      f.db,
      async () => ({ reconcile }) as unknown as ManagementRuntime,
      createLogger(() => {}),
      {},
    );
    expect(reconcile).toHaveBeenCalledOnce();
    await f.db.updateTable('external_sftp_credentials').set({ state: 'revoked' }).execute();
    reconcile.mockClear();
    await reconcileServers(
      f.db,
      async () => ({ reconcile }) as unknown as ManagementRuntime,
      createLogger(() => {}),
      {},
    );
    expect(reconcile).not.toHaveBeenCalled();
  } finally {
    await isolated.destroy();
  }
});

it('runs shared-host registration reconciliation before the first server exists', async () => {
  const isolated = await createTestDatabase();
  try {
    const f = await managementFixture(isolated.db, { interactive: true });
    const game = await f.db
      .selectFrom('game_integrations')
      .select('manifest')
      .where('id', '=', f.gameId)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('game_integrations')
      .set({
        manifest: JSON.stringify({
          ...(game.manifest as Record<string, unknown>),
          connection: { mode: 'shared-host', defaultLabel: 'fixture', allowCustomSubdomain: false },
        }),
      })
      .where('id', '=', f.gameId)
      .execute();
    const reconcile = vi.fn(async () => ({ external: { failed: 0 }, unavailable: [] }));
    await reconcileServers(
      f.db,
      async () => ({ reconcile }) as unknown as ManagementRuntime,
      createLogger(() => {}),
      {},
    );
    expect(reconcile).toHaveBeenCalledOnce();
  } finally {
    await isolated.destroy();
  }
});

it('reconciles a consumed hostname claim when its server was deleted before DNS intent existed', async () => {
  const isolated = await createTestDatabase();
  try {
    const f = await managementFixture(isolated.db, { interactive: true });
    const serverId = await f.server();
    await f.db
      .insertInto('dns_hostname_reservations')
      .values({ hostname: 'orphan.example.test', owner_id: serverId, release_after: null })
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ deleted_at: new Date() })
      .where('id', '=', serverId)
      .execute();
    const reconcile = vi.fn(async () => ({ external: { failed: 0 }, unavailable: [] }));
    await reconcileServers(
      f.db,
      async () => ({ reconcile }) as unknown as ManagementRuntime,
      createLogger(() => {}),
      {},
    );
    expect(reconcile).toHaveBeenCalledOnce();
  } finally {
    await isolated.destroy();
  }
});
