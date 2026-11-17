import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { satisfactoryManifest } from '../../../games/satisfactory/src/manifest.js';
import {
  ensureSatisfactoryModState,
  inspectSatisfactoryModInventory,
  readSatisfactoryGameBuild,
  reconcileSatisfactoryMods,
} from './satisfactory-mod-manager.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let id: string;
let files: Map<string, Buffer>;
let adapter: PterodactylAdapter;
const nativeLock = {
  version: 1,
  mods: {
    Example: {
      version: '1.0.0',
      dependencies: {},
      targets: {
        LinuxServer: { hash: 'a'.repeat(64), link: 'https://github.com/example/release.zip' },
      },
    },
  },
};
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  id = await f.server();
  await f.db
    .insertInto('game_integrations')
    .values({
      id: 'satisfactory',
      version: satisfactoryManifest.version,
      manifest: satisfactoryManifest,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'satisfactory', runtime_id: 'dedicated' })
    .where('id', '=', f.mappingId)
    .execute();
  files = new Map(
    Object.entries({
      'FactoryServer.sh': 'launcher',
      'Engine/Binaries/Linux/UnrealServer-Linux-Shipping.version': JSON.stringify({
        Changelist: 123456,
      }),
      'FactoryGame/Mods/Example/Example.uplugin': JSON.stringify({
        FriendlyName: 'Example',
        VersionName: '1.0.0',
      }),
      'FactoryGame/Mods/Example/.smm': '',
      'FactoryGame/Mods/Example/binary.so': 'binary',
      'FactoryGame/Mods/test-lock.json': JSON.stringify(nativeLock),
      'FactoryGame/Mods/Manual/custom.txt': 'unmanaged',
    }).map(([p, s]) => [p, Buffer.from(s)]),
  );
  adapter = {
    listFiles: vi.fn(async (_id: string, directory: string) => {
      const prefix = directory ? `${directory}/` : '';
      const names = new Map<
        string,
        { name: string; is_file: boolean; is_symlink: boolean; size: number }
      >();
      for (const [path, data] of files) {
        if (!path.startsWith(prefix)) continue;
        const relative = path.slice(prefix.length),
          name = relative.split('/')[0]!;
        names.set(name, {
          name,
          is_file: !relative.includes('/'),
          is_symlink: false,
          size: relative.includes('/') ? 0 : data.length,
        });
      }
      return [...names.values()];
    }),
    readFile: vi.fn(async (_id: string, path: string) => files.get(path)!),
    downloadFile: vi.fn(async (_id: string, path: string) => ({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(files.get(path));
          controller.close();
        },
      }),
    })),
  } as unknown as PterodactylAdapter;
  await ensureSatisfactoryModState(f.db, id);
});
const server = () =>
  f.db.selectFrom('managed_servers').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
