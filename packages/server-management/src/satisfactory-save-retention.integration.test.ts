import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { satisfactorySaveHeaderSchema } from '../../../games/satisfactory/src/api-schemas.js';
import { satisfactoryManifest } from '../../../games/satisfactory/src/manifest.js';
import type { GameLifecycleContext } from './lifecycle.js';
import {
  classifySatisfactorySafetySaves,
  readSatisfactorySaveRetention,
  rotateSatisfactorySafetySaves,
  updateSatisfactorySaveRetention,
} from './satisfactory-save-retention.js';
import { managementFixture } from './test-fixtures.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}

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

async function legacyFixture() {
  const f = await fixture();
  const root = '.config/Epic/FactoryGame/Saved/SaveGames/server';
  const codec = new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } });
  const operation = await f.db
    .selectFrom('server_operations')
    .selectAll()
    .where('server_id', '=', f.id)
    .executeTakeFirstOrThrow();
  const template = await f.db
    .selectFrom('operation_jobs')
    .selectAll()
    .where('id', '=', operation.job_id)
    .executeTakeFirstOrThrow();
  const files = new Map<string, { data: Buffer; modified: string; symlink?: boolean }>();
  const headers: Array<z.infer<typeof satisfactorySaveHeaderSchema>> = [];
  const jobs: Array<{ id: string; saveName: string; at: number }> = [];
  for (let index = 0; index < 7; index++) {
    const at = index === 0 ? Date.now() - 30000 : Date.UTC(2026, 10, 2, 14, index, 26);
    const id = randomUUID(),
      saveName = `nh-stop-${id}`;
    await f.db
      .insertInto('operation_jobs')
      .values({
        ...template,
        id,
        idempotency_key: randomUUID(),
        command: JSON.stringify(template.command),
        policy_snapshot: JSON.stringify(template.policy_snapshot),
        state: 'succeeded',
        created_at: new Date(at + 250),
        updated_at: new Date(at + 7500),
        completed_at: new Date(at + 7500),
      })
      .execute();
    await f.db
      .insertInto('server_operations')
      .values({
        ...operation,
        job_id: id,
        action: 'stop',
        phase: 'complete',
        plan: '{}',
        updated_at: new Date(at + 7500),
      })
      .execute();
    const data = Buffer.from(`historical save ${index}`),
      modified = new Date(at + 1000).toISOString();
    files.set(`${saveName}.sav`, { data, modified });
    const nativeTime = new Date(at)
      .toISOString()
      .slice(0, 19)
      .replaceAll('-', '.')
      .replace('T', '-')
      .replaceAll(':', '.');
    headers.push({
      saveVersion: 1,
      buildVersion: 513885,
      saveName,
      saveLocationInfo: 'SLI_Server',
      mapName: 'Persistent_Level',
      mapOptions: '',
      sessionName: 'Test',
      playDurationSeconds: index,
      saveDateTime: nativeTime,
      isModdedSave: false,
      isEditedSave: false,
      isCreativeModeEnabled: false,
    });
    jobs.push({ id, saveName, at });
    if (index === 0)
      await f.db
        .insertInto('satisfactory_safety_saves')
        .values({
          server_id: f.id,
          save_name: saveName,
          session_name: 'Test',
          job_id: id,
          path: `${root}/${saveName}.sav`,
          sha256: createHash('sha256').update(data).digest('hex'),
          size: data.length,
          modified_at: modified,
          created_at: new Date(at),
          deleted_at: null,
        })
        .execute();
  }
  files.set('Test_autosave_0.sav', {
    data: Buffer.from('autosave'),
    modified: new Date().toISOString(),
  });
  files.set(`nh-stop-${randomUUID()}.sav`, {
    data: Buffer.from('unproven'),
    modified: new Date().toISOString(),
  });
  const adapter = {
    listFiles: vi.fn(async (_identifier: string, directory: string) =>
      directory === root
        ? [...files].map(([name, value]) => ({
            name,
            is_file: true,
            is_symlink: !!value.symlink,
            size: value.data.length,
            modified_at: value.modified,
          }))
        : [
            {
              name: root.slice(directory.length ? directory.length + 1 : 0).split('/')[0],
              is_file: false,
              is_symlink: false,
            },
          ],
    ),
    downloadFile: vi.fn(async (_identifier: string, path: string) => {
      const file = files.get(path.slice(root.length + 1));
      if (!file) throw new Error('missing file');
      return { body: new Response(new Uint8Array(file.data)).body };
    }),
    deleteFiles: vi.fn(async (_identifier: string, _directory: string, names: string[]) => {
      for (const name of names) files.delete(name);
    }),
  };
  const context = {
    db: f.db,
    adapter,
    server: { id: f.id, pterodactyl_identifier: 'fixture' },
    authorize: vi.fn(async () => {}),
    assertStopped: vi.fn(async () => {}),
    event: vi.fn(async () => {}),
    operation: () => ({ job_id: jobs[0]?.id }),
  } as unknown as GameLifecycleContext;
  async function persist() {
    const name = `gateway.satisfactory.observations.${f.id}`;
    const snapshot = {
      EnumerateSessions: {
        observedAt: Date.now(),
        body: {
          data: {
            sessions: [{ sessionName: 'Test', saveHeaders: headers }],
            currentSessionIndex: 0,
          },
        },
      },
    };
    await f.db
      .insertInto('encrypted_secrets')
      .values({ name, envelope: codec.encrypt(JSON.stringify(snapshot), name) })
      .onConflict((conflict) =>
        conflict
          .column('name')
          .doUpdateSet({ envelope: codec.encrypt(JSON.stringify(snapshot), name) }),
      )
      .execute();
  }
  const receipts = () =>
    f.db
      .selectFrom('satisfactory_safety_saves')
      .selectAll()
      .where('server_id', '=', f.id)
      .execute();
  return { ...f, context, codec, files, headers, jobs, adapter, persist, receipts };
}
it('adopts the six historical native saves and rotates them with the current recovery point', async () => {
  const f = await legacyFixture();
  await f.persist();
  await rotateSatisfactorySafetySaves(f.context, {}, f.codec);
  const rows = await f.receipts();
  expect(rows).toHaveLength(7);
  expect(rows.filter((row) => row.deleted_at !== null)).toHaveLength(2);
  expect(f.adapter.deleteFiles).toHaveBeenCalledTimes(2);
  expect(f.files.has(`${f.jobs[0]?.saveName}.sav`)).toBe(true);
  expect(f.files.has('Test_autosave_0.sav')).toBe(true);
  for (const row of rows.filter((row) => row.job_id !== f.jobs[0]?.id)) {
    expect(row.created_at.getTime()).toBe(f.jobs.find((job) => job.id === row.job_id)?.at);
  }
  await rotateSatisfactorySafetySaves(f.context, {}, f.codec);
  expect(f.adapter.deleteFiles).toHaveBeenCalledTimes(2);
  expect(await f.receipts()).toHaveLength(7);
});
it('excludes wrong-session, unrelated-job, changed-time, ambiguous and symlink legacy files', async () => {
  const f = await legacyFixture();
  required(f.headers[1]).sessionName = 'Other World';
  await f.db
    .updateTable('server_operations')
    .set({ action: 'provision' })
    .where('job_id', '=', required(f.jobs[2]).id)
    .execute();
  required(f.files.get(`${required(f.jobs[3]).saveName}.sav`)).modified = new Date().toISOString();
  f.headers.push({ ...required(f.headers[4]) });
  required(f.files.get(`${required(f.jobs[5]).saveName}.sav`)).symlink = true;
  required(f.headers[6]).saveDateTime = '2026.11.32-14.06.26';
  await f.persist();
  await rotateSatisfactorySafetySaves(
    f.context,
    { SATISFACTORY_SAFETY_SAVE_RETENTION: '1' },
    f.codec,
  );
  expect(await f.receipts()).toHaveLength(1);
  expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
});
it('rejects a matching job owned by another server and saves outside its historical job window', async () => {
  const f = await legacyFixture();
  const otherServer = (await fixture()).id;
  await f.db
    .updateTable('server_operations')
    .set({ server_id: otherServer })
    .where('job_id', '=', required(f.jobs[1]).id)
    .execute();
  await f.db
    .updateTable('operation_jobs')
    .set({ created_at: new Date(required(f.jobs[2]).at + 10000) })
    .where('id', '=', required(f.jobs[2]).id)
    .execute();
  await f.db
    .updateTable('operation_jobs')
    .set({ completed_at: new Date(required(f.jobs[3]).at) })
    .where('id', '=', required(f.jobs[3]).id)
    .execute();
  required(f.files.get(`${required(f.jobs[3]).saveName}.sav`)).modified = new Date(
    required(f.jobs[3]).at + 2000,
  ).toISOString();
  await f.persist();
  await rotateSatisfactorySafetySaves(
    f.context,
    { SATISFACTORY_SAFETY_SAVE_RETENTION: '100' },
    f.codec,
  );
  const rows = await f.receipts();
  for (const job of f.jobs.slice(1, 4))
    expect(rows.some((row) => row.job_id === job.id)).toBe(false);
  expect(rows).toHaveLength(4);
});
it('never reenrolls a tombstone or overwrites a receipt after file content changes', async () => {
  const f = await legacyFixture();
  await f.persist();
  await rotateSatisfactorySafetySaves(
    f.context,
    { SATISFACTORY_SAFETY_SAVE_RETENTION: '100' },
    f.codec,
  );
  const before = await f.receipts();
  expect(before).toHaveLength(7);
  const changed = required(f.jobs[6]);
  required(f.files.get(`${changed.saveName}.sav`)).data = Buffer.from('replaced save bytes');
  const tombstone = required(f.jobs[5]);
  await f.db
    .updateTable('satisfactory_safety_saves')
    .set({ deleted_at: new Date() })
    .where('job_id', '=', tombstone.id)
    .execute();
  await rotateSatisfactorySafetySaves(
    f.context,
    { SATISFACTORY_SAFETY_SAVE_RETENTION: '1' },
    f.codec,
  );
  expect(f.files.has(`${changed.saveName}.sav`)).toBe(true);
  expect(f.files.has(`${tombstone.saveName}.sav`)).toBe(true);
  const after = await f.receipts();
  expect(after.find((row) => row.job_id === changed.id)?.sha256).toBe(
    before.find((row) => row.job_id === changed.id)?.sha256,
  );
  expect(f.adapter.deleteFiles).toHaveBeenCalledTimes(2);
});
it('requires stopped proof and a fresh current-operation recovery receipt before legacy adoption', async () => {
  const f = await legacyFixture();
  await f.persist();
  vi.mocked(f.context.assertStopped).mockRejectedValue(new Error('running'));
  await expect(rotateSatisfactorySafetySaves(f.context, {}, f.codec)).rejects.toThrow('running');
  expect(await f.receipts()).toHaveLength(1);
  expect(f.adapter.downloadFile).not.toHaveBeenCalled();
  vi.mocked(f.context.assertStopped).mockResolvedValue();
  f.context.operation = () =>
    ({ job_id: randomUUID() }) as ReturnType<GameLifecycleContext['operation']>;
  await rotateSatisfactorySafetySaves(f.context, {}, f.codec);
  expect(await f.receipts()).toHaveLength(1);
  expect(f.adapter.downloadFile).not.toHaveBeenCalled();
});
