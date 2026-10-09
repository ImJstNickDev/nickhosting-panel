import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type AuthContext, createLogger, DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { commandDigest } from './contracts.js';
import { enqueueCommand, foundationHandlers, getJobStatus, processJob } from './store.js';
import { createJobTransport, dispatchOutbox, startJobWorker } from './transport.js';

const command = {
  type: 'foundation.record-activity',
  version: 1,
  payload: { source: 'user_request' },
} as const;
const owner: AuthContext = {
  actorUserId: 'owner',
  subjectUserId: 'owner',
  role: 'owner',
  sessionType: 'regular',
  ownerElevation: false,
};
const member: AuthContext = {
  actorUserId: 'member',
  subjectUserId: 'member',
  role: 'user',
  sessionType: 'regular',
  ownerElevation: false,
};
const other: AuthContext = {
  actorUserId: 'other',
  subjectUserId: 'other',
  role: 'user',
  sessionType: 'regular',
  ownerElevation: false,
};
const logger = createLogger(() => {});
let fixture: Awaited<ReturnType<typeof createTestDatabase>>;

function submit(idempotencyKey: string = randomUUID()) {
  return enqueueCommand(fixture.db, {
    context: member,
    resourceOwnerId: member.subjectUserId,
    idempotencyKey,
    command,
  });
}

function redisOptions() {
  const redisUrl = process.env.NH_TEST_REDIS_URL;
  if (!redisUrl) throw new Error('NH_TEST_REDIS_URL is required for isolated integration tests');
  const url = new URL(redisUrl);
  if (
    !['127.0.0.1', 'localhost', '[::1]', process.env.NH_TEST_VERIFIED_REDIS_HOST].includes(
      url.hostname,
    )
  )
    throw new Error('Only isolated approved Redis is permitted');
  return { redisUrl, prefix: `nh_test_${randomUUID().replaceAll('-', '')}`, logger };
}

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Isolated job did not reach its expected state');
    await delay(30);
  }
}

beforeAll(async () => {
  fixture = await createTestDatabase();
  for (const context of [owner, member, other]) {
    await sql`insert into "user" (id, name, email, role) values (${context.actorUserId}, ${context.actorUserId}, ${`${context.actorUserId}@example.com`}, ${context.role})`.execute(
      fixture.db,
    );
  }
});
beforeEach(async () => {
  await fixture.db.deleteFrom('operation_jobs').execute();
});
afterAll(async () => {
  await fixture?.destroy();
});