it('finds real mod metadata, native locks, manual files and byte-level divergence', async () => {
  const result = await inspectSatisfactoryModInventory(f.db, adapter, await server());
  expect(result.gameVersion).toBe(123456);
  expect(result.items.find((i) => i.reference === 'Example')).toMatchObject({
    managed: true,
    version: '1.0.0',
  });
  expect(result.diverged).toBe(true);
  await f.db
    .updateTable('satisfactory_mod_states')
    .set({ inventory_fingerprint: result.fingerprint })
    .where('server_id', '=', id)
    .execute();
  expect((await inspectSatisfactoryModInventory(f.db, adapter, await server())).diverged).toBe(
    false,
  );
  files.set('FactoryGame/Mods/Example/binary.so', Buffer.from('changed'));
  expect((await inspectSatisfactoryModInventory(f.db, adapter, await server())).diverged).toBe(
    true,
  );
});
it('reuses listings only within an explicit preview and still hashes every file', async () => {
  const current = await server();
  const fresh = await inspectSatisfactoryModInventory(f.db, adapter, current);
  expect(
    vi.mocked(adapter.listFiles).mock.calls.filter(([, path]) => path === 'FactoryGame/Mods'),
  ).toHaveLength(2);
  vi.mocked(adapter.listFiles).mockClear();
  vi.mocked(adapter.downloadFile).mockClear();
  const preview = await inspectSatisfactoryModInventory(f.db, adapter, current, undefined, {
    reuseListings: true,
  });
  expect(preview).toEqual(fresh);
  const listed = vi.mocked(adapter.listFiles).mock.calls.map(([, path]) => path);
  expect(new Set(listed).size).toBe(listed.length);
  expect(adapter.downloadFile).toHaveBeenCalledTimes(fresh.files.length - 2);
  files.set('FactoryGame/Mods/Example/binary.so', Buffer.from('mutate'));
  const changed = await inspectSatisfactoryModInventory(f.db, adapter, current, undefined, {
    reuseListings: true,
  });
  expect(changed.fingerprint).not.toBe(preview.fingerprint);
});
it('checks preview authorization again even when reusing a directory listing', async () => {
  const current = await server();
  const list = vi.mocked(adapter.listFiles).getMockImplementation()!;
  let revoked = false;
  vi.mocked(adapter.listFiles).mockImplementation(async (identifier, path) => {
    const entries = await list(identifier, path);
    if (path === 'FactoryGame/Mods/Manual') revoked = true;
    return entries;
  });
  await expect(
    inspectSatisfactoryModInventory(
      f.db,
      adapter,
      current,
      async () => {
        if (revoked) throw new Error('revoked');
      },
      { reuseListings: true },
    ),
  ).rejects.toThrow('revoked');
  expect(adapter.downloadFile).not.toHaveBeenCalled();
});
it('stops a preview after an aborted metadata read before downloading files', async () => {
  const controller = new AbortController();
  vi.mocked(adapter.readFile).mockImplementation(async (_identifier, path) => {
    controller.abort(new Error('cancelled preview'));
    return files.get(path)!;
  });
  await expect(
    inspectSatisfactoryModInventory(f.db, adapter, await server(), undefined, {
      signal: controller.signal,
      reuseListings: true,
    }),
  ).rejects.toThrow('cancelled preview');
  expect(adapter.downloadFile).not.toHaveBeenCalled();
});
it('lists the game build directory once when only the second supported file exists', async () => {
  const first = 'Engine/Binaries/Linux/UnrealServer-Linux-Shipping.version';
  files.set('Engine/Binaries/Linux/FactoryServer-Linux-Shipping.version', files.get(first)!);
  files.delete(first);
  expect(await readSatisfactoryGameBuild(adapter, 'fixture')).toBe(123456);
  expect(adapter.listFiles).toHaveBeenCalledTimes(1);
  expect(adapter.readFile).toHaveBeenCalledTimes(1);
});
it('adopts explicitly selected native state only during stopped external management, preserving unknown files', async () => {
  const scanned = await inspectSatisfactoryModInventory(f.db, adapter, await server());
  const input = {
    revision: 0,
    fingerprint: scanned.fingerprint,
    selection: [{ reference: 'Example', version: '>=1.0.0' }],
  };
  await expect(
    reconcileSatisfactoryMods(f.db, adapter, await server(), input, async () => {}),
  ).rejects.toThrow('conflict');
  await f.db
    .updateTable('satisfactory_mod_states')
    .set({ external_mode: true })
    .where('server_id', '=', id)
    .execute();
  expect(
    await reconcileSatisfactoryMods(f.db, adapter, await server(), input, async () => {}),
  ).toEqual({ revision: 1, fingerprint: scanned.fingerprint });
  const state = await f.db
    .selectFrom('satisfactory_mod_states')
    .selectAll()
    .where('server_id', '=', id)
    .executeTakeFirstOrThrow();
  expect((state.files as { path: string }[]).some((file) => file.path.includes('Manual'))).toBe(
    false,
  );
  expect(files.has('FactoryGame/Mods/Manual/custom.txt')).toBe(true);
  await expect(
    reconcileSatisfactoryMods(f.db, adapter, await server(), input, async () => {}),
  ).rejects.toThrow('conflict');
});
it('rejects stale hashes, invalid requested version and duplicate GameFeatures references', async () => {
  await f.db
    .updateTable('satisfactory_mod_states')
    .set({ external_mode: true })
    .where('server_id', '=', id)
    .execute();
  const scan = await inspectSatisfactoryModInventory(f.db, adapter, await server());
  const input = {
    revision: 0,
    fingerprint: scan.fingerprint,
    selection: [{ reference: 'Example', version: '2.0.0' }],
  };
  await expect(
    reconcileSatisfactoryMods(f.db, adapter, await server(), input, async () => {}),
  ).rejects.toThrow('conflict');
  await expect(
    reconcileSatisfactoryMods(
      f.db,
      adapter,
      await server(),
      { ...input, fingerprint: 'a'.repeat(64), selection: [] },
      async () => {},
    ),
  ).rejects.toThrow('conflict');
  files.set('FactoryGame/Mods/GameFeatures/Example/.smm', Buffer.alloc(0));
  files.set(
    'FactoryGame/Mods/GameFeatures/Example/Example.uplugin',
    Buffer.from(JSON.stringify({ VersionName: '1.0.0' })),
  );
  const duplicate = await inspectSatisfactoryModInventory(f.db, adapter, await server());
  await expect(
    reconcileSatisfactoryMods(
      f.db,
      adapter,
      await server(),
      { ...input, fingerprint: duplicate.fingerprint, selection: [] },
      async () => {},
    ),
  ).rejects.toThrow('conflict');
});
it('rejects symlink traversal and does not download its target', async () => {
  const original = vi.mocked(adapter.listFiles).getMockImplementation()!;
  vi.mocked(adapter.listFiles).mockImplementation(async (identifier, path) => {
    const entries = await original(identifier, path);
    return entries.map((entry) =>
      path === 'FactoryGame/Mods' && entry.name === 'Example'
        ? { ...entry, is_symlink: true }
        : entry,
    );
  });
  await expect(inspectSatisfactoryModInventory(f.db, adapter, await server())).rejects.toThrow();
  expect(adapter.downloadFile).not.toHaveBeenCalled();
});
it('preserves imported client/server profile identity and client-only roots during external adoption', async () => {
  const profileId = randomUUID(),
    selection = [
      { reference: 'Example', version: '1.0.0' },
      { reference: 'ClientOnly', version: '1.0.0' },
    ];
  await f.db
    .insertInto('satisfactory_mod_profiles')
    .values({
      id: profileId,
      server_id: id,
      name: 'Shared',
      selection: JSON.stringify(selection),
      vanilla: false,
      required_targets: JSON.stringify(['LinuxServer', 'Windows']),
    })
    .execute();
  files.set(
    'FactoryGame/Mods/test-lock.json',
    Buffer.from(
      JSON.stringify({
        ...nativeLock,
        mods: {
          ...nativeLock.mods,
          ClientOnly: {
            version: '1.0.0',
            dependencies: {},
            targets: {
              Windows: { hash: 'b'.repeat(64), link: 'https://api.ficsit.app/client.zip' },
            },
          },
        },
      }),
    ),
  );
  await f.db
    .updateTable('satisfactory_mod_states')
    .set({ external_mode: true })
    .where('server_id', '=', id)
    .execute();
  const scan = await inspectSatisfactoryModInventory(f.db, adapter, await server());
  await reconcileSatisfactoryMods(
    f.db,
    adapter,
    await server(),
    { revision: 0, fingerprint: scan.fingerprint, selection, profileId },
    async () => {},
  );
  const state = await f.db
    .selectFrom('satisfactory_mod_states')
    .selectAll()
    .where('server_id', '=', id)
    .executeTakeFirstOrThrow();
  expect(state.active_profile_id).toBe(profileId);
  expect(state.selection).toEqual(selection);
  expect(state.lock).toMatchObject({ mods: { ClientOnly: { version: '1.0.0' } } });
});

