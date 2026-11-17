import { createHash, randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { satisfactoryManifest } from '../../../games/satisfactory/src/manifest.js';
import { enqueueServerOperation } from './registry.js';
import {
  beginSatisfactoryExternalEdit,
  finishSatisfactoryExternalEdit,
} from './satisfactory-mod-external.js';
import { createSatisfactoryModuleRuntime } from './satisfactory-module.js';
import { managementFixture, pendingUploadFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let id: string;
beforeAll(async () => {
  database = await createTestDatabase();
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
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'satisfactory', runtime_id: 'dedicated' })
    .where('id', '=', f.mappingId)
    .execute();
});
afterAll(async () => {
  await database?.destroy();
});
const begin = (revision = 0) =>
  beginSatisfactoryExternalEdit(f.db, f.context, id, { revision, idempotencyKey: randomUUID() });

it('enters maintenance while stopped and blocks manual starts and content writers', async () => {
  expect(await begin()).toMatchObject({ externalMode: true, jobId: expect.any(String) });
  const state = await f.db
    .selectFrom('satisfactory_mod_states')
    .selectAll()
    .where('server_id', '=', id)
    .executeTakeFirstOrThrow();
  expect(state.external_mode).toBe(true);
  expect(state.revision).toBe(1);
  expect(state.inventory_fingerprint).toBeNull();
  expect(
    (
      await f.db
        .selectFrom('managed_servers')
        .select('intent')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).intent,
  ).toBe('maintenance');
  for (const action of ['start', 'restart', 'reinstall'] as const)
    await expect(
      enqueueServerOperation(f.db, f.context, id, { action, idempotencyKey: randomUUID() }),
    ).rejects.toThrow();
  await expect(
    enqueueServerOperation(
      f.db,
      f.context,
      id,
      {
        action: 'satisfactory-content',
        idempotencyKey: randomUUID(),
        command: { kind: 'mods', mode: 'preview', selection: [] },
      },
      {},
      { satisfactoryContent: true },
    ),
  ).rejects.toThrow();
  expect(await begin()).toMatchObject({ externalMode: true, jobId: expect.any(String) });
  const module = createSatisfactoryModuleRuntime(
    new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 1) } }),
  );
  for (const path of ['FactoryGame', 'FactoryGame/Mods', 'FactoryGame/Mods/Example/file.so'])
    await expect(module.assertFileMutation(id, [path], f.db)).rejects.toThrow('conflict');
  await expect(module.assertFileMutation(id, ['unrelated.txt'], f.db)).resolves.toBeUndefined();
});

it('enqueues a durable graceful stop and preserves maintenance intent while it completes', async () => {
  await f.db
    .updateTable('managed_servers')
    .set({ runtime_state: 'running', intent: 'auto_wake_enabled' })
    .where('id', '=', id)
    .execute();
  const result = await begin();
  expect(result.jobId).toEqual(expect.any(String));
  const operation = await f.db
    .selectFrom('server_operations')
    .selectAll()
    .where('job_id', '=', result.jobId!)
    .executeTakeFirstOrThrow();
  expect(operation.action).toBe('stop');
  expect(operation.plan.satisfactoryExternalEdit).toBe(true);
  expect(
    (
      await f.db
        .selectFrom('managed_servers')
        .select('intent')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).intent,
  ).toBe('maintenance');
});

it('rejects stale revisions and pending uploads before claiming external mode', async () => {
  await expect(begin(1)).rejects.toThrow();
  await pendingUploadFixture(f.db, id);
  await expect(begin()).rejects.toThrow();
  expect(
    await f.db
      .selectFrom('satisfactory_mod_states')
      .selectAll()
      .where('server_id', '=', id)
      .executeTakeFirst(),
  ).toBeUndefined();
});

it('generic operation endpoint cannot bypass reviewed mod plans', async () => {
  await expect(
    enqueueServerOperation(f.db, f.context, id, {
      action: 'satisfactory-content',
      idempotencyKey: randomUUID(),
      command: { kind: 'mods', selection: [] },
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
});

it('requires an explicitly reconciled inventory before returning from SMM and stays stopped', async () => {
  await begin();
  await f.db
    .updateTable('managed_servers')
    .set({ active_operation_id: null })
    .where('id', '=', id)
    .execute();
  const adapter = { listFiles: async () => [] } as unknown as PterodactylAdapter;
  const fingerprint = createHash('sha256').update('[]').digest('hex');
  const finish = (revision: number, inventoryFingerprint = fingerprint) =>
    finishSatisfactoryExternalEdit(f.db, adapter, f.context, id, {
      revision,
      inventoryFingerprint,
    });
  await expect(finish(1)).rejects.toThrow('conflict');
  await f.db
    .updateTable('satisfactory_mod_states')
    .set({ inventory_fingerprint: fingerprint, revision: 2 })
    .where('server_id', '=', id)
    .execute();
  await expect(finish(1)).rejects.toThrow('conflict');
  await expect(finish(2, '0'.repeat(64))).rejects.toThrow('conflict');
  expect(await finish(2)).toEqual({ externalMode: false });
  const state = await f.db
    .selectFrom('satisfactory_mod_states')
    .selectAll()
    .where('server_id', '=', id)
    .executeTakeFirstOrThrow();
  expect(state.external_mode).toBe(false);
  expect(state.revision).toBe(3);
  expect(
    (
      await f.db
        .selectFrom('managed_servers')
        .select('intent')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).intent,
  ).toBe('manually_stopped');
});
