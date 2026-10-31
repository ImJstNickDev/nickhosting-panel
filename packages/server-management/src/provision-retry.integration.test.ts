import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServerProvisioning } from './provisioning.js';
import { createManagedServer, enqueueServerOperation } from './registry.js';
import { managementFixture, pendingUploadFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
async function fixture() {
  const f = await managementFixture(database.db, { interactive: true });
  const created = await createManagedServer(f.db, f.adapter, f.context, f.input(), {
    NH_STORAGE_POLICY: 'PER_USER_BUDGET',
  });
  const original = await f.db
    .selectFrom('server_operations')
    .selectAll()
    .where('job_id', '=', created.jobId)
    .executeTakeFirstOrThrow();
  await f.db
    .updateTable('operation_jobs')
    .set({ state: 'failed', error_code: 'configuration_invalid', completed_at: new Date() })
    .where('id', '=', created.jobId)
    .execute();
  await f.db
    .updateTable('server_operations')
    .set({
      phase: 'failed',
      plan: JSON.stringify({
        ...original.plan,
        noExternalEffect: true,
        rejected: true,
        acknowledgment: 'must-not-copy',
      }),
    })
    .where('job_id', '=', created.jobId)
    .execute();
  await f.db
    .updateTable('managed_servers')
    .set({ installation_state: 'failed', active_operation_id: null })
    .where('id', '=', created.serverId)
    .execute();
  await f.db.deleteFrom('job_outbox').where('job_id', '=', created.jobId).execute();
  const input = {
    action: 'retry-provision',
    failedJobId: created.jobId,
    idempotencyKey: randomUUID(),
  };
  return { ...f, ...created, original, input, createInput: f.input };
}
describe('retry a proven pre-provider provisioning failure', () => {
  it('exposes a separate capability and idempotently requeues the same exact plan', async () => {
    const f = await fixture();
    expect(await getServerProvisioning(f.db, f.context, f.serverId)).toMatchObject({
      canRetryProvision: true,
      canReinstall: false,
    });
    const results = await Promise.all([
      enqueueServerOperation(f.db, f.context, f.serverId, f.input),
      enqueueServerOperation(f.db, f.context, f.serverId, f.input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.jobId).not.toBe(f.jobId);
    const result = results[0];
    if (!result) throw new Error('missing retry');
    const retry = await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', result.jobId)
      .executeTakeFirstOrThrow();
    expect(retry).toMatchObject({
      action: 'provision',
      phase: 'planned',
      effect_state: 'none',
      effect_started_at: null,
    });
    expect(retry.plan).toEqual({ ...f.original.plan, retriedProvisionJobId: f.jobId });
    expect(
      await f.db
        .selectFrom('managed_servers')
        .select(['installation_state', 'pterodactyl_id', 'active_operation_id'])
        .where('id', '=', f.serverId)
        .executeTakeFirst(),
    ).toEqual({
      installation_state: 'pending',
      pterodactyl_id: null,
      active_operation_id: retry.job_id,
    });
    expect(await getServerProvisioning(f.db, f.context, f.serverId)).toMatchObject({
      canRetryProvision: false,
    });
    await expect(
      enqueueServerOperation(f.db, f.context, f.serverId, {
        ...f.input,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('conflict');
  });
  it.each([
    'uncertain',
    'effect-started',
    'no-proof',
    'provider-id',
    'stale-job',
    'lease',
    'pending-upload',
  ])('blocks retry when %s invalidates local absence proof', async (caseName) => {
    const f = await fixture();
    if (caseName === 'uncertain')
      await f.db
        .updateTable('server_operations')
        .set({ effect_state: 'uncertain' })
        .where('job_id', '=', f.jobId)
        .execute();
    if (caseName === 'effect-started')
      await f.db
        .updateTable('server_operations')
        .set({ effect_started_at: new Date() })
        .where('job_id', '=', f.jobId)
        .execute();
    if (caseName === 'no-proof')
      await f.db
        .updateTable('server_operations')
        .set({ plan: JSON.stringify(f.original.plan) })
        .where('job_id', '=', f.jobId)
        .execute();
    if (caseName === 'provider-id')
      await f.db
        .updateTable('managed_servers')
        .set({
          pterodactyl_id: 9901,
          pterodactyl_uuid: randomUUID(),
          pterodactyl_identifier: 'retry-test',
        })
        .where('id', '=', f.serverId)
        .execute();
    if (caseName === 'lease')
      await f.db
        .updateTable('server_operations')
        .set({ lease_token: randomUUID(), lease_until: new Date(Date.now() + 60000) })
        .where('job_id', '=', f.jobId)
        .execute();
    if (caseName === 'pending-upload') await pendingUploadFixture(f.db, f.serverId);
    const input = caseName === 'stale-job' ? { ...f.input, failedJobId: randomUUID() } : f.input;
    await expect(enqueueServerOperation(f.db, f.context, f.serverId, input)).rejects.toThrow();
    if (caseName !== 'stale-job')
      expect(await getServerProvisioning(f.db, f.context, f.serverId)).toMatchObject({
        canRetryProvision: false,
      });
    expect(
      await f.db
        .selectFrom('server_operations')
        .select('job_id')
        .where('server_id', '=', f.serverId)
        .execute(),
    ).toHaveLength(1);
  });
  it('requires current server management permission and preserves the failed job', async () => {
    const f = await fixture();
    const foreign = await managementFixture(f.db, { interactive: true });
    await expect(
      enqueueServerOperation(f.db, foreign.context, f.serverId, f.input),
    ).rejects.toThrow('forbidden');
    expect(
      await f.db
        .selectFrom('operation_jobs')
        .select('state')
        .where('id', '=', f.jobId)
        .executeTakeFirst(),
    ).toEqual({ state: 'failed' });
  });
  it('honors the resource-owner concurrent provision cap', async () => {
    const f = await fixture();
    await createManagedServer(f.db, f.adapter, f.context, f.createInput(), {
      NH_STORAGE_POLICY: 'PER_USER_BUDGET',
    });
    const settings = await f.db
      .selectFrom('platform_settings')
      .select('value')
      .where('key', '=', 'platform')
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('platform_settings')
      .set({ value: { ...settings.value, maxConcurrentProvisionsPerUser: 1 } })
      .where('key', '=', 'platform')
      .execute();
    await expect(enqueueServerOperation(f.db, f.context, f.serverId, f.input)).rejects.toThrow(
      'resources_unavailable',
    );
  });
});
