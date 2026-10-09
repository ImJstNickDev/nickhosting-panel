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
