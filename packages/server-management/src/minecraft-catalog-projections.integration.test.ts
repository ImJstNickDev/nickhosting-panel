import { createHash } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { fetchForgeCatalog, forgeCatalogUrls } from '@nickhosting/minecraft';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getForgeCatalog } from './forge-catalog.js';
import { minecraftCatalogGames, minecraftCatalogLoaders } from './minecraft-catalog-projections.js';
import { minecraftCatalog } from './minecraft-registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
async function forgeSnapshot() {
  const versions = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => {
      const game = `1.20.${i}`;
      return [game, Array.from({ length: 100 }, (_, v) => `${game}-47.${i}.${v}`)];
    }),
  );
  return fetchForgeCatalog({
    async read(url) {
      const bytes = Buffer.from(
        JSON.stringify(url === forgeCatalogUrls.versions ? versions : { promos: {} }),
      );
      return {
        bytes,
        evidence: {
          url,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          retrievedAt: '2026-01-01T00:00:00Z',
        },
      };
    },
  });
}
it('reuses one validated Forge projection across eligible choices and release detail, invalidating legacy writes', async () => {
  const f = await managementFixture(database.db, { interactive: true });
  await f.db
    .insertInto('game_integrations')
    .values({ id: 'minecraft', version: '1.0.0', manifest: {} })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await f.db
    .insertInto('game_rollouts')
    .values({ integration_id: 'minecraft', state: 'public', allowlist: [] })
    .onConflict((c) => c.column('integration_id').doUpdateSet({ state: 'public' }))
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'minecraft', runtime_id: 'forge' })
    .where('id', '=', f.mappingId)
    .execute();
  const snapshot = await forgeSnapshot();
  const document = JSON.stringify(snapshot);
  await f.db
    .updateTable('minecraft_metadata_sync')
    .set({ manifest_json: document, last_success_at: new Date() })
    .where('id', '=', 'forge')
    .execute();
  const rows: Array<{ document: unknown }> = [];
  const db = f.db.withPlugin({
    transformQuery: (args) => args.node,
    async transformResult(args) {
      for (const row of args.result.rows) {
        if ('document' in row) rows.push(row as { document: unknown });
      }
      return args.result;
    },
  });
  const original = await getForgeCatalog(f.db);
  const expected = original.versions.map((v) => v.minecraftVersion);
  const seen = (
    await minecraftCatalog(db, f.context, {}, undefined, { mappingIds: [f.mappingId] })
  ).map((choice) => choice.version);
  expect(seen.sort()).toEqual([...expected].sort());
  expect(rows).toHaveLength(1);
  expect(rows[0]?.document).toEqual(snapshot);
  const version = '1.20.9';
  const loaders = original.versions
    .find((x) => x.minecraftVersion === version)
    ?.loaders.map((x) => x.version);
  const selectedLoaders = await minecraftCatalogLoaders(db, 'forge', version);
  expect(selectedLoaders).toEqual(loaders);
  expect(Reflect.set(selectedLoaders, 0, 'changed')).toBe(false);
  const games = await minecraftCatalogGames(db, 'forge');
  const first = games[0];
  if (!first) throw Error('missing fixture');
  expect(Reflect.set(first, 'version', 'changed')).toBe(false);
  expect(Reflect.set(games, 0, { version: 'changed' })).toBe(false);
  expect(await minecraftCatalogLoaders(db, 'forge', version)).toEqual(loaders);
  expect((await minecraftCatalogGames(db, 'forge')).map((game) => game.version)).toEqual(expected);
  expect(rows.at(-1)?.document).toBeNull();
  expect(await minecraftCatalogLoaders(db, 'forge', 'absent')).toEqual([]);
  const scoped = {
    loader: 'forge',
    minecraftVersion: version,
    loaderVersion: loaders?.[0],
  } as const;
  const subset = await minecraftCatalogGames(db, 'forge', scoped);
  expect(Reflect.set(subset, 0, { version: 'changed' })).toBe(false);
  expect(subset).toEqual([{ version, stable: true }]);
  expect(await minecraftCatalogGames(db, 'forge', { ...scoped, loaderVersion: 'unknown' })).toEqual(
    [],
  );
  expect(rows.filter((row) => row.document !== null)).toHaveLength(1);
  await db.transaction().execute(async (tx) => {
    await minecraftCatalogLoaders(tx, 'forge', version);
    const invalid = { ...snapshot, versions: snapshot.versions.slice(1) };
    // A legacy writer edits the document without advancing a hash or timestamp.
    await tx
      .updateTable('minecraft_metadata_sync')
      .set({ manifest_json: JSON.stringify(invalid) })
      .where('id', '=', 'forge')
      .execute();
    expect((await getForgeCatalog(tx)).synced).toBe(false);
    expect(await minecraftCatalogLoaders(tx, 'forge', version)).toEqual([]);
    expect(await minecraftCatalogGames(tx, 'forge')).toEqual([]);
    await tx
      .updateTable('minecraft_metadata_sync')
      .set({ manifest_json: document })
      .where('id', '=', 'forge')
      .execute();
    expect(await minecraftCatalogLoaders(tx, 'forge', version)).toEqual(loaders);
  });
  await db
    .updateTable('minecraft_metadata_sync')
    .set({ last_success_at: null })
    .where('id', '=', 'forge')
    .execute();
  expect(await minecraftCatalogLoaders(db, 'forge', version)).toEqual([]);
});
it('keeps global Fabric loaders, stable flags, target filtering and last-good rules for older snapshots', async () => {
  const { db } = database;
  const games = [
    { version: '22w01a', stable: false },
    { version: '1.21', stable: true },
  ];
  const loaders = [
    { version: '0.17.1', stable: true },
    { version: '0.16.0', stable: false },
  ];
  await db
    .updateTable('minecraft_metadata_sync')
    .set({
      last_success_at: new Date(),
      manifest_json: JSON.stringify({
        games,
        loaders,
        installers: [{ version: '1.0.0', stable: true }],
      }),
    })
    .where('id', '=', 'fabric')
    .execute();
  expect(await minecraftCatalogGames(db, 'fabric')).toEqual(games);
  expect(await minecraftCatalogLoaders(db, 'fabric', 'not-a-listed-version')).toEqual(
    loaders.map((v) => v.version),
  );
  expect(
    await minecraftCatalogGames(db, 'fabric', {
      loader: 'fabric',
      loaderVersion: '0.17.1',
      minecraftVersion: '22w01a',
    }),
  ).toEqual([games[0]]);
  expect(
    await minecraftCatalogGames(db, 'fabric', { loader: 'fabric', minecraftVersion: '1.21' }),
  ).toEqual([]);
  await db
    .updateTable('minecraft_metadata_sync')
    .set({ manifest_json: '{}' })
    .where('id', '=', 'fabric')
    .execute();
  expect(await minecraftCatalogGames(db, 'fabric')).toEqual([]);
  expect(await minecraftCatalogLoaders(db, 'fabric', '1.21')).toEqual([]);
});
