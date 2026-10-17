import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { getSettings, updateSettings } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readContentClaimUsage, reserveContentStaging } from './content-admission.js';
import { createMinecraftSourceStore } from './minecraft-sources.js';
import { enqueueServerOperation } from './registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let first: Awaited<ReturnType<typeof managementFixture>>;
let second: Awaited<ReturnType<typeof managementFixture>>;
let root: string;
let env: Record<string, string>;
const disk = { observeDisk: async () => ({ available: 100000000n, total: 100000000n }) };

beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  await database.db.deleteFrom('minecraft_staging_claims').execute();
  await database.db.deleteFrom('minecraft_source_bindings').execute();
  await database.db.deleteFrom('minecraft_sources').execute();
  await database.db.deleteFrom('platform_settings').where('key', '=', 'platform').execute();
  first = await managementFixture(database.db, { interactive: true });
  second = await managementFixture(database.db, { interactive: true });
  root = `./mountdata/test-assets/content-policy-${randomUUID()}`;
  env = {
    NH_CONTENT_SOURCE_ROOT: `${root}/sources`,
    NH_CONTENT_WORK_ROOT: `${root}/work`,
    NH_CONTENT_SOURCE_FREE_BYTES: '0',
    NH_CONTENT_SOURCE_FREE_PERCENT: '0',
    NH_CONTENT_SOURCE_GLOBAL_BYTES: '1000000',
    NH_CONTENT_SOURCE_USER_BYTES: '1000000',
    NH_CONTENT_SOURCE_CONCURRENT: '4',
    NH_CONTENT_SOURCE_USER_CONCURRENT: '4',
  };
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function job(fixture: typeof first) {
  const serverId = await fixture.server();
  const operation = await enqueueServerOperation(fixture.db, fixture.context, serverId, {
    action: 'reinstall',
    idempotencyKey: randomUUID(),
    confirm: true,
  });
  await fixture.db
    .updateTable('operation_jobs')
    .set({ state: 'running', completed_at: null })
    .where('id', '=', operation.jobId)
    .execute();
  return { serverId, jobId: operation.jobId };
}
const sourceInput = () => ({
  kind: 'modpack',
  idempotencyKey: randomUUID(),
  bytes: 1,
  sha256: createHash('sha256').update('x').digest('hex'),
});

