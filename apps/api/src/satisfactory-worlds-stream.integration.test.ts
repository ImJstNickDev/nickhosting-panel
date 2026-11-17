import { randomBytes } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { satisfactoryManifest } from '../../../games/satisfactory/src/manifest.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import {
  satisfactoryWorldsDependencies,
  streamSatisfactoryWorlds,
} from './satisfactory-worlds-stream.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const codec = new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } });
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
it('reuses encrypted native observations offline and filters only receipt-proven later removals', async () => {
  const f = await managementFixture(database.db, { interactive: true });
  const serverId = await f.server();
  await f.db
    .insertInto('game_integrations')
    .values({
      id: 'satisfactory',
      version: satisfactoryManifest.version,
      manifest: satisfactoryManifest,
    })
    .onConflict((conflict) => conflict.column('id').doNothing())
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'satisfactory', runtime_id: 'dedicated' })
    .where('id', '=', f.mappingId)
    .execute();
  await f.db
    .updateTable('managed_servers')
    .set({ installation_state: 'installed', runtime_state: 'offline', readiness: 'unknown' })
    .where('id', '=', serverId)
    .execute();
  const save = {
    saveVersion: 1,
    buildVersion: 123,
    saveName: 'private-world-save',
    mapName: 'Persistent_Level',
    mapOptions: '',
    sessionName: 'Private Factory',
    playDurationSeconds: 123,
    saveDateTime: '2026-11-02T00:00:00Z',
    isModdedSave: false,
    isEditedSave: false,
    isCreativeModeEnabled: false,
  };
  const operation = await f.db
    .selectFrom('server_operations')
    .select('job_id')
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
  const safetyName = `nh-stop-${operation.job_id}`;
  const data = {
    sessions: [
      {
        sessionName: save.sessionName,
        saveHeaders: Array.from({ length: 1000 }, (_, i) => ({
          ...save,
          saveName: i === 0 ? safetyName : `private-world-save-${i}`,
        })),
      },
    ],
    currentSessionIndex: 0,
  };
  const deps = satisfactoryWorldsDependencies(f.db, codec, serverId);
  expect(await deps.snapshot()).toBeUndefined();
  await deps.persist(data);
  const stored = await f.db
    .selectFrom('encrypted_secrets')
    .select('envelope')
    .where('name', '=', `gateway.satisfactory.observations.${serverId}`)
    .executeTakeFirstOrThrow();
  expect(JSON.stringify(stored.envelope)).not.toContain('private-world-save');
  const initial = await deps.snapshot();
  expect(initial?.data).toEqual(data);
  if (!initial) throw new Error('missing snapshot');
  await f.db
    .insertInto('satisfactory_safety_saves')
    .values({
      server_id: serverId,
      save_name: safetyName,
      session_name: save.sessionName,
      job_id: operation.job_id,
      path: '/save.sav',
      sha256: 'a'.repeat(64),
      size: 123,
      modified_at: new Date().toISOString(),
      deleted_at: new Date(initial.observedAt + 1),
    })
    .execute();
  const current = await deps.snapshot();
  expect(current?.data.sessions[0]?.saveHeaders).toHaveLength(999);
  expect(current?.data.sessions[0]?.saveHeaders[0]?.saveName).toBe('private-world-save-1');
  const api = vi.fn();
  const events = [];
  for await (const event of streamSatisfactoryWorlds(
    serverId,
    { ...deps, api },
    new AbortController().signal,
  ))
    events.push(event);
  expect(events).toContainEqual(expect.objectContaining({ type: 'complete', source: 'cache' }));
  expect(api).not.toHaveBeenCalled();
});
