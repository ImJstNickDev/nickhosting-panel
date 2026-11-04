import { randomBytes } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { satisfactoryManifest } from '../../../games/satisfactory/src/manifest.js';
import {
  classifySatisfactorySafetySaves,
  readSatisfactorySaveRetention,
  updateSatisfactorySaveRetention,
} from './satisfactory-save-retention.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
async function fixture() {
  const f = await managementFixture(database.db, { interactive: true });
  const id = await f.server();
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
  return { ...f, id };
}
it('persists per-session policies, with defaults and environment precedence', async () => {
  const f = await fixture();
  expect(await readSatisfactorySaveRetention(f.db, f.id)).toMatchObject({
    defaultKeep: 5,
    policies: [],
    environmentLocked: false,
  });
  await updateSatisfactorySaveRetention(f.db, f.context, f.id, { sessionName: 'World A', keep: 3 });
  await updateSatisfactorySaveRetention(f.db, f.context, f.id, { sessionName: 'World B', keep: 8 });
  expect((await readSatisfactorySaveRetention(f.db, f.id)).policies).toEqual([
    { sessionName: 'World A', keep: 3 },
    { sessionName: 'World B', keep: 8 },
  ]);
  expect(
    await readSatisfactorySaveRetention(f.db, f.id, { SATISFACTORY_SAFETY_SAVE_RETENTION: '2' }),
  ).toMatchObject({
    defaultKeep: 2,
    environmentLocked: true,
    policies: [
      { sessionName: 'World A', keep: 2 },
      { sessionName: 'World B', keep: 2 },
    ],
  });
  await expect(
    updateSatisfactorySaveRetention(
      f.db,
      f.context,
      f.id,
      { sessionName: 'World A', keep: 4 },
      { SATISFACTORY_SAFETY_SAVE_RETENTION: '2' },
    ),
  ).rejects.toMatchObject({ code: 'conflict' });
});
it('rejects policy changes while a lifecycle delivery holds the exclusive server lock', async () => {
  const f = await fixture();
  await f.db.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(hashtextextended(current_schema() || ${`:nickhosting:server:${f.id}`},0))`.execute(
      connection,
    );
    try {
      await expect(
        updateSatisfactorySaveRetention(f.db, f.context, f.id, { sessionName: 'World', keep: 1 }),
      ).rejects.toMatchObject({ code: 'conflict' });
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${`:nickhosting:server:${f.id}`},0))`.execute(
        connection,
      );
    }
  });
});
it('does not infer safety provenance from a prefix or an unrelated provision operation', async () => {
  const f = await fixture();
  const job = await f.db
    .selectFrom('server_operations')
    .select('job_id')
    .where('server_id', '=', f.id)
    .executeTakeFirstOrThrow();
  expect(
    await classifySatisfactorySafetySaves(f.db, f.id, ['nh-stop-manual', `nh-stop-${job.job_id}`]),
  ).toEqual(new Set());
  await f.db
    .updateTable('server_operations')
    .set({ action: 'stop' })
    .where('job_id', '=', job.job_id)
    .execute();
  expect(await classifySatisfactorySafetySaves(f.db, f.id, [`nh-stop-${job.job_id}`])).toEqual(
    new Set([`nh-stop-${job.job_id}`]),
  );
  expect(
    await f.db
      .selectFrom('satisfactory_safety_saves')
      .selectAll()
      .where('server_id', '=', f.id)
      .execute(),
  ).toEqual([]);
});

it('supports native external session names up to the original API limit', async () => {
  const f = await fixture();
  const sessionName = randomBytes(3072).toString('base64');
  await updateSatisfactorySaveRetention(f.db, f.context, f.id, { sessionName, keep: 5 });
  expect((await readSatisfactorySaveRetention(f.db, f.id)).policies).toEqual([
    { sessionName, keep: 5 },
  ]);
  await updateSatisfactorySaveRetention(f.db, f.context, f.id, { sessionName, keep: 7 });
  const unicodeName = Array.from(randomBytes(8192), (byte, index) =>
    index % 2 === 0 ? String.fromCharCode(0x4e00 + byte * 64 + (index % 64)) : '',
  ).join('');
  await updateSatisfactorySaveRetention(f.db, f.context, f.id, {
    sessionName: unicodeName,
    keep: 3,
  });
  expect((await readSatisfactorySaveRetention(f.db, f.id)).policies).toEqual(
    expect.arrayContaining([
      { sessionName, keep: 7 },
      { sessionName: unicodeName, keep: 3 },
    ]),
  );
  const job = await f.db
    .selectFrom('server_operations')
    .select('job_id')
    .where('server_id', '=', f.id)
    .executeTakeFirstOrThrow();
  await f.db
    .insertInto('satisfactory_safety_saves')
    .values({
      server_id: f.id,
      save_name: `nh-stop-${job.job_id}`,
      session_name: unicodeName,
      job_id: job.job_id,
      path: '/save',
      sha256: 'a'.repeat(64),
      size: 12,
      modified_at: '2026-11-02T00:00:00Z',
      deleted_at: null,
    })
    .execute();
  await expect(
    updateSatisfactorySaveRetention(f.db, f.context, f.id, {
      sessionName: `${sessionName}S`,
      keep: 5,
    }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
});
