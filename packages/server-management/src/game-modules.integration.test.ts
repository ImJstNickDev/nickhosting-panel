import { randomBytes, randomUUID } from 'node:crypto';
import { DomainError, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGameModuleRegistry,
  createGameRuntimeDispatcher,
  type GameRuntimeHooks,
  type TrustedGameModule,
  trustedGameModules,
} from './game-modules.js';
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
    assertLaunchFiles: vi.fn(async () => {}),
    assertFileMutation: vi.fn(async () => {}),
    invalidateLaunchEpoch: vi.fn(),
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
