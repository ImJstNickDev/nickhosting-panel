import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ApplicationServer, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openworldStartup } from '../../../games/openworld/src/dashboard-launch.js';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import { assignRoleAllocations } from './allocation-pool.js';
import type { GameLifecycleContext } from './lifecycle.js';
import {
  prepareOpenworldDashboardOnStart,
  readOpenworldDashboard,
  resolveOpenworldDashboardTarget,
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
  'rotates the legacy credential at a managed start with skip_scripts=%s and publishes independently of native administration',
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
    await f.db
      .insertInto('openworld_server_profiles')
      .values({ server_id: id, version: 'a1.2.9', sha256: 'a'.repeat(64), size: 1024 })
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
      OW_WEB_PASSWORD: skipScripts ? 'p'.repeat(43) : '',
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
    const baseState = { enabled: false, phase: 'disabled', hostname: null, nativePrepared: false };
    expect(await readOpenworldDashboard(f.db, f.context, id)).toEqual({
      ...baseState,
      canOpen: true,
      canConfigure: true,
    });
    expect(await readOpenworldDashboard(f.db, sub.context, id)).toEqual({
      ...baseState,
      canOpen: false,
      canConfigure: false,
    });
    await expect(updateOpenworldDashboard(f.db, sub.context, id, true)).rejects.toThrow(
      'forbidden',
    );
    await expect(updateOpenworldDashboard(f.db, f.context, id, true)).rejects.toThrow(
      'configuration_invalid',
    );
    await expect(resolveOpenworldDashboardTarget(f.db, adapter, id)).rejects.toThrow(
      'game_not_ready',
    );
    const hostname = `aurora-${id.slice(0, 8)}.example.test`;
    const assignment = randomUUID();
    await f.db
      .insertInto('dns_assignments')
      .values({
        id: assignment,
        server_id: id,
        hostname,
        ownership_token: randomUUID(),
        ledger: '[]',
        state: 'active',
        plan: JSON.stringify({ connection: { hostname } }),
      })
      .execute();
    await f.db
      .insertInto('server_dns_preferences')
      .values({ server_id: id, enabled: true, assignment_id: assignment })
      .onConflict((c) =>
        c.column('server_id').doUpdateSet({ assignment_id: assignment, enabled: true }),
      )
      .execute();
    await f.db
      .insertInto('dns_hostname_reservations')
      .values({ hostname, owner_id: assignment, release_after: null })
      .execute();
    expect(await updateOpenworldDashboard(f.db, f.context, id, true)).toMatchObject({
      enabled: true,
      nativePrepared: false,
      phase: 'pending',
      hostname,
    });
    expect(adapter.updateStartup).not.toHaveBeenCalled();
    const context = {
      db: f.db,
      server,
      adapter,
      authorize: vi.fn(),
    } as unknown as GameLifecycleContext;
    const secretVariable = egg.relationships.variables.data.find(
      (v) => v.attributes.env_variable === 'OW_WEB_PASSWORD',
    );
    if (!secretVariable) throw new Error('Missing fixture variable');
    secretVariable.attributes.user_viewable = true;
    await expect(prepareOpenworldDashboardOnStart(context)).rejects.toThrow('provenance_mismatch');
    expect(adapter.updateStartup).not.toHaveBeenCalled();
    secretVariable.attributes.user_viewable = false;
    await prepareOpenworldDashboardOnStart(context);
    await prepareOpenworldDashboardOnStart(context);
    expect(adapter.updateStartup).toHaveBeenCalledTimes(1);
    expect(adapter.updateStartup).toHaveBeenCalledWith(
      server.pterodactyl_id,
      expect.objectContaining({ skip_scripts: skipScripts }),
      true,
    );
    expect(context.authorize).toHaveBeenCalledOnce();
    const password = environment.OW_WEB_PASSWORD;
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(password).not.toBe('p'.repeat(43));
    await f.db
      .updateTable('managed_servers')
      .set({ runtime_state: 'running' })
      .where('id', '=', id)
      .execute();
    expect(await resolveOpenworldDashboardTarget(f.db, adapter, id)).toEqual({
      address: `http://${admin.backend_address}:${admin.port}`,
      password,
    });
    await f.db
      .updateTable('server_subusers')
      .set({ permission_keys: JSON.stringify(['game.openworld.dashboard.admin']) })
      .where('server_id', '=', id)
      .where('user_id', '=', sub.context.subjectUserId)
      .execute();
    const settings = await readOpenworldDashboard(f.db, sub.context, id);
    expect(settings).toMatchObject({
      enabled: true,
      canOpen: true,
      canConfigure: false,
      hostname,
      nativePrepared: true,
    });
    expect(Object.values(settings)).not.toContain(password);
    await expect(updateOpenworldDashboard(f.db, sub.context, id, false)).rejects.toThrow(
      'forbidden',
    );
    expect(await updateOpenworldDashboard(f.db, f.context, id, false)).toMatchObject({
      enabled: false,
      phase: 'disabled',
    });
    expect((await resolveOpenworldDashboardTarget(f.db, adapter, id)).password).toBe(password);
    expect(adapter.updateStartup).toHaveBeenCalledTimes(1);
    expect(environment.OW_VERSION).toBe('a1.2.9');
    const audit = await f.db
      .selectFrom('audit_events')
      .selectAll()
      .where('actor_user_id', '=', f.context.actorUserId)
      .execute();
    expect(JSON.stringify(audit)).not.toContain(password);
  },
);