describe('cross-integration content ledger', () => {
  it('serializes competing stages from two games against a single global concurrency ceiling', async () => {
    const a = await job(first),
      b = await job(second);
    const environment = { ...env, NH_CONTENT_SOURCE_CONCURRENT: '1' };
    const results = await Promise.allSettled([
      reserveContentStaging(first.db, first.context, a.jobId, a.serverId, 1, environment, disk),
      reserveContentStaging(second.db, second.context, b.jobId, b.serverId, 1, environment, disk),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rows = await first.db.selectFrom('minecraft_staging_claims').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect([first.gameId, second.gameId]).toContain(rows[0]?.game_id);
    expect(await readContentClaimUsage(first.db)).toEqual([
      expect.objectContaining({ bytes: 65537n, active: 1, gameId: rows[0]?.game_id }),
    ]);
  });
  it('charges Minecraft sources and another integration stage to the same bytes and concurrency', async () => {
    const source = await createMinecraftSourceStore(
      first.db,
      first.context,
      env,
      disk,
    ).reserveUpload(sourceInput());
    const b = await job(second);
    const limited = { ...env, NH_CONTENT_SOURCE_GLOBAL_BYTES: '100000' };
    await expect(
      reserveContentStaging(second.db, second.context, b.jobId, b.serverId, 1, limited, disk),
    ).rejects.toThrow('resources_unavailable');
    await first.db
      .updateTable('minecraft_sources')
      .set({ state: 'ready', actual_sha256: '0'.repeat(64) })
      .where('id', '=', source.id)
      .execute();
    // Completed ingestion retains bytes even though its transfer slot is free.
    await expect(
      reserveContentStaging(second.db, second.context, b.jobId, b.serverId, 1, limited, disk),
    ).rejects.toThrow('resources_unavailable');
    const stage = await reserveContentStaging(
      second.db,
      second.context,
      b.jobId,
      b.serverId,
      1,
      env,
      disk,
    );
    expect((await readContentClaimUsage(first.db)).map((row) => row.gameId).sort()).toEqual(
      ['minecraft', second.gameId].sort(),
    );
    expect(
      await reserveContentStaging(second.db, second.context, b.jobId, b.serverId, 1, env, disk),
    ).toEqual(stage);
    expect(
      await first.db.selectFrom('minecraft_staging_claims').select('job_id').execute(),
    ).toHaveLength(1);
  });
  it('enforces a local integration cap while another game can still use remaining global capacity', async () => {
    const a = await job(first),
      another = await job(first),
      b = await job(second);
    const environment = {
      ...env,
      NH_GAME_CONTENT_POLICIES: JSON.stringify({ [first.gameId]: { sourceConcurrent: 1 } }),
    };
    await reserveContentStaging(first.db, first.context, a.jobId, a.serverId, 1, environment, disk);
    await expect(
      reserveContentStaging(
        first.db,
        first.context,
        another.jobId,
        another.serverId,
        1,
        environment,
        disk,
      ),
    ).rejects.toThrow('resources_unavailable');
    await reserveContentStaging(
      second.db,
      second.context,
      b.jobId,
      b.serverId,
      1,
      environment,
      disk,
    );
    await first.db
      .updateTable('operation_jobs')
      .set({ state: 'succeeded', completed_at: new Date() })
      .where('id', '=', a.jobId)
      .execute();
    await reserveContentStaging(
      first.db,
      first.context,
      another.jobId,
      another.serverId,
      1,
      environment,
      disk,
    );
    const usage = await readContentClaimUsage(first.db);
    expect(usage.find((row) => row.gameId === first.gameId)).toMatchObject({
      bytes: 131074n,
      active: 1,
    });
  });
  it('preserves ownership and exact active-job authorization for every integration', async () => {
    const a = await job(first);
    await expect(
      reserveContentStaging(second.db, second.context, a.jobId, a.serverId, 1, env, disk),
    ).rejects.toThrow('forbidden');
    await first.db
      .updateTable('operation_jobs')
      .set({ state: 'queued' })
      .where('id', '=', a.jobId)
      .execute();
    await expect(
      reserveContentStaging(first.db, first.context, a.jobId, a.serverId, 1, env, disk),
    ).rejects.toThrow('forbidden');
    expect(
      await first.db.selectFrom('minecraft_staging_claims').select('job_id').execute(),
    ).toHaveLength(0);
  });
  it('does not expose or recover another integration through Minecraft source endpoints', async () => {
    const b = await job(second);
    const stage = await reserveContentStaging(
      second.db,
      second.context,
      b.jobId,
      b.serverId,
      1,
      env,
      disk,
    );
    const source = await createMinecraftSourceStore(
      first.db,
      first.context,
      env,
      disk,
    ).reserveUpload(sourceInput());
    await first.db
      .updateTable('minecraft_sources')
      .set({ game_id: second.gameId })
      .where('id', '=', source.id)
      .execute();
    const owner = createMinecraftSourceStore(first.db, first.owner, env, disk);
    expect(await owner.ownerInventory()).toEqual({ sources: [], stages: [] });
    await expect(owner.inspect(source.id)).rejects.toThrow('not_found');
    await expect(
      owner.recoverStaging(b.jobId, {
        confirm: true,
        identityDigest: stage.identityDigest,
        filesRemoved: true,
        workerStopped: true,
        reason: 'Foreign integration recovery fixture',
        evidence: 'The fixture proves no other integration claim is selected.',
      }),
    ).rejects.toThrow('not_found');
    await expect(
      owner.recover(source.id, {
        confirm: true,
        identityDigest: source.identityDigest,
        unusedByJobs: true,
        filesRemoved: true,
        transferStopped: true,
        reason: 'Foreign integration recovery fixture',
        evidence: 'The fixture proves no other integration claim is selected.',
      }),
    ).rejects.toThrow('not_found');
    expect(
      await first.db
        .selectFrom('minecraft_staging_claims')
        .select('state')
        .where('job_id', '=', b.jobId)
        .executeTakeFirst(),
    ).toEqual({ state: 'reserved' });
    expect(
      await first.db
        .selectFrom('minecraft_sources')
        .select('state')
        .where('id', '=', source.id)
        .executeTakeFirst(),
    ).toEqual({ state: 'reserved' });
  });
  it('normalizes legacy Owner settings without changing roots and accepts canonical updates', async () => {
    await sql`insert into platform_settings(key,value) values ('platform', ${JSON.stringify({ minecraftSourceRoot: `${root}/old-sources`, minecraftContentRoot: `${root}/old-work`, minecraftSourceConcurrent: 2 })}::jsonb) on conflict(key) do update set value = platform_settings.value || excluded.value`.execute(
      first.db,
    );
    expect((await getSettings(first.db)).values).toMatchObject({
      contentSourceRoot: `${root}/old-sources`,
      contentWorkRoot: `${root}/old-work`,
      contentSourceConcurrent: 2,
    });
    await updateSettings(first.db, first.owner, { contentSourceConcurrent: 3 });
    const stored = await first.db
      .selectFrom('platform_settings')
      .select('value')
      .where('key', '=', 'platform')
      .executeTakeFirstOrThrow();
    expect(stored.value).toMatchObject({
      contentSourceRoot: `${root}/old-sources`,
      contentWorkRoot: `${root}/old-work`,
      contentSourceConcurrent: 3,
    });
    expect(stored.value).not.toHaveProperty('minecraftSourceConcurrent');
  });
});
