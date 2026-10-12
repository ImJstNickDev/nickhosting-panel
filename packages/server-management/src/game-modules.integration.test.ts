import { randomBytes, randomUUID } from 'node:crypto';
import { DomainError, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { PterodactylAdapter, ServerFile } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGameModuleRegistry,
  createGameRuntimeDispatcher,
  type GameRuntimeHooks,
  type TrustedGameModule,
  trustedGameModules,
} from './game-modules.js';
import { createMinecraftModuleRuntime } from './minecraft-module.js';
import { createManagementRuntime } from './runtime.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
beforeAll(async () => {
  database = await createTestDatabase();
});

beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
});
afterAll(async () => {
  await database?.destroy();
});
function fixtureModule(): TrustedGameModule {
  return {
    id: f.gameId,
    manifest: f.manifest,
    provisionAsResourceOwner: true,
    assertProfileBinding: vi.fn(async () => {}),
    authorizeOperation: vi.fn(async () => {}),
    filterCatalog: vi.fn(async (_db, _context, entry) => ({
      ...entry,
      manifest: { ...f.manifest, runtimes: [] },
    })),
  };
}
function fixtureHooks(): GameRuntimeHooks {
  return {
    configureProvision: vi.fn(async () => true),
    processContent: vi.fn(async () => true),
    verifyRestore: vi.fn(async () => true),
    assertRuntimeImage: vi.fn(async () => ({ fixture: true })),
    assertFileMutation: vi.fn(async () => {}),
    verifyProcessEpoch: vi.fn(async (_id, _db, before, readAgain) => {
      if (before !== (await readAgain())) throw new DomainError('operation_uncertain');
      return before;
    }),
  };
}
describe('compiled first-party game module dispatch', () => {
  it('validates identity, rejects duplicate modules and pins compiled definitions independently of later caller edits', async () => {
    const module = fixtureModule();
    expect(() => createGameModuleRegistry([module, module])).toThrow('configuration_invalid');
    expect(() => createGameModuleRegistry([{ ...module, id: 'wrong-id' }])).toThrow(
      'configuration_invalid',
    );
    const registry = createGameModuleRegistry([module]);
    module.provisionAsResourceOwner = false;
    module.manifest.nameKey = 'games.changed.name';
    expect(registry.get(f.gameId)?.provisionAsResourceOwner).toBe(true);
    expect(registry.get(f.gameId)?.manifest.nameKey).not.toBe('games.changed.name');
    expect(Object.isFrozen(registry.get(f.gameId))).toBe(true);
  });
  it('dispatches fixtures by immutable managed mapping; unrelated assets and metadata do not cause a hook/provider effect', async () => {
    const id = await f.server(),
      other = await managementFixture(f.db, { interactive: true }),
      otherId = await other.server();
    vi.mocked(f.adapter.getNode).mockClear();
    const module = fixtureModule(),
      registry = createGameModuleRegistry([module]),
      hooks = fixtureHooks(),
      dispatch = createGameRuntimeDispatcher(registry, new Map([[module.id, hooks]]));
    expect(await dispatch(f.db, id)).toBe(hooks);
    expect(await dispatch(f.db, otherId)).toBeUndefined();
    await expect(dispatch(f.db, randomUUID())).rejects.toThrow('not_found');
    expect(hooks.processContent).not.toHaveBeenCalled();
    expect(hooks.assertFileMutation).not.toHaveBeenCalled();
    expect(f.adapter.getNode).not.toHaveBeenCalled();
    expect(
      (
        await f.db
          .selectFrom('managed_servers')
          .select('name')
          .where('id', '=', otherId)
          .executeTakeFirstOrThrow()
      ).name,
    ).toBe('isolated-server');
    await f.db
      .updateTable('managed_servers')
      .set({ deleted_at: new Date() })
      .where('id', '=', id)
      .execute();
    await expect(dispatch(f.db, id)).rejects.toThrow('not_found');
  });
  it('does not turn stored capabilities into executable content handlers, and fails closed for a registered missing implementation', async () => {
    const id = await f.server(),
      module = fixtureModule(),
      registry = createGameModuleRegistry([module]);
    const dispatch = createGameRuntimeDispatcher(registry, new Map());
    await expect(dispatch(f.db, id)).rejects.toThrow('integration_unavailable');
    expect(() =>
      createGameRuntimeDispatcher(
        createGameModuleRegistry([]),
        new Map([[module.id, fixtureHooks()]]),
      ),
    ).toThrow('configuration_invalid');
    const runtime = await createManagementRuntime({
      db: f.db,
      adapter: f.adapter,
      codec: new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } }),
    });
    const server = await f.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const operation = await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('server_id', '=', id)
      .executeTakeFirstOrThrow();
    await expect(
      runtime.lifecycle.processGameContent({
        db: f.db,
        server,
        adapter: f.adapter,
        operation: () => operation,
        authorize: async () => {},
        assertStopped: async () => {},
        update: async () => {},
        effect: async () => true,
        event: async () => {},
        backup: async () => true,
      }),
    ).rejects.toThrow('integration_unavailable');
  });
  it('rejects a retained Minecraft profile under another mapping before any runtime hook can bypass its guards', async () => {
    const id = await f.server(),
      choiceId = randomUUID();
    await f.db
      .insertInto('minecraft_combinations')
      .values({
        id: choiceId,
        mapping_id: f.mappingId,
        identity_digest: '1'.repeat(64),
        combination: '{}',
        resolved_runtime: '{}',
        binding: '{}',
        mapping_digest: '2'.repeat(64),
      })
      .execute();
    await f.db
      .insertInto('minecraft_server_profiles')
      .values({ server_id: id, combination_id: choiceId, configuration: '{}' })
      .execute();
    await expect(trustedGameModules.resolve(f.db, id)).rejects.toThrow('configuration_invalid');
    const runtime = await createManagementRuntime({
      db: f.db,
      adapter: f.adapter,
      codec: new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } }),
    });
    await expect(runtime.assertFileMutation(id, ['world/data'])).rejects.toThrow(
      'configuration_invalid',
    );
  });
  it('filters catalog via the same registered policy and leaves unrelated catalog metadata unchanged', async () => {
    const module = fixtureModule(),
      registry = createGameModuleRegistry([module]);
    const entry = {
      id: f.gameId,
      version: '1.0.0',
      manifest: f.manifest,
      access: { visible: true, canCreate: true, canManageExisting: true },
    };
    const unrelated = { ...entry, id: 'other-fixture' };
    const result = await registry.catalog(f.db, f.context, [entry, unrelated]);
    expect(result[0]?.manifest).toMatchObject({ runtimes: [] });
    expect(result[1]).toBe(unrelated);
    expect(module.filterCatalog).toHaveBeenCalledOnce();
  });
});

