import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { type ApplicationServer, PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilemanReadService } from '../../game-sdk/src/fileman-read.js';
import {
  dueMinecraftWorldIndexes,
  readMinecraftWorldFilemanIndex,
  readMinecraftWorldIndex,
  reconcileDueMinecraftWorldIndex,
  refreshMinecraftWorldIndex,
} from './minecraft-world-index.js';
import { createMinecraftWorldPreparation } from './minecraft-world-preparation.js';
import { minecraftManagementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeEach(async () => {
  database = await createTestDatabase();
});
afterEach(async () => {
  await database?.destroy();
});
async function fixture() {
  const db = database.db;
  const f = await minecraftManagementFixture(db);
  const serverId = await f.server();
  const combination = randomUUID();
  await db
    .insertInto('minecraft_combinations')
    .values({
      id: combination,
      mapping_id: f.mappingId,
      identity_digest: '1'.repeat(64),
      mapping_digest: '2'.repeat(64),
      binding: '{}',
      resolved_runtime: '{}',
      combination: JSON.stringify({
        release: '1.9',
        releaseType: 'release',
        protocolId: 106,
        family: 'netty',
        profile: 'vanilla',
        javaMajor: 8,
        runtimeDigest: '3'.repeat(64),
        protocolSource: { url: 'https://example.invalid/protocol', sha256: '4'.repeat(64) },
      }),
    })
    .execute();
  await db
    .insertInto('minecraft_server_profiles')
    .values({
      server_id: serverId,
      combination_id: combination,
      configuration: '{}',
      installed: true,
    })
    .execute();
  const server = await db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow();
  const allocation = await db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
  const remote = {
    id: server.pterodactyl_id,
    uuid: server.pterodactyl_uuid,
    identifier: server.pterodactyl_identifier,
    external_id: server.external_id,
    user: server.provider_user_id,
    node: f.providerNodeId,
    allocation: allocation.pterodactyl_allocation_id,
    relationships: {
      allocations: {
        data: [
          {
            attributes: {
              id: allocation.pterodactyl_allocation_id,
              ip: allocation.address,
              port: allocation.port,
              assigned: true,
            },
          },
        ],
      },
    },
  } as ApplicationServer;
  const provider = vi.fn(async () => remote);
  f.adapter.getApplicationServer = provider;
  const dirs = new Set(['survival', 'Multiverse Lobby', 'scratch', 'newworld', 'old_nether']);
  const unreachable = new Set<string>();
  const files: FilemanReadService = {
    list: async () => [...dirs].map((name) => ({ name, kind: 'directory', size: 0 })),
    listMany: async (names) =>
      names.map((directory) =>
        unreachable.has(directory)
          ? { directory, error: 'unavailable' }
          : {
              directory,
              files:
                directory === 'newworld'
                  ? []
                  : [
                      {
                        name:
                          directory === 'old_nether'
                            ? 'DIM-1'
                            : directory === 'scratch'
                              ? 'data.txt'
                              : 'level.dat',
                        kind: 'file',
                        size: 42,
                        modifiedAt: '2026-01-01T00:00:00Z',
                      },
                    ],
            },
      ),
    prepare: async () => {},
    read: async ({ path }) =>
      path === 'server.properties'
        ? Buffer.from('level-name=survival\n')
        : Buffer.from('0a00000a00044461746103000b4461746156657273696f6e000000a90000', 'hex'),
    readMany: async () => new Map(),
  };
  const runtime = {
    adapter: f.adapter,
    consoleProviderBinding: 'isolated',
    fileReadPhase: () => files,
    worldPreparation: undefined,
  };
  const refresh = () => refreshMinecraftWorldIndex(db, serverId, runtime, {});
  const cached = () => readMinecraftWorldIndex(db, serverId, 'isolated');
  const dirty = () => sql`SELECT dirty_minecraft_world_index(${serverId})`.execute(db);
  return {
    db,
    userId: server.owner_id,
    serverId,
    remote,
    provider,
    dirs,
    files,
    runtime,
    refresh,
    cached,
    dirty,
    unreachable,
  };
}
describe('persistent Minecraft world inventory', () => {
  it('shows a newly discovered partial world with recognizable save data', async () => {
    const f = await fixture();
    f.dirs.add('Adventure');
    const list = f.files.listMany;
    f.files.listMany = async (...args) =>
      (await list(...args)).map((entry) =>
        entry.directory === 'Adventure'
          ? {
              directory: entry.directory,
              files: [{ name: 'level.dat_old', kind: 'file', size: 48 }],
            }
          : entry,
      );
    const { snapshot, nonWorldDirectories } = await f.refresh();
    expect(snapshot.worlds).toContainEqual({ name: 'Adventure', status: 'unavailable' });
    expect(snapshot.worlds.map((world) => world.name)).not.toContain('newworld');
    expect(nonWorldDirectories).not.toContain('Adventure');
  });
  it('serves warm data locally, preserves partial observations, forgets confirmed external deletions and refuses contradicted identities', async () => {
    const f = await fixture();
    expect(await f.cached()).toBeUndefined();
    const fresh = await f.refresh();
    expect(fresh.snapshot.worlds.map((w) => w.name)).toEqual(['survival', 'Multiverse Lobby']);
    expect(fresh.nonWorldDirectories).toEqual(['scratch']);
    expect(await f.cached()).toMatchObject({
      snapshot: fresh.snapshot,
      nonWorldDirectories: ['scratch'],
    });
    expect(await readMinecraftWorldFilemanIndex(f.db, f.serverId, 'isolated')).toEqual({
      worlds: ['survival', 'Multiverse Lobby'],
      selectedWorld: 'survival',
      nonWorldDirectories: ['scratch'],
    });
    expect(await readMinecraftWorldFilemanIndex(f.db, f.serverId, 'another-provider')).toEqual({
      worlds: [],
      selectedWorld: null,
      nonWorldDirectories: [],
    });
    expect(f.provider).toHaveBeenCalledTimes(1);
    expect(await readMinecraftWorldIndex(f.db, f.serverId, 'another-provider')).toBeUndefined();
    const lobbyObservation = fresh.snapshot.worlds.find(
      (world) => world.name === 'Multiverse Lobby',
    )?.observedAt;
    expect(lobbyObservation).toEqual(expect.any(String));
    f.dirs.delete('survival');
    f.unreachable.add('Multiverse Lobby');
    await f.dirty();
    expect((await f.cached())?.nonWorldDirectories).toEqual([]);
    const observed = await f.refresh();
    expect(observed.snapshot.worlds).toEqual([
      expect.objectContaining({
        name: 'Multiverse Lobby',
        observedAt: lobbyObservation,
        status: 'unavailable',
        validation: expect.objectContaining({ dataVersion: 169 }),
      }),
    ]);
    f.provider.mockRejectedValueOnce(new Error('node unavailable'));
    await expect(f.refresh()).rejects.toThrow('node unavailable');
    expect((await f.cached())?.snapshot.worlds).toEqual(observed.snapshot.worlds);
    f.provider.mockResolvedValueOnce({ ...f.remote, uuid: randomUUID() });
    await expect(f.refresh()).rejects.toMatchObject({ code: 'provenance_mismatch' });
    expect(await f.cached()).toBeUndefined();
  });
  it('walks oversized roots in bounded passes, keeping known worlds and skipping inconclusive negatives', async () => {
    const f = await fixture();
    await f.refresh();
    const names = Array.from({ length: 224 }, (_, i) => `arena${String(i).padStart(3, '0')}`);
    for (const name of names) f.dirs.add(name);
    f.unreachable.add('Multiverse Lobby');
    f.unreachable.add('arena000');
    f.dirs.add('00-notes');
    const original = f.files.listMany;
    f.files.listMany = async (paths) =>
      (await original(paths)).map((entry) =>
        entry.directory === '00-notes'
          ? { directory: entry.directory, files: [{ name: 'notes.txt', kind: 'file', size: 1 }] }
          : entry,
      );
    const batches = vi.spyOn(f.files, 'listMany');
    const first = await f.refresh();
    expect(batches.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['survival', 'Multiverse Lobby']),
    );
    expect(first.snapshot.worlds).toContainEqual(
      expect.objectContaining({
        name: 'Multiverse Lobby',
        status: 'unavailable',
        validation: expect.objectContaining({ dataVersion: 169 }),
      }),
    );
    expect(first.nonWorldDirectories).not.toContain('arena000');
    expect(first.snapshot.worlds.some((world) => world.name === 'arena223')).toBe(false);
    expect(first.nonWorldDirectories).toContain('00-notes');
    const scanned = new Set(batches.mock.calls[0]?.[0]);
    const previous = new Map(first.snapshot.worlds.map((world) => [world.name, world]));
    for (let pass = 0; pass < 3; pass++) {
      const result = await f.refresh();
      const batch = batches.mock.calls.at(-1)?.[0] ?? [];
      expect(batch).toHaveLength(100);
      if (pass === 0) {
        expect(batch).not.toContain('00-notes');
        expect(result.nonWorldDirectories).toContain('00-notes');
        await sql`UPDATE minecraft_world_indexes SET snapshot=jsonb_set(snapshot,'{negativeUntil,00-notes}','0')
          WHERE server_id=${f.serverId}`.execute(f.db);
        expect((await f.cached())?.nonWorldDirectories).not.toContain('00-notes');
        expect(
          (await readMinecraftWorldFilemanIndex(f.db, f.serverId, 'isolated')).nonWorldDirectories,
        ).not.toContain('00-notes');
      }
      for (const name of batch) scanned.add(name);
      for (const [name, world] of previous) {
        if (!batch.includes(name)) expect(result.snapshot.worlds).toContainEqual(world);
      }
      for (const world of result.snapshot.worlds) previous.set(world.name, world);
    }
    expect(scanned).toEqual(f.dirs);
    const cached = await f.cached();
    expect(cached?.snapshot.worlds.map((world) => world.name)).toContain('arena223');
    expect(cached?.snapshot).not.toHaveProperty('scanAfter');
  });
  it('retires denied paths from a successful batch without stalling the cursor or weakening request-level denials', async () => {
    const f = await fixture();
    const cache = new Map<string, string>();
    const worldPreparation = createMinecraftWorldPreparation(
      {
        get: async (key) => cache.get(key),
        take: async (key) => {
          const value = cache.get(key);
          cache.delete(key);
          return value;
        },
        put: async (key, value) => {
          cache.set(key, value);
        },
        delete: async (key) => {
          cache.delete(key);
        },
      },
      'isolated',
    );
    const root = f.files.list;
    f.files.list = async (directory) => [
      ...(await root(directory)),
      { name: 'server.properties', kind: 'file', size: 20 },
    ];
    const runtime = { ...f.runtime, worldPreparation };
    const refresh = () => refreshMinecraftWorldIndex(f.db, f.serverId, runtime, {});
    const first = await refresh();
    expect(first.snapshot.worlds.find((w) => w.name === 'survival')?.validation).toBeDefined();
    expect(first.nonWorldDirectories).toContain('scratch');
    expect([...cache.values()].some((value) => value.includes('"name":"survival"'))).toBe(true);

    for (let i = 0; i < 150; i++) f.dirs.add(`zz${String(i).padStart(3, '0')}`);
    f.dirs.add('00-private');
    const denied = new Set(['00-private', 'survival', 'scratch']);
    const list = f.files.listMany;
    f.files.listMany = async (paths) =>
      (await list(paths)).map((entry) =>
        denied.has(entry.directory) ? { directory: entry.directory, error: 'forbidden' } : entry,
      );
    const partial = await refresh();
    expect(partial.snapshot.worlds.find((w) => w.name === 'survival')).toEqual({
      name: 'survival',
      status: 'unavailable',
    });
    expect(partial.snapshot.worlds.map((w) => w.name)).not.toContain('00-private');
    expect(partial.nonWorldDirectories).not.toContain('scratch');
    expect([...cache.values()].some((value) => value.includes('"name":"survival"'))).toBe(false);
    expect(partial.snapshot.worlds.map((w) => w.name)).not.toContain('zz149');
    const next = await refresh();
    expect(next.snapshot.worlds.map((w) => w.name)).toContain('zz149');
    expect((await f.cached())?.snapshot.worlds.find((w) => w.name === 'survival')).toEqual({
      name: 'survival',
      status: 'unavailable',
    });

    f.files.listMany = async () => {
      throw new PterodactylError('permission_denied', 'client', 'rejected', 403);
    };
    await expect(refresh()).rejects.toMatchObject({ code: 'forbidden' });
    expect(await f.cached()).toBeUndefined();
  });
  it('fences a partial scan at a concurrent SFTP rename and resumes without resurrecting the old name', async () => {
    const f = await fixture();
    for (let i = 0; i < 142; i++) f.dirs.add(`arena${i}`);
    await f.refresh();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const list = f.files.listMany;
    f.files.listMany = vi
      .fn()
      .mockImplementationOnce(async (paths: readonly string[]) => {
        const old = await list(paths);
        started.resolve();
        await release.promise;
        return old;
      })
      .mockImplementation(list);
    const scan = f.refresh();
    await started.promise;
    try {
      f.dirs.delete('survival');
      f.dirs.add('Old Survival');
      await f.db
        .insertInto('audit_events')
        .values({
          id: randomUUID(),
          correlation_id: randomUUID(),
          actor_user_id: f.userId,
          subject_user_id: f.userId,
          action: 'server.sftp.file.rename',
          metadata: {
            serverId: f.serverId,
            outcome: 'succeeded',
            worldIndexChanged: true,
            worldMoves: [{ name: 'survival', target: 'Old Survival' }],
          },
        })
        .execute();
      const projected = await f.cached();
      expect(projected?.current).toBe(false);
      expect(projected?.snapshot.worlds.map((world) => world.name)).toContain('Old Survival');
    } finally {
      release.resolve();
    }
    const fresh = await scan;
    expect(fresh.current).toBe(true);
    const names = fresh.snapshot.worlds.map((world) => world.name);
    expect(names).toContain('Old Survival');
    expect(names).not.toContain('survival');
    expect(f.files.listMany).toHaveBeenCalledTimes(2);
  });
  it('fences an obsolete in-flight scan and coalesces a concurrent open with the worker', async () => {
    const f = await fixture();
    await f.dirty();
    expect(await dueMinecraftWorldIndexes(f.db, 4)).toEqual([f.serverId]);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const root = f.files.list;
    f.files.list = vi
      .fn()
      .mockImplementationOnce(async () => {
        const old = await root('');
        started.resolve();
        await release.promise;
        return old;
      })
      .mockImplementation(root);
    const job = reconcileDueMinecraftWorldIndex(
      f.db,
      f.serverId,
      f.runtime,
      {},
      new AbortController().signal,
    );
    await started.promise;
    const browser = f.refresh();
    f.dirs.delete('survival');
    await f.dirty();
    release.resolve();
    await job;
    const visible = await browser;
    expect(visible.snapshot.worlds.map((w) => w.name)).toEqual(['Multiverse Lobby']);
    expect(await f.cached()).toEqual(visible);
    expect(f.provider).toHaveBeenCalledTimes(2);
    await f.db
      .updateTable('managed_servers')
      .set({ pterodactyl_uuid: randomUUID() })
      .where('id', '=', f.serverId)
      .execute();
    expect(await f.cached()).toBeUndefined();
  });
  it('reuses unchanged metadata only on clean background scans and periodically rereads the actual bytes', async () => {
    const f = await fixture();
    const read = vi.spyOn(f.files, 'read');
    const levels = () =>
      read.mock.calls.filter(([request]) => request.path.endsWith('/level.dat')).length;
    const due = async () => {
      await sql`UPDATE minecraft_world_indexes SET next_scan_at=now() WHERE server_id=${f.serverId}`.execute(
        f.db,
      );
      await reconcileDueMinecraftWorldIndex(
        f.db,
        f.serverId,
        f.runtime,
        {},
        new AbortController().signal,
      );
    };
    await f.refresh();
    expect(levels()).toBe(2);
    await due();
    expect(levels()).toBe(2);
    await f.dirty();
    await due();
    expect(levels()).toBe(4);
    await sql`UPDATE minecraft_world_indexes SET level_stamps=(
      SELECT jsonb_agg(stamp || jsonb_build_object('validatedAt',0)) FROM jsonb_array_elements(level_stamps) stamp
    ) WHERE server_id=${f.serverId}`.execute(f.db);
    await due();
    expect(levels()).toBe(6);
    await f.refresh();
    expect(levels()).toBe(8);
  });
  it('lets one reader cancel without failing a concurrent refresh or doing the work twice', async () => {
    const f = await fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.provider.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return f.remote;
    });
    const controller = new AbortController();
    const left = refreshMinecraftWorldIndex(f.db, f.serverId, f.runtime, {}, controller.signal);
    await started.promise;
    const right = f.refresh();
    controller.abort();
    await expect(left).rejects.toThrow();
    release.resolve();
    await expect(right).resolves.toMatchObject({ snapshot: { selectedWorld: 'survival' } });
    expect(f.provider).toHaveBeenCalledTimes(1);
  });

  it('keeps a known world through level.dat rotation or a temporarily empty directory', async () => {
    const f = await fixture();
    await f.refresh();
    const original = f.files.listMany;
    let rotated = 'level.dat_old';
    f.files.listMany = async (paths) =>
      (await original(paths)).map((result) =>
        result.directory === 'survival' || result.directory === 'scratch'
          ? {
              directory: result.directory,
              files: rotated
                ? [{ name: rotated, kind: rotated === 'region' ? 'directory' : 'file', size: 10 }]
                : [],
            }
          : result,
      );
    for (const marker of ['level.dat_old', 'region', '']) {
      rotated = marker;
      const current = await f.refresh();
      expect(current.snapshot.worlds.find((w) => w.name === 'survival')).toMatchObject({
        status: 'unavailable',
        validation: { dataVersion: 169 },
      });
      expect(current.snapshot.worlds.find((w) => w.name === 'scratch')).toEqual({
        name: 'scratch',
        status: 'unavailable',
      });
      expect(current.nonWorldDirectories).not.toContain('survival');
    }
    rotated = 'ordinary.txt';
    const current = await f.refresh();
    expect(current.snapshot.worlds.some((w) => w.name === 'survival')).toBe(false);
    expect(current.nonWorldDirectories).toContain('survival');
  });
  it('retains the bound list during an operation and fences a worker spanning even a failed operation', async () => {
    const f = await fixture();
    const job = await f.db
      .selectFrom('server_operations')
      .select('job_id')
      .where('server_id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    const active = (value: string | null) =>
      f.db
        .updateTable('managed_servers')
        .set({ active_operation_id: value })
        .where('id', '=', f.serverId)
        .execute();
    await active(job.job_id);
    await expect(f.refresh()).rejects.toMatchObject({ code: 'operation_busy' });
    await active(null);
    const before = await f.refresh();
    await f.dirty();
    const started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    f.files.list = async () => {
      started.resolve();
      await release.promise;
      return [];
    };
    const scan = reconcileDueMinecraftWorldIndex(
      f.db,
      f.serverId,
      f.runtime,
      {},
      new AbortController().signal,
    );
    await started.promise;
    await active(job.job_id);
    expect((await f.refresh()).snapshot).toEqual(before.snapshot);
    await active(null);
    release.resolve();
    await scan;
    expect((await f.cached())?.snapshot).toEqual(before.snapshot);
    expect(await dueMinecraftWorldIndexes(f.db, 2)).toContain(f.serverId);
  });
  it('revokes published data on upstream client denial, retaining it on a transient outage', async () => {
    const f = await fixture();
    await f.refresh();
    f.files.list = async () => {
      throw new PterodactylError('unavailable', 'client', 'unknown', 503);
    };
    await expect(f.refresh()).rejects.toThrow();
    expect(await f.cached()).toBeDefined();
    const started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    f.files.list = async () => {
      started.resolve();
      await release.promise;
      throw new PterodactylError('permission_denied', 'client', 'rejected', 403);
    };
    await f.dirty();
    const worker = expect(
      reconcileDueMinecraftWorldIndex(
        f.db,
        f.serverId,
        f.runtime,
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await started.promise;
    const browser = expect(f.refresh()).rejects.toMatchObject({ code: 'forbidden' });
    // Let the request observe and join the worker's lease rather than initiating another scan.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release.resolve();
    await Promise.all([worker, browser]);
    expect(f.provider).toHaveBeenCalledTimes(3);
    expect(await f.cached()).toBeUndefined();
  });
  it('gives servers different minute phases and avoids provider access for uninstalled profiles', async () => {
    const f = await fixture();
    const { rows } = await sql<{
      phases: number;
    }>`SELECT count(distinct minecraft_world_next_scan(gen_random_uuid(),'2026-01-01 00:00Z'))::int as phases FROM generate_series(1,100)`.execute(
      f.db,
    );
    expect(rows[0]?.phases).toBeGreaterThan(80);
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: false })
      .where('server_id', '=', f.serverId)
      .execute();
    expect((await f.refresh()).snapshot).toMatchObject({ installed: false, worlds: [] });
    expect(f.provider).not.toHaveBeenCalled();
    await f.dirty();
    expect(await dueMinecraftWorldIndexes(f.db, 4)).toEqual([]);
  });
});
