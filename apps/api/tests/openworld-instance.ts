import { randomUUID } from 'node:crypto';
import type { Database } from '@nickhosting/database';
import { createPterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import { vi } from 'vitest';
import { openworldStartup } from '../../../games/openworld/src/dashboard-launch.js';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';

export async function openworldInstance(db: Kysely<Database>) {
  const owner = await managementFixture(db);
  const sub = await managementFixture(db);
  const id = await owner.server();
  await db
    .insertInto('game_integrations')
    .values({ id: 'openworld', version: openworldManifest.version, manifest: openworldManifest })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'openworld', runtime_id: 'dedicated' })
    .where('id', '=', owner.mappingId)
    .execute();
  await db
    .insertInto('openworld_server_profiles')
    .values({
      server_id: id,
      version: 'a1.2.9',
      sha256: 'a'.repeat(64),
      size: 123,
      dashboard_credential_prepared: true,
    })
    .execute();
  const game = await db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', id)
    .executeTakeFirstOrThrow();
  const admin = {
    ...game,
    id: randomUUID(),
    role: 'dashboard',
    port: game.port + 1,
    pterodactyl_allocation_id: game.pterodactyl_allocation_id + 1,
    protocols: ['tcp'] as ('tcp' | 'udp')[],
    is_primary: false,
    private_only: true,
    direct_endpoint: null,
  };
  await db.insertInto('server_allocations').values(admin).execute();
  await db
    .insertInto('server_subusers')
    .values({
      server_id: id,
      user_id: sub.context.subjectUserId,
      permission_keys: JSON.stringify(['settings.read']),
      created_by: owner.context.subjectUserId,
    })
    .execute();
  const grant = (...keys: string[]) =>
    db
      .updateTable('server_subusers')
      .set({ permission_keys: JSON.stringify(keys) })
      .where('server_id', '=', id)
      .where('user_id', '=', sub.context.subjectUserId)
      .execute();
  const power = (state: 'running' | 'offline') =>
    db.updateTable('managed_servers').set({ runtime_state: state }).where('id', '=', id).execute();
  const target = vi.fn(async () => ({
    address: `http://${admin.backend_address}:${admin.port}`,
    password: 'p'.repeat(43),
  }));
  return { owner, sub, id, grant, power, target, game, admin };
}

export async function openworldNativeProvider(
  db: Kysely<Database>,
  { id, owner, game, admin }: Awaited<ReturnType<typeof openworldInstance>>,
) {
  const server = await db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  const origin = `http://${admin.backend_address}:${admin.port}`;
  const password = 'p'.repeat(43);
  const remote = {
    id: server.pterodactyl_id,
    external_id: server.external_id,
    uuid: server.pterodactyl_uuid,
    identifier: server.pterodactyl_identifier,
    name: server.name,
    description: null,
    suspended: false,
    limits: owner.limits,
    feature_limits: { databases: 0, allocations: 3, backups: 1 },
    user: server.provider_user_id,
    node: owner.providerNodeId,
    allocation: game.pterodactyl_allocation_id,
    nest: 1,
    egg: 1,
    container: {
      startup_command: openworldStartup,
      image: 'fixture',
      installed: true,
      environment: { OW_WEB_PORT: String(admin.port), OW_WEB_PASSWORD: password },
    },
    relationships: {
      allocations: {
        object: 'list',
        data: [game, admin].map((row) => ({
          attributes: {
            id: row.pterodactyl_allocation_id,
            ip: row.address,
            port: row.port,
            assigned: true,
          },
        })),
      },
    },
    created_at: server.created_at.toISOString(),
    updated_at: server.updated_at.toISOString(),
  };
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const { pathname, search } = new URL(String(url));
    if (pathname !== `/api/application/servers/${remote.id}` || search !== '?include=allocations')
      throw new Error('Unexpected provider request');
    return Response.json({ object: 'server', attributes: remote });
  });
  const adapter = createPterodactylAdapter({
    baseURL: 'https://panel.example.test',
    applicationKey: 'fixture-application-key',
    fetcher,
  });
  return { adapter, fetcher, remote, origin, password };
}
