import { createLogger } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { requestFabricCatalogRefresh } from '@nickhosting/server-management';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startMinecraftMetadataLoop } from './minecraft-metadata.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => database?.destroy());

it('reads only scheduling columns at rest and two replicas elect one downloader after an Owner request', async () => {
  const next = new Date(Date.now() + 600_000);
  await database.db
    .insertInto('minecraft_metadata_sync')
    .values({
      id: 'mojang',
      manifest_json: null,
      manifest_hash: null,
      lease_id: null,
      lease_until: null,
      last_checked_at: null,
      last_success_at: null,
      last_error: null,
    })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await database.db
    .updateTable('minecraft_metadata_sync')
    .set({
      next_check_at: next,
      manifest_json: JSON.stringify({ fixture: 'm'.repeat(256 * 1024) }),
    })
    .execute();

  const reads: unknown[][] = [];
  const measured = database.db.withPlugin({
    transformQuery({ node }) {
      return node;
    },
    async transformResult({ result }) {
      reads.push(result.rows);
      return result;
    },
  });
  const source = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
    expect(new Headers(options?.headers).get('User-Agent')).toBe(
      'Catalog fixture https://example.test',
    );
    return Response.json([{ version: '1.0', stable: true }]);
  });
  vi.stubGlobal('fetch', source);
  const env = { NH_CONTENT_METADATA_USER_AGENT: 'Catalog fixture https://example.test' };
  const logger = createLogger(() => {});
  const replicas = [
    startMinecraftMetadataLoop(measured, database.pool, env, logger),
    startMinecraftMetadataLoop(measured, database.pool, env, logger),
  ];
  try {
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    for (const rows of reads) {
      expect(rows).toHaveLength(8);
      expect(Object.keys(rows[0] as object).sort()).toEqual(['id', 'lease_until', 'next_check_at']);
      expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThan(1024);
    }
    expect(source).not.toHaveBeenCalled();
    await requestFabricCatalogRefresh(database.db);
    await vi.waitFor(
      async () => {
        const row = await database.db
          .selectFrom('minecraft_metadata_sync')
          .select(['lease_id', 'last_success_at', 'requested_at'])
          .where('id', '=', 'fabric')
          .executeTakeFirstOrThrow();
        expect(row.last_success_at).toBeInstanceOf(Date);
        expect(row.lease_id).toBeNull();
        expect(row.requested_at).toBeNull();
      },
      { timeout: 5000 },
    );
    expect(source).toHaveBeenCalledTimes(3);
  } finally {
    await Promise.all(replicas.map((r) => r.close()));
    vi.unstubAllGlobals();
  }
});