describe('Minecraft file mutation preflight', () => {
  const names = Array.from({ length: 49 }, (_, index) => `file-${index}.dat`);
  function entry(name: string, patch: Partial<ServerFile> = {}): ServerFile {
    return {
      name,
      mode: '-rw-r--r--',
      size: 1,
      is_file: true,
      is_symlink: false,
      mimetype: 'application/octet-stream',
      created_at: '2026-01-01T00:00:00Z',
      modified_at: '2026-01-01T00:00:00Z',
      ...patch,
    };
  }
  function tree(root = '') {
    const listings = new Map<string, ServerFile[]>();
    let directory = '';
    for (const component of root ? root.split('/') : []) {
      listings.set(directory, [entry(component, { is_file: false })]);
      directory = [directory, component].filter(Boolean).join('/');
    }
    listings.set(
      root,
      names.map((name) => entry(name)),
    );
    return { listings, paths: names.map((name) => [root, name].filter(Boolean).join('/')) };
  }
  async function guardFixture(listings: Map<string, ServerFile[]>) {
    const serverId = await f.server();
    const choiceId = randomUUID();
    await f.db
      .insertInto('minecraft_combinations')
      .values({
        id: choiceId,
        mapping_id: f.mappingId,
        identity_digest: '1'.repeat(64),
        combination: '{}',
        resolved_runtime: '{}',
        binding: JSON.stringify({
          profile: 'fabric',
          release: '1.21.1',
          image: 'fixture/image:1',
          imageJavaMajor: 21,
          declaredEggVariables: [],
          bindings: {},
          fixedVariables: {},
          installationKind: 'fabric-installer',
          artifactPaths: { server: 'server.jar' },
          supportedProperties: [],
        }),
        mapping_digest: '2'.repeat(64),
      })
      .execute();
    await f.db
      .insertInto('minecraft_server_profiles')
      .values({
        server_id: serverId,
        combination_id: choiceId,
        configuration: '{}',
        installed_manifest: JSON.stringify([
          { path: 'server.jar' },
          { path: 'libraries/loader.jar' },
        ]),
      })
      .execute();
    const server = await f.db
      .selectFrom('managed_servers')
      .select('pterodactyl_identifier')
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    if (!server.pterodactyl_identifier) throw new Error('Missing isolated provider identifier');
    const listFiles = vi
      .fn<PterodactylAdapter['listFiles']>()
      .mockImplementation(async (_id, directory = '') => listings.get(directory) ?? []);
    Object.assign(f.adapter, { listFiles });
    const runtime = createMinecraftModuleRuntime({
      db: f.db,
      codec: new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } }),
      env: {},
      adapter: f.adapter,
      observedImageDigest: async () => null,
      authorizeJob: async () => f.context,
    });
    return { runtime, serverId, identifier: server.pterodactyl_identifier, listFiles };
  }
  it.each(['', 'mods', 'world/data'])(
    'reads each directory once for 49 existing files under %j',
    async (root) => {
      const { listings, paths } = tree(root);
      const { runtime, serverId, listFiles } = await guardFixture(listings);
      await runtime.assertFileMutation(serverId, paths, f.db);
      expect(listFiles.mock.calls.map(([, directory]) => directory)).toEqual([...listings.keys()]);
      expect(listFiles).toHaveBeenCalledTimes(root ? root.split('/').length + 1 : 1);
    },
  );
  it('uses the supplied provider-bound observations and still shares repeated directories', async () => {
    const { listings, paths } = tree('mods');
    const { runtime, serverId, identifier, listFiles } = await guardFixture(listings);
    const readDirectory = vi.fn(async (directory: string) => listings.get(directory) ?? []);
    await runtime.assertFileMutation(serverId, paths, f.db, {
      providerIdentifier: identifier,
      listFiles: readDirectory,
    });
    expect(readDirectory.mock.calls.map(([directory]) => directory)).toEqual(['', 'mods']);
    expect(listFiles).not.toHaveBeenCalled();
    await expect(
      runtime.assertFileMutation(serverId, paths, f.db, {
        providerIdentifier: 'unrelated',
        listFiles: readDirectory,
      }),
    ).rejects.toThrow('conflict');
    expect(readDirectory).toHaveBeenCalledTimes(2);
  });
  it.each(['symlink', 'case-alias', 'case-collision'])(
    'still checks the 49th selected entry for %s',
    async (unsafe) => {
      const { listings, paths } = tree('mods');
      const last = names.at(-1);
      if (!last) throw new Error('Missing final fixture entry');
      const entries = names.slice(0, -1).map((name) => entry(name));
      if (unsafe === 'symlink') entries.push(entry(last, { is_symlink: true }));
      else {
        entries.push(entry(last.toUpperCase()));
        if (unsafe === 'case-collision') entries.push(entry(last));
      }
      listings.set('mods', entries);
      const { runtime, serverId, listFiles } = await guardFixture(listings);
      await expect(runtime.assertFileMutation(serverId, paths, f.db)).rejects.toThrow('conflict');
      expect(listFiles).toHaveBeenCalledTimes(2);
    },
  );
  it.each(['symlink', 'case-alias'])(
    'checks a late unsafe sibling ancestor for %s against the shared root listing',
    async (unsafe) => {
      const { listings, paths } = tree('safe');
      listings.set('', [
        entry('safe', { is_file: false }),
        entry(unsafe === 'case-alias' ? 'UNSAFE' : 'unsafe', {
          is_file: false,
          is_symlink: unsafe === 'symlink',
        }),
      ]);
      const { runtime, serverId, listFiles } = await guardFixture(listings);
      await expect(
        runtime.assertFileMutation(serverId, [...paths.slice(0, -1), 'unsafe/file.dat'], f.db),
      ).rejects.toThrow('conflict');
      expect(listFiles.mock.calls.map(([, directory]) => directory)).toEqual(['', 'safe']);
    },
  );
  it.each(['server.jar', 'libraries', 'fabric-server-launcher.properties'])(
    'refuses a late protected path %s before directory observations',
    async (protectedPath) => {
      const { listings, paths } = tree();
      const { runtime, serverId, listFiles } = await guardFixture(listings);
      await expect(
        runtime.assertFileMutation(serverId, [...paths.slice(0, -1), protectedPath], f.db),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(listFiles).not.toHaveBeenCalled();
    },
  );
  it('reads fresh listings on a second invocation and detects a newly unsafe entry', async () => {
    const { listings, paths } = tree();
    const { runtime, serverId, listFiles } = await guardFixture(listings);
    await runtime.assertFileMutation(serverId, paths, f.db);
    listings.set(
      '',
      names.map((name, index) => entry(name, { is_symlink: index === 48 })),
    );
    await expect(runtime.assertFileMutation(serverId, paths, f.db)).rejects.toThrow('conflict');
    expect(listFiles).toHaveBeenCalledTimes(2);
  });
  it('propagates a failed listing and reads again on a later invocation', async () => {
    const { listings, paths } = tree();
    const { runtime, serverId, listFiles } = await guardFixture(listings);
    const failure = new DomainError('integration_unavailable');
    listFiles.mockRejectedValueOnce(failure);
    await expect(runtime.assertFileMutation(serverId, paths, f.db)).rejects.toBe(failure);
    await runtime.assertFileMutation(serverId, paths, f.db);
    expect(listFiles).toHaveBeenCalledTimes(2);
  });
});
