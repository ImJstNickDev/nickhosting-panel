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
    const sql = await readFile(
      new URL('../migrations/080_openworld_telemetry_permissions.sql', import.meta.url),
      'utf8',
    );
    await fixture.pool.query(sql);
    await fixture.pool.query(sql);
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
