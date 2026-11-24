import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { expect, it, vi } from 'vitest';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { createOpenworldInspector } from './openworld-inspector.js';

it('checks seed grants on cached and in-flight reads and reads the private catalog while publication is off', async () => {
  const database = await createTestDatabase(),
    db = database.db;
  try {
    const owner = await managementFixture(db),
      sub = await managementFixture(db),
      id = await owner.server();
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
    const target = vi.fn(async () => ({
      address: `http://${admin.backend_address}:${admin.port}`,
      password: 'fixture'.repeat(8),
    }));
    const grant = async (...keys: string[]) =>
      db
        .insertInto('server_subusers')
        .values({
          server_id: id,
          user_id: sub.context.subjectUserId,
          permission_keys: JSON.stringify(keys),
          created_by: owner.context.subjectUserId,
        })
        .onConflict((c) =>
          c
            .columns(['server_id', 'user_id'])
            .doUpdateSet({ permission_keys: JSON.stringify(keys) }),
        )
        .execute();
    let now = Date.now(),
      nativeReads = 0;
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/live/auth')
        return Response.json({ required: true, loopback: false, canAct: false });
      if (url.pathname === '/api/live/login') return Response.json({ token: 'test-only' });
      expect(url.pathname).toBe('/api/info');
      expect(new Headers(init?.headers).has('x-ow-token')).toBe(false);
      if (++nativeReads === 2) {
        entered.resolve();
        await release.promise;
      }
      return Response.json({
        seed: '98446744073709551618',
        planet: 'earth',
        planets: [{ key: 'earth', name: 'Earth' }],
        version: 7,
        faceEdgeMeters: 11000,
        planetRadiusMeters: 3000,
        voxelSize: 0.25,
        spawn: { face: 2, x: 30, z: 50 },
        biomes: [{ key: 'coast', name: 'Coast', privateField: 'omit' }],
        materials: [],
        featureKinds: [],
        treeSpecies: [],
        unrelated: 'omit',
      });
    };
    const inspector = createOpenworldInspector({ db, target, fetcher, now: () => now });
    await grant('game.openworld.map.read');
    await expect(inspector(sub.context, id)).rejects.toMatchObject({ code: 'forbidden' });
    await grant('game.openworld.seed.inspect');
    await expect(inspector(sub.context, id)).rejects.toMatchObject({ code: 'game_not_ready' });
    expect(target).not.toHaveBeenCalled();
    await db
      .updateTable('managed_servers')
      .set({ runtime_state: 'running' })
      .where('id', '=', id)
      .execute();
    const data = await inspector(sub.context, id);
    expect(data).toMatchObject({
      seed: '98446744073709551618',
      inspectorUrl: null,
      inspectorPublished: false,
      biomes: [{ key: 'coast', name: 'Coast' }],
    });
    expect(JSON.stringify(data)).not.toContain('omit');
    expect(await inspector(owner.context, id)).toEqual(data);
    expect(nativeReads).toBe(1);
    await grant('game.openworld.map.read');
    await expect(inspector(sub.context, id)).rejects.toMatchObject({ code: 'forbidden' });
    now += 31000;
    await grant('game.openworld.seed.inspect');
    const blocked = inspector(sub.context, id);
    await entered.promise;
    await grant('game.openworld.map.read');
    release.resolve();
    await expect(blocked).rejects.toMatchObject({ code: 'forbidden' });
  } finally {
    await database.destroy();
  }
});