it('scans 100 mods with bounded parallel reads and reuses preview metadata bytes', async () => {
  files.clear();
  files.set(
    'Engine/Binaries/Linux/UnrealServer-Linux-Shipping.version',
    Buffer.from('{"Changelist":123456}'),
  );
  for (let index = 0; index < 100; index++) {
    const base = `FactoryGame/Mods/Mod${index}`;
    files.set(`${base}/Mod${index}.uplugin`, Buffer.from('{"VersionName":"1.0.0"}'));
    files.set(`${base}/.smm`, Buffer.from('marker'));
    files.set(`${base}/binary.so`, Buffer.from(`payload-${index}`));
  }
  let active = 0;
  let peak = 0;
  const prefetch = vi.fn(async () => {});
  adapter.prefetchDownloads = prefetch;
  vi.mocked(adapter.downloadFile).mockImplementation(async (_identifier, path) => {
    peak = Math.max(peak, ++active);
    return {
      body: new ReadableStream<Uint8Array>({
        async start(controller) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          active--;
          controller.enqueue(files.get(path)!);
          controller.close();
        },
      }),
    } as Awaited<ReturnType<PterodactylAdapter['downloadFile']>>;
  });
  const result = await inspectSatisfactoryModInventory(f.db, adapter, await server(), undefined, {
    reuseListings: true,
  });
  expect(result.files).toHaveLength(300);
  expect(result.items).toHaveLength(100);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
  expect(active).toBe(0);
  expect(adapter.downloadFile).toHaveBeenCalledTimes(200);
  expect(adapter.readFile).toHaveBeenCalledTimes(101);
  expect(prefetch).toHaveBeenCalledTimes(5);
  expect(
    prefetch.mock.calls.flatMap((call) => (call as unknown as [string, string[]])[1]),
  ).toHaveLength(200);
  const listed = vi.mocked(adapter.listFiles).mock.calls.map(([, path]) => path);
  expect(new Set(listed).size).toBe(listed.length);
});

