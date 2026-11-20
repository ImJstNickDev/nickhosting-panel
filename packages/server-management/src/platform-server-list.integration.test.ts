import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getPlatformServer, listPlatformServers } from './platform-queries.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => database?.destroy());

it('keeps list query count bounded at 1, 10, 50 and 100 rows for owners, project viewers and direct subusers', async () => {
  const f = await managementFixture(database.db);
  const viewer = await managementFixture(f.db);
  const subuser = await managementFixture(f.db);
  const project = randomUUID();
  await f.db
    .insertInto('projects')
    .values({ id: project, name: 'Inventory', owner_id: f.context.subjectUserId })
    .execute();
  await f.db
    .insertInto('project_members')
    .values({ project_id: project, user_id: viewer.context.subjectUserId, role: 'viewer' })
    .execute();
  await sql`insert into managed_servers (id,owner_id,project_id,mapping_id,node_id,name,external_id,limits,installation_state,runtime_state)
    select gen_random_uuid(), ${f.context.subjectUserId}, ${project}, ${f.mappingId}, ${f.nodeId}, 'List ' || n, gen_random_uuid()::text,
           ${JSON.stringify(f.limits)}::jsonb, 'installed', 'offline' from generate_series(1,100) as n`.execute(
    f.db,
  );
  await sql`insert into server_subusers (server_id,user_id,permission_keys,created_by)
    select id, ${subuser.context.subjectUserId}, '["files.read"]'::jsonb, owner_id from managed_servers where project_id=${project}`.execute(
    f.db,
  );
  let queries = 0;
  const measured = f.db.withPlugin({
    transformQuery({ node }) {
      return node;
    },
    async transformResult({ result }) {
      // Derived tables are compiled separately, but only executed statements have a result.
      queries++;
      return result;
    },
  });
  for (const context of [f.owner, f.context, viewer.context, subuser.context]) {
    const counts = [];
    for (const limit of [1, 10, 50, 100]) {
      queries = 0;
      const page = await listPlatformServers(measured, context, { projectId: project, limit });
      counts.push(queries);
      expect(page.total).toBe(100);
      expect(page.items).toHaveLength(limit);
      const row = page.items[0];
      if (!row) throw new Error('Expected a visible server');
      const detail = await getPlatformServer(f.db, context, row.id);
      expect(row).toMatchObject({
        permissions: detail.permissions,
        permissionKeys: detail.permissionKeys,
        availableActions: detail.availableActions,
        firstStart: detail.firstStart,
        runtimeId: detail.runtimeId,
        gameId: detail.gameId,
      });
      if (context === subuser.context) expect(row.permissionKeys).toEqual(['files.read']);
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(10);
    expect(new Set(counts).size).toBe(1);
  }
});

it('serves the latest safe, current disk observation only to readers with console access', async () => {
  const f = await managementFixture(database.db);
  const other = await managementFixture(f.db);
  const id = await f.server();
  await f.db
    .insertInto('server_subusers')
    .values({
      server_id: id,
      user_id: other.context.subjectUserId,
      permission_keys: JSON.stringify(['files.read']),
      created_by: f.context.subjectUserId,
    })
    .execute();
  const now = Date.now();
  async function sample(offset: number, bytes: string) {
    const at = new Date(now + offset);
    await f.db
      .insertInto('server_metrics')
      .values({
        server_id: id,
        observed_at: at,
        disk_bytes: bytes,
        memory_bytes: '0',
        cpu_percent: 0,
        network_rx_bytes: '0',
        network_tx_bytes: '0',
      })
      .execute();
    return at;
  }
  const usage = async (context = f.context) =>
    (await listPlatformServers(f.db, context, { ownerId: f.context.subjectUserId })).items.find(
      (row) => row.id === id,
    )?.diskUsage;
  expect(await usage()).toBeNull();
  await sample(-60_000, '123');
  expect(await usage()).toBeNull();
  const fresh = await sample(-1_000, '0');
  const expected = {
    bytes: 0,
    observedAt: fresh.toISOString(),
    expiresAt: new Date(fresh.getTime() + 30_000).toISOString(),
  };
  expect(await usage()).toEqual(expected);
  expect(await usage(other.context)).toBeNull();
  await f.db
    .updateTable('server_subusers')
    .set({ permission_keys: JSON.stringify(['console.read']) })
    .where('server_id', '=', id)
    .where('user_id', '=', other.context.subjectUserId)
    .execute();
  expect(await usage(other.context)).toEqual(expected);
  await sample(-500, '9007199254740992');
  expect(await usage()).toBeNull();
  await sample(60_000, '90');
  expect(await usage()).toBeNull();
});

it('can list project members and their permissions on an installation predating direct grants', async () => {
  const f = await managementFixture(database.db);
  const other = await managementFixture(f.db);
  const id = await f.server();
  const project = randomUUID();
  await f.db
    .insertInto('projects')
    .values({ id: project, name: 'Legacy', owner_id: f.context.subjectUserId })
    .execute();
  await f.db
    .updateTable('managed_servers')
    .set({ project_id: project })
    .where('id', '=', id)
    .execute();
  await f.db
    .insertInto('project_members')
    .values({ project_id: project, user_id: other.context.subjectUserId, role: 'viewer' })
    .execute();
  await f.db.transaction().execute(async (tx) => {
    await sql`alter table server_subusers rename to fixture_hidden_subusers`.execute(tx);
    const page = await listPlatformServers(tx, other.context, { projectId: project });
    expect(page.items.map((s) => s.id)).toEqual([id]);
    expect(page.items[0]?.permissionKeys).toContain('console.read');
    await sql`alter table fixture_hidden_subusers rename to server_subusers`.execute(tx);
  });
});
