import { randomUUID } from 'node:crypto';
import { authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getServerProvisioning } from './provisioning.js';
import { managementFixture } from './test-fixtures.js';

describe('Console modpack preparation projection', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(async () => {
    await database?.destroy();
  });
  async function fixture(
    state: 'queued' | 'preparing' | 'blocked' | 'cancelled' = 'queued',
    install = true,
  ) {
    const f = await managementFixture(database.db, { interactive: true });
    const serverId = await f.server();
    const job = await f.db
      .selectFrom('server_operations')
      .select('job_id')
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('operation_jobs')
      .set({ created_at: new Date('2026-01-01T00:00:00Z') })
      .where('id', '=', job.job_id)
      .execute();
    const id = randomUUID();
    await f.db
      .insertInto('minecraft_modpack_operations')
      .values({
        id,
        server_id: serverId,
        actor_user_id: f.context.actorUserId,
        actor_session_id: f.context[authSessionId] as string,
        subject_user_id: f.context.subjectUserId,
        support_session_id: null,
        resource_owner_id: f.context.subjectUserId,
        physical_host_id: null,
        held_bytes: '0',
        staging_root: null,
        idempotency_key: randomUUID(),
        selection: JSON.stringify({
          provider: 'modrinth',
          projectId: 'pack',
          versionId: 'v1',
          ...(install ? { install: { backupBefore: false } } : {}),
        }),
        state,
        phase: state === 'preparing' ? 'downloading' : state === 'blocked' ? 'ready' : 'queued',
        progress: 'null',
        prepared: 'null',
        plan: 'null',
        plan_digest: null,
        blockers: '[]',
        apply_request: 'null',
        apply_actor_user_id: null,
        apply_actor_session_id: null,
        apply_subject_user_id: null,
        apply_support_session_id: null,
        apply_idempotency_key: null,
        journal: '[]',
        backup_id: null,
        restart_required: false,
        error: null,
        lease_token: null,
        lease_until: null,
        created_at: new Date('2026-01-02T00:00:00Z'),
      })
      .execute();
    return { ...f, serverId, id, jobId: job.job_id };
  }
  it.each(['queued', 'preparing', 'blocked'] as const)(
    'shows %s install intent before a provider job exists',
    async (state) => {
      const f = await fixture(state);
      expect(await getServerProvisioning(f.db, f.context, f.serverId)).toMatchObject({
        jobId: f.id,
        state: state === 'blocked' ? 'failed' : 'active',
        stage: 'preparing',
        stages: [],
        logs: [],
        canReinstall: false,
        workflow: {
          titleKey: 'games.minecraft.sections.modpacks',
          statusKey: `games.minecraft.modpacks.${state === 'blocked' ? 'needsAttention' : state}`,
        },
      });
      expect(
        await f.db
          .selectFrom('operation_jobs')
          .select('id')
          .where('id', '=', f.id)
          .executeTakeFirst(),
      ).toBeUndefined();
      const outsider = await managementFixture(f.db, { interactive: true });
      await expect(getServerProvisioning(f.db, outsider.context, f.serverId)).rejects.toThrow();
    },
  );
  it('does not expose ordinary preparation or cancelled intents as installation progress', async () => {
    const f = await fixture('queued', false);
    expect((await getServerProvisioning(f.db, f.context, f.serverId))?.jobId).toBe(f.jobId);
    await f.db
      .updateTable('minecraft_modpack_operations')
      .set({ state: 'cancelled', selection: JSON.stringify({ install: { backupBefore: false } }) })
      .where('id', '=', f.id)
      .execute();
    expect((await getServerProvisioning(f.db, f.context, f.serverId))?.jobId).toBe(f.jobId);
  });
  it('allows a later ordinary installation job to supersede an older preparation', async () => {
    const f = await fixture('blocked');
    await f.db
      .updateTable('operation_jobs')
      .set({ created_at: new Date('2026-01-03T00:00:00Z') })
      .where('id', '=', f.jobId)
      .execute();
    expect((await getServerProvisioning(f.db, f.context, f.serverId))?.jobId).toBe(f.jobId);
  });
});
