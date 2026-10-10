import { createHash } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  minecraftDeclaredCapabilities,
  minecraftManifest,
  minecraftManifestUrl,
} from '@nickhosting/minecraft';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncMinecraftCatalog } from './minecraft-catalog.js';
import { minecraftCatalog } from './minecraft-registry.js';
import { setRuntimeMapping } from './registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
const image = 'ghcr.io/pterodactyl/yolks:java_21';
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  await f.db
    .insertInto('game_integrations')
    .values({ id: 'minecraft-java', version: '1.0.0', manifest: JSON.stringify(minecraftManifest) })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await f.db
    .insertInto('game_rollouts')
    .values({ integration_id: 'minecraft-java', state: 'public', allowlist: [] })
    .onConflict((c) => c.column('integration_id').doUpdateSet({ state: 'public', allowlist: [] }))
    .execute();
  await setRuntimeMapping(f.db, adapter(), f.owner, {
    id: f.mappingId,
    gameId: 'minecraft-java',
    runtimeId: 'vanilla',
    nodeId: f.nodeId,
    nestId: 1,
    eggId: 1,
    imageMode: 'integration',
    startup: 'java -jar server.jar',
    environment: {},
    portRoles: [{ role: 'game', protocols: ['tcp'], primary: true }],
    featureLimits: { databases: 0, allocations: 1, backups: 0 },
  });
});
function adapter(unknown = false) {
  return {
    ...f.adapter,
    getEgg: async () => ({
      id: 1,
      nest: 1,
      docker_image: image,
      config: { stop: 'stop' },
      relationships: {
        variables: {
          data: [
            {
              attributes: {
                env_variable: unknown ? 'CUSTOM_VERSION' : 'VANILLA_VERSION',
                default_value: 'latest',
              },
            },
            { attributes: { env_variable: 'SERVER_JARFILE', default_value: 'server.jar' } },
          ],
        },
      },
    }),
  } as unknown as PterodactylAdapter;
}
function upstream() {
  const documents = new Map<string, Buffer>();
  const versions = [
    ['1.21.11', 'release', true],
    ['1.21.10', 'release', false],
    ['25w03a', 'snapshot', true],
  ] as const;
  const entries = versions.map(([id, type, server]) => {
    const url = `https://piston-meta.mojang.com/v1/packages/fixture/${id}.json`;
    const bytes = Buffer.from(
      JSON.stringify({
        id,
        javaVersion: { majorVersion: 21 },
        downloads: server
          ? {
              server: {
                url: 'https://piston-data.mojang.com/v1/objects/fixture/server.jar',
                sha1: 'a'.repeat(40),
                size: 1,
              },
            }
          : {},
      }),
    );
    documents.set(url, bytes);
    return { id, type, url, sha1: createHash('sha1').update(bytes).digest('hex') };
  });
  documents.set(minecraftManifestUrl, Buffer.from(JSON.stringify({ versions: entries })));
  const read = vi.fn(async (url: string) => {
    const bytes = documents.get(url);
    if (!bytes) throw new Error('unexpected upstream request');
    return {
      bytes,
      evidence: {
        url,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        retrievedAt: new Date().toISOString(),
      },
    };
  });
  return {
    metadata: { read },
    protocols: vi.fn(async () => ({
      source: { url: 'https://example.test/protocols', sha256: 'b'.repeat(64) },
      releases: new Map(),
    })),
  };
}
describe('Owner Vanilla catalog synchronization', () => {
  it('derives bindings, reports missing server downloads, remains idempotent and does not manufacture evidence', async () => {
    const source = upstream();
    const result = await syncMinecraftCatalog(
      f.db,
      adapter(),
      f.owner,
      { mappingId: f.mappingId },
      {},
      source,
    );
    expect(result.items[0]).toMatchObject({ version: '1.21.11', status: 'registered' });
    expect(result.items[1]).toMatchObject({
      status: 'unavailable',
      reason: 'minecraft_server_download_unavailable',
    });
    expect(
      source.metadata.read.mock.calls.filter(([url]) => url === minecraftManifestUrl),
    ).toHaveLength(1);
    const again = await syncMinecraftCatalog(
      f.db,
      adapter(),
      f.owner,
      { mappingId: f.mappingId },
      {},
      upstream(),
    );
    expect(again.items[0]?.id).toBe(result.items[0]?.id);
    const row = await f.db
      .selectFrom('minecraft_combinations')
      .selectAll()
      .where('id', '=', result.items[0]?.id ?? '')
      .executeTakeFirstOrThrow();
    expect(row.enabled).toBe(true);
    expect(row.binding).toMatchObject({
      bindings: { release: 'VANILLA_VERSION' },
      artifactPaths: { server: 'server.jar' },
    });
    expect(await minecraftCatalog(f.db, f.owner)).toContainEqual({
      id: row.id,
      version: '1.21.11',
      releaseType: 'release',
      runtime: 'vanilla',
      capabilities: minecraftDeclaredCapabilities(
        row.combination as Parameters<typeof minecraftDeclaredCapabilities>[0],
      ),
    });
    await f.db
      .updateTable('minecraft_combinations')
      .set({ enabled: false })
      .where('id', '=', row.id)
      .execute();
    await syncMinecraftCatalog(
      f.db,
      adapter(),
      f.owner,
      { mappingId: f.mappingId },
      {},
      upstream(),
    );
    expect(await minecraftCatalog(f.db, f.owner)).toEqual([]);
    await syncMinecraftCatalog(
      f.db,
      adapter(),
      f.owner,
      { mappingId: f.mappingId, enableSupported: true },
      {},
      upstream(),
    );
    expect((await minecraftCatalog(f.db, f.owner)).some((choice) => choice.id === row.id)).toBe(
      true,
    );

    expect(
      await f.db
        .selectFrom('minecraft_verification_evidence')
        .selectAll()
        .where('combination_id', '=', row.id)
        .execute(),
    ).toEqual([]);
  });
  it('bounds pages and includes snapshots only when explicitly requested', async () => {
    const result = await syncMinecraftCatalog(
      f.db,
      adapter(),
      f.owner,
      { mappingId: f.mappingId, all: true, cursor: 2, limit: 1 },
      {},
      upstream(),
    );
    expect(result).toMatchObject({
      total: 3,
      nextCursor: null,
      items: [{ version: '25w03a', releaseType: 'snapshot', status: 'registered' }],
    });
    await expect(
      syncMinecraftCatalog(
        f.db,
        adapter(),
        f.owner,
        { mappingId: f.mappingId, limit: 21 },
        {},
        upstream(),
      ),
    ).rejects.toThrow();
  });
  it('reports unsupported egg contracts and rejects ordinary users before discovery', async () => {
    const source = upstream();
    const result = await syncMinecraftCatalog(
      f.db,
      adapter(true),
      f.owner,
      { mappingId: f.mappingId, limit: 1 },
      {},
      source,
    );
    expect(result.items[0]).toMatchObject({
      status: 'unavailable',
      reason: 'minecraft_egg_contract_unsupported',
    });
    const denied = upstream();
    await expect(
      syncMinecraftCatalog(
        f.db,
        adapter(),
        { ...f.owner, role: 'user' },
        { mappingId: f.mappingId },
        {},
        denied,
      ),
    ).rejects.toThrow('forbidden');
    expect(denied.metadata.read).not.toHaveBeenCalled();
  });
});
