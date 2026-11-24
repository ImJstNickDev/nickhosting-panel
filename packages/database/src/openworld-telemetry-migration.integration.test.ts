import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import { createTestDatabase } from './testing.js';

it('upgrades the registered Openworld manifest, preserving other entries on repeated migration', async () => {
  const fixture = await createTestDatabase();
  try {
    const extra = {
      id: 'console',
      titleKey: 'games.openworld.console',
      requiredCapability: 'console',
    };
    const previous = {
      ...openworldManifest,
      connection: { mode: 'custom-subdomain', zoneSettingKey: 'dnsBaseDomain' },
      capabilities: { ...openworldManifest.capabilities, players: false },
      serverPermissions: openworldManifest.serverPermissions.filter(
        (p) => p.key === 'game.openworld.dashboard.admin',
      ),
      management: [extra],
    };
    await fixture.db
      .insertInto('game_integrations')
      .values({
        id: 'openworld',
        version: previous.version,
        manifest: previous,
      })
      .execute();
    for (const name of [
      '080_openworld_telemetry_permissions.sql',
      '083_openworld_player_screenshots_permission.sql',
      '084_openworld_map_permissions.sql',
      '085_openworld_rules_seed_permissions.sql',
    ]) {
      const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await fixture.pool.query(migration);
      await fixture.pool.query(migration);
    }
    // The fixture starts with the latest indexes. Replay the service discovery upgrade
    // against the historical registry row, just as the migrator would.
    const discovery = await readFile(
      new URL('../migrations/096_openworld_dns_srv.sql', import.meta.url),
      'utf8',
    );
    await fixture.pool.query(`BEGIN; DROP INDEX dns_assignments_srv_upgrade; ${discovery}; COMMIT`);
    const stored = await fixture.db
      .selectFrom('game_integrations')
      .select('manifest')
      .where('id', '=', 'openworld')
      .executeTakeFirstOrThrow();
    expect(stored.manifest).toEqual({
      ...openworldManifest,
      management: [extra, ...openworldManifest.management],
    });
  } finally {
    await fixture.destroy();
  }
});
