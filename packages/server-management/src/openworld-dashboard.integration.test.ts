import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ApplicationServer, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openworldStartup } from '../../../games/openworld/src/dashboard-launch.js';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import { assignRoleAllocations } from './allocation-pool.js';
import {
  readOpenworldDashboard,
  revealOpenworldDashboardPassword,
  updateOpenworldDashboard,
} from './openworld-dashboard.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

it('keeps a private role on a non-public pin even when the game uses direct delivery', () => {
  const direct = {
    id: 1,
    ip: '10.0.0.1',
    backendAddress: '10.0.0.1',
    port: 25001,
    assigned: false,
    directEndpoint: { hostname: 'game.example', port: 25001 },
  };
  const internal = {
    id: 2,
    ip: '10.0.0.2',
    backendAddress: '10.0.0.2',
    port: 25002,
    assigned: false,
  };
  const roles = [
    { role: 'game', primary: true },
    { role: 'dashboard', primary: false },
  ];
  const claims = assignRoleAllocations(
    roles,
    new Set(['dashboard']),
    [internal, direct],
    'direct',
    false,
  );
  expect(claims.get('game')).toBe(direct);
  expect(claims.get('dashboard')).toBe(internal);
  const collision = { ...internal, id: 4, port: direct.port };
  const alternative = assignRoleAllocations(
    roles,
    new Set(['dashboard']),
    [collision, direct, internal],
    'direct',
    false,
  );
  expect(alternative.get('dashboard')).toBe(internal);
  expect(alternative.get('game')).toBe(direct);
  expect(() =>
    assignRoleAllocations(roles, new Set(['dashboard']), [collision, direct], 'direct', false),
  ).toThrow('allocation_unavailable');
  expect(() =>
    assignRoleAllocations(roles, new Set(['dashboard']), [direct], 'direct', false),
  ).toThrow('allocation_unavailable');
});

it.each([false, true])(
  'preserves provider skip_scripts=%s and restricts the native dashboard credential to its owner',
  async (skipScripts) => {
    const f = await managementFixture(database.db);
    const id = await f.server();
    const sub = await managementFixture(database.db);
    await f.db
      .insertInto('game_integrations')
      .values({ id: 'openworld', version: openworldManifest.version, manifest: openworldManifest })
      .onConflict((c) => c.column('id').doNothing())
      .execute();
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ game_id: 'openworld', runtime_id: 'dedicated' })
      .where('id', '=', f.mappingId)
      .execute();
    const server = await f.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const game = await f.db
      .selectFrom('server_allocations')
      .selectAll()
      .where('server_id', '=', id)
      .executeTakeFirstOrThrow();
    const admin = {
      ...game,
      id: randomUUID(),
      pterodactyl_allocation_id: game.pterodactyl_allocation_id + 1,
      role: 'dashboard',
      port: game.port + 1,
      protocols: ['tcp'] as ('tcp' | 'udp')[],
      is_primary: false,
      private_only: true,
      direct_endpoint: null,
    };
    await f.db.insertInto('server_allocations').values(admin).execute();
    await f.db
      .insertInto('server_subusers')
      .values({
        server_id: id,
        user_id: sub.context.subjectUserId,
        permission_keys: JSON.stringify(['settings.read', 'settings.write']),
        created_by: f.context.subjectUserId,
      })
      .execute();
    const environment: Record<string, string | number | boolean> = {
      OW_WEB_PORT: String(admin.port),
      OW_WEB_PASSWORD: '',
      OW_VERSION: 'a1.2.9',
    };
    const remote = {
      id: server.pterodactyl_id,
      external_id: server.external_id,
      user: server.provider_user_id,
      node: f.providerNodeId,
      uuid: server.pterodactyl_uuid,
      identifier: server.pterodactyl_identifier,
      allocation: game.pterodactyl_allocation_id,
      egg: 1,
      nest: 1,
      container: {
        startup_command: openworldStartup,
        image: 'fixture',
        skip_scripts: skipScripts,
        environment,
      },
      relationships: {
        allocations: {
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
    } as unknown as ApplicationServer;
    const egg = {
      id: 1,
      nest: 1,
      startup: openworldStartup,
      relationships: {
        variables: {
          data: Object.keys(environment).map((env_variable) => ({
            attributes: {
              env_variable,
              user_viewable: false,
              user_editable: false,
              default_value: '',
            },
          })),
        },
      },
    };
    const adapter = {
      getEgg: vi.fn().mockResolvedValue(egg),
      getApplicationServer: vi.fn().mockResolvedValue(remote),
      updateStartup: vi.fn(
        async (_id: number, update: { environment: Record<string, string | number | boolean> }) => {
          Object.assign(environment, update.environment);
          return remote;
        },
      ),
    } as unknown as PterodactylAdapter;
    expect(await readOpenworldDashboard(f.db, adapter, f.context, id)).toEqual({
      enabled: false,
      privateAddress: null,
      canConfigure: true,
    });
    const confirmed = await updateOpenworldDashboard(f.db, adapter, f.context, id, true);
    expect(confirmed).toEqual({
      enabled: true,
      canConfigure: true,
      privateAddress: `http://${admin.backend_address}:${admin.port}`,
    });
    expect(adapter.updateStartup).toHaveBeenCalledWith(
      server.pterodactyl_id,
      expect.objectContaining({ skip_scripts: skipScripts }),
      true,
    );
    expect(adapter.getApplicationServer).toHaveBeenCalledTimes(2); // initial settings read and pre-mutation identity check
    const { password } = await revealOpenworldDashboardPassword(f.db, adapter, f.context, id);
    expect(password).toHaveLength(43);
    expect(await readOpenworldDashboard(f.db, adapter, sub.context, id)).toEqual({
      enabled: true,
      privateAddress: null,
      canConfigure: false,
    });
    await expect(revealOpenworldDashboardPassword(f.db, adapter, sub.context, id)).rejects.toThrow(
      'forbidden',
    );
    await expect(updateOpenworldDashboard(f.db, adapter, sub.context, id, false)).rejects.toThrow(
      'forbidden',
    );
    await updateOpenworldDashboard(f.db, adapter, f.context, id, true);
    expect(adapter.updateStartup).toHaveBeenCalledTimes(1);
    const audit = await f.db
      .selectFrom('audit_events')
      .selectAll()
      .where('actor_user_id', '=', f.context.actorUserId)
      .execute();
    expect(JSON.stringify(audit)).not.toContain(password);
    await updateOpenworldDashboard(f.db, adapter, f.context, id, false);
    expect(environment.OW_WEB_PASSWORD).toBe('');
    expect(environment.OW_VERSION).toBe('a1.2.9');
    await expect(revealOpenworldDashboardPassword(f.db, adapter, f.context, id)).rejects.toThrow(
      'game_not_ready',
    );
    const secretVariable = egg.relationships.variables.data.find(
      (v) => v.attributes.env_variable === 'OW_WEB_PASSWORD',
    );
    if (!secretVariable) throw new Error('Expected fixture variable');
    secretVariable.attributes.user_viewable = true;
    await expect(updateOpenworldDashboard(f.db, adapter, f.context, id, true)).rejects.toThrow(
      'provenance_mismatch',
    );
    expect(adapter.updateStartup).toHaveBeenCalledTimes(2);
  },
);