it('captures the exact freshly hashed bytes and rejects a partial capture consumer', async () => {
  const captured = new Map<string, Buffer>();
  const result = await inspectSatisfactoryModInventory(f.db, adapter, await server(), undefined, {
    reuseListings: true,
    captureFile: async (file, chunks) => {
      const values: Uint8Array[] = [];
      for await (const chunk of chunks) values.push(chunk);
      captured.set(file.path, Buffer.concat(values));
    },
  });
  expect(captured.size).toBe(result.files.length);
  expect(adapter.downloadFile).toHaveBeenCalledTimes(result.files.length);
  for (const file of result.files) expect(captured.get(file.path)).toEqual(files.get(file.path));
  await expect(
    inspectSatisfactoryModInventory(f.db, adapter, await server(), undefined, {
      captureFile: async () => {},
    }),
  ).rejects.toThrow('conflict');
});

it('cancels and drains every active inventory stream when a capture fails', async () => {
  let active = 0;
  let cancelled = 0;
  const gate = Promise.withResolvers<void>();
  vi.mocked(adapter.downloadFile).mockImplementation(async () => {
    active++;
    return {
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          await gate.promise;
          controller.enqueue(Buffer.from('x'));
        },
        cancel() {
          active--;
          cancelled++;
        },
      }),
    } as Awaited<ReturnType<PterodactylAdapter['downloadFile']>>;
  });
  let invoked = 0;
  const pending = inspectSatisfactoryModInventory(f.db, adapter, await server(), undefined, {
    captureFile: async (_file, chunks) => {
      if (++invoked === 4) {
        gate.resolve();
        throw new Error('capture failed');
      }
      for await (const _chunk of chunks) {
        /* Wait for sibling failure. */
      }
    },
  });
  await expect(pending).rejects.toThrow();
  expect(cancelled).toBeGreaterThan(0);
  expect(active).toBe(0);
});