describe('PostgreSQL authoritative jobs', () => {
  it('atomically enqueues one command and outbox across concurrent requests', async () => {
    const jobs = await Promise.all(Array.from({ length: 12 }, () => submit('same-command')));
    expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
    expect(await fixture.db.selectFrom('operation_jobs').selectAll().execute()).toHaveLength(1);
    expect(await fixture.db.selectFrom('job_outbox').selectAll().execute()).toHaveLength(1);
    await expect(
      enqueueCommand(fixture.db, {
        context: member,
        resourceOwnerId: 'member',
        idempotencyKey: 'same-command',
        command: { ...command, payload: { source: 'system_check' } },
      }),
    ).rejects.toThrow('conflict');
    await expect(
      enqueueCommand(fixture.db, {
        context: member,
        resourceOwnerId: 'member',
        idempotencyKey: 'same-command',
        command,
        maxAttempts: 5,
      }),
    ).rejects.toThrow('conflict');
  });

  it('keeps actor, subject, resource owner distinct and authorizes status access', async () => {
    const now = new Date();
    const support: AuthContext = {
      actorUserId: 'owner',
      subjectUserId: 'member',
      role: 'owner',
      sessionType: 'support',
      ownerElevation: true,
      support: {
        id: 'support-session',
        reason: 'requested-support',
        startedAt: now,
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + 600_000),
        revokedAt: null,
      },
    };
    const job = await enqueueCommand(fixture.db, {
      context: support,
      resourceOwnerId: 'member',
      command,
      idempotencyKey: 'support-command',
    });
    expect(job).toMatchObject({ actorId: 'owner', subjectId: 'member', resourceOwnerId: 'member' });
    expect((await getJobStatus(fixture.db, job.id, member)).id).toBe(job.id);
    expect((await getJobStatus(fixture.db, job.id, owner)).id).toBe(job.id);
    await expect(getJobStatus(fixture.db, job.id, other)).rejects.toThrow('forbidden');
    await expect(
      getJobStatus(fixture.db, job.id, { ...member, ownerElevation: true }),
    ).rejects.toThrow('support_invalid');
    await expect(
      enqueueCommand(fixture.db, {
        context: other,
        resourceOwnerId: 'member',
        command,
        idempotencyKey: 'forbidden',
      }),
    ).rejects.toThrow('forbidden');
    await processJob(fixture.db, job.id);
    expect(
      await fixture.db
        .selectFrom('activity_events')
        .select(['actor_id', 'subject_id', 'resource_owner_id'])
        .executeTakeFirstOrThrow(),
    ).toEqual({ actor_id: 'owner', subject_id: 'member', resource_owner_id: 'member' });
  });

  it('serializes duplicate deliveries and atomically records one activity and step', async () => {
    const job = await submit();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => processJob(fixture.db, job.id)),
    );
    expect(results.filter((result) => result === 'succeeded')).toHaveLength(1);
    expect(results.filter((result) => result === 'duplicate')).toHaveLength(9);
    expect(await fixture.db.selectFrom('activity_events').selectAll().execute()).toHaveLength(1);
    expect(await fixture.db.selectFrom('job_steps').selectAll().execute()).toHaveLength(1);
    expect(await fixture.db.selectFrom('job_outbox').selectAll().execute()).toHaveLength(0);
    expect(await getJobStatus(fixture.db, job.id, member)).toMatchObject({
      state: 'succeeded',
      attempts: 1,
    });
  });

  it('uses verified support lifetime policy for both enqueue and status access', async () => {
    const now = new Date();
    const support: AuthContext = {
      actorUserId: 'owner',
      subjectUserId: 'member',
      role: 'owner',
      sessionType: 'support',
      ownerElevation: true,
      support: {
        id: 'longer-support-session',
        reason: 'requested-support',
        startedAt: new Date(now.getTime() - 1_000_000),
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + 800_000),
        revokedAt: null,
        absoluteTtlSeconds: 1800,
        idleTtlSeconds: 300,
      },
    };
    const job = await enqueueCommand(fixture.db, {
      context: support,
      resourceOwnerId: 'member',
      command,
      idempotencyKey: 'configured-support-policy',
    });
    expect((await getJobStatus(fixture.db, job.id, support)).id).toBe(job.id);
    expect(job).toMatchObject({ actorId: 'owner', subjectId: 'member', resourceOwnerId: 'member' });
  });

  it('rolls back partial handler effects and schedules a durable retry', async () => {
    const job = await submit();
    const result = await processJob(fixture.db, job.id, {
      'foundation.record-activity': async (context) => {
        await foundationHandlers['foundation.record-activity'](context);
        throw new Error('credential=must-not-be-persisted');
      },
    });
    expect(result).toBe('retry');
    expect(await fixture.db.selectFrom('activity_events').selectAll().execute()).toHaveLength(0);
    expect(await fixture.db.selectFrom('job_steps').selectAll().execute()).toHaveLength(0);
    expect(await getJobStatus(fixture.db, job.id, member)).toMatchObject({
      state: 'queued',
      attempts: 1,
      error: { code: 'internal_error' },
    });
    expect(await processJob(fixture.db, job.id)).toBe('deferred');
    const row = await fixture.db
      .selectFrom('operation_jobs')
      .selectAll()
      .where('id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain('must-not-be-persisted');
    await fixture.db
      .updateTable('operation_jobs')
      .set({ next_attempt_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', job.id)
      .execute();
    expect(await processJob(fixture.db, job.id)).toBe('succeeded');
    expect(await getJobStatus(fixture.db, job.id, member)).toMatchObject({
      state: 'succeeded',
      attempts: 2,
      error: null,
    });
  });

  it('persists terminal failure after exhausted retries and rejects unknown stored commands', async () => {
    const job = await enqueueCommand(fixture.db, {
      context: member,
      resourceOwnerId: 'member',
      command,
      idempotencyKey: 'exhausted',
      maxAttempts: 1,
    });
    expect(
      await processJob(fixture.db, job.id, {
        'foundation.record-activity': async () => {
          throw new DomainError('integration_unavailable');
        },
      }),
    ).toBe('failed');
    expect(await processJob(fixture.db, job.id)).toBe('duplicate');
    expect(await getJobStatus(fixture.db, job.id, member)).toMatchObject({
      error: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
      completedAt: expect.any(Date),
    });
    expect(await fixture.db.selectFrom('job_outbox').selectAll().execute()).toHaveLength(0);
    const corrupt = await submit();
    await fixture.db
      .updateTable('operation_jobs')
      .set({ command: JSON.stringify({ ...command, version: 9 }) })
      .where('id', '=', corrupt.id)
      .execute();
    expect(await processJob(fixture.db, corrupt.id)).toBe('failed');
    expect(await getJobStatus(fixture.db, corrupt.id, member)).toMatchObject({
      attempts: 1,
      error: { code: 'validation_failed' },
    });
  });

  it('leaves the outbox retryable when Redis publication fails', async () => {
    const job = await submit();
    await expect(
      dispatchOutbox(fixture.db, {
        add: async () => {
          throw new Error('isolated transport unavailable');
        },
      }),
    ).rejects.toThrow('isolated transport unavailable');
    expect(
      await fixture.db.selectFrom('job_outbox').selectAll().executeTakeFirstOrThrow(),
    ).toMatchObject({ job_id: job.id, generation: 0, last_dispatched_at: null });
    expect((await getJobStatus(fixture.db, job.id, member)).state).toBe('queued');
  });

  it('stores the digest of the exact validated command and identities', async () => {
    const job = await submit();
    const row = await fixture.db
      .selectFrom('operation_jobs')
      .selectAll()
      .where('id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(row.command_hash).toBe(
      commandDigest({ command, subjectId: 'member', resourceOwnerId: 'member' }),
    );
    expect(row.policy_snapshot).toEqual({
      role: 'user',
      sessionType: 'regular',
      ownerElevation: false,
    });
  });
});

describe('isolated Redis/BullMQ delivery', () => {
  it('dispatches concurrently without double-publishing a due generation', async () => {
    const options = redisOptions();
    const transport = createJobTransport(options);
    await Promise.all(Array.from({ length: 10 }, () => submit()));
    try {
      await transport.queue.waitUntilReady();
      const counts = await Promise.all(
        Array.from({ length: 4 }, () => dispatchOutbox(fixture.db, transport.queue)),
      );
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(10);
      expect(await transport.queue.getWaitingCount()).toBe(10);
      expect(
        (await fixture.db.selectFrom('job_outbox').selectAll().execute()).every(
          (row) => row.generation === 1,
        ),
      ).toBe(true);
    } finally {
      await transport.queue.obliterate({ force: true });
      await transport.close();
    }
  });

  it('survives lost publication acknowledgment between Redis add and PostgreSQL commit', async () => {
    const options = redisOptions();
    const transport = createJobTransport(options);
    const job = await submit();
    try {
      await transport.queue.waitUntilReady();
      await expect(
        dispatchOutbox(fixture.db, {
          add: async (...args) => {
            await transport.queue.add(...args);
            throw new Error('isolated lost publication acknowledgment');
          },
        }),
      ).rejects.toThrow('isolated lost publication acknowledgment');
      expect(
        (await fixture.db.selectFrom('job_outbox').selectAll().executeTakeFirstOrThrow())
          .generation,
      ).toBe(0);
      expect(await transport.queue.getWaitingCount()).toBe(1);
      expect(await dispatchOutbox(fixture.db, transport.queue)).toBe(1);
      expect(await transport.queue.getWaitingCount()).toBe(1);
      expect(await processJob(fixture.db, job.id)).toBe('succeeded');
      expect(await processJob(fixture.db, job.id)).toBe('duplicate');
    } finally {
      await transport.queue.obliterate({ force: true });
      await transport.close();
    }
  });

  it('performs a real round-trip and safely handles redelivery', async () => {
    const options = redisOptions();
    const job = await submit();
    const runtime = await startJobWorker({
      db: fixture.db,
      ...options,
      pollIntervalMs: 50,
      recoveryIntervalMs: 100,
    });
    try {
      await eventually(
        async () => (await getJobStatus(fixture.db, job.id, member)).state === 'succeeded',
      );
      await runtime.queue.add('duplicate', { jobId: job.id });
      await eventually(
        async () =>
          (await runtime.queue.getActiveCount()) === 0 &&
          (await runtime.queue.getWaitingCount()) === 0,
      );
      expect(await fixture.db.selectFrom('activity_events').selectAll().execute()).toHaveLength(1);
      expect((await getJobStatus(fixture.db, job.id, member)).attempts).toBe(1);
    } finally {
      await runtime.close();
      const cleanup = createJobTransport(options);
      try {
        await cleanup.queue.waitUntilReady();
        await cleanup.queue.obliterate({ force: true });
      } finally {
        await cleanup.close();
      }
    }
  });

  it('recovers an already-published job after only its test queue loses Redis state', async () => {
    const options = redisOptions();
    const job = await submit();
    const transport = createJobTransport(options);
    let runtime: Awaited<ReturnType<typeof startJobWorker>> | undefined;
    try {
      await transport.queue.waitUntilReady();
      expect(await dispatchOutbox(fixture.db, transport.queue, { recoveryIntervalMs: 100 })).toBe(
        1,
      );
      expect(await transport.queue.getWaitingCount()).toBe(1);
      // Scope is the freshly generated queue prefix in the isolated Redis, never FLUSH*.
      await transport.queue.obliterate({ force: true });
      expect((await getJobStatus(fixture.db, job.id, member)).state).toBe('queued');
      runtime = await startJobWorker({
        db: fixture.db,
        ...options,
        pollIntervalMs: 50,
        recoveryIntervalMs: 100,
      });
      await eventually(
        async () => (await getJobStatus(fixture.db, job.id, member)).state === 'succeeded',
      );
      expect(await fixture.db.selectFrom('activity_events').selectAll().execute()).toHaveLength(1);
    } finally {
      await runtime?.close();
      await transport.queue.obliterate({ force: true });
      await transport.close();
    }
  });

  it('retries the persisted failed attempt through Redis without duplicate effects', async () => {
    const options = redisOptions();
    const job = await submit();
    let calls = 0;
    const runtime = await startJobWorker({
      db: fixture.db,
      ...options,
      pollIntervalMs: 50,
      recoveryIntervalMs: 100,
      handlers: {
        'foundation.record-activity': async (context) => {
          calls++;
          await foundationHandlers['foundation.record-activity'](context);
          if (calls === 1) throw new Error('isolated retry fixture');
        },
      },
    });
    try {
      await eventually(
        async () => (await getJobStatus(fixture.db, job.id, member)).state === 'succeeded',
      );
      expect(calls).toBe(2);
      expect((await getJobStatus(fixture.db, job.id, member)).attempts).toBe(2);
      expect(await fixture.db.selectFrom('activity_events').selectAll().execute()).toHaveLength(1);
    } finally {
      await runtime.close();
      const cleanup = createJobTransport(options);
      try {
        await cleanup.queue.waitUntilReady();
        await cleanup.queue.obliterate({ force: true });
      } finally {
        await cleanup.close();
      }
    }
  });
});
