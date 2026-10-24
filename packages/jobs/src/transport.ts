import { type createLogger, DomainError } from '@nickhosting/core';
import { type Database, type JobNotificationPool, listenForJobOutbox } from '@nickhosting/database';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { type Kysely, sql } from 'kysely';
import { deliverySchema, type JobDelivery } from './contracts.js';
import { type JobHandlers, processJob } from './store.js';

export type JobQueue = Queue<JobDelivery>;
type Logger = ReturnType<typeof createLogger>;
const queueName = 'operations-v1';

export function validateTransportOptions(options: { redisUrl: string; prefix: string }): void {
  let url: URL;
  try {
    url = new URL(options.redisUrl);
  } catch {
    throw new DomainError('configuration_invalid');
  }
  if (
    !['redis:', 'rediss:'].includes(url.protocol) ||
    url.hash ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(options.prefix)
  )
    throw new DomainError('configuration_invalid');
}

export function createJobTransport(options: { redisUrl: string; prefix: string; logger: Logger }) {
  validateTransportOptions(options);
  const connection = new Redis(options.redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  connection.on('error', () => options.logger.log('error', 'jobs.redis_unavailable'));
  const queue = new Queue<JobDelivery>(queueName, {
    connection,
    prefix: options.prefix,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: { age: 3600, count: 1000 },
      attempts: 1,
    },
  });
  queue.on('error', () => options.logger.log('error', 'jobs.queue_unavailable'));
  return {
    queue,
    async close() {
      try {
        await queue.close();
      } finally {
        connection.disconnect();
      }
    },
  };
}

/**
 * Redis publications are deliberately repeated until PostgreSQL marks completion.
 * A crash between add and commit may duplicate a delivery; processJob is the barrier.
 * Holding only the outbox row avoids a job/outbox lock-order cycle with consumers.
 */
export async function dispatchOutbox(
  db: Kysely<Database>,
  queue: Pick<JobQueue, 'add'>,
  options: { limit?: number; recoveryIntervalMs?: number } = {},
): Promise<number> {
  const limit = options.limit ?? 50;
  const recoveryIntervalMs = options.recoveryIntervalMs ?? 30_000;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    !Number.isInteger(recoveryIntervalMs) ||
    recoveryIntervalMs < 100
  ) {
    throw new DomainError('validation_failed');
  }
  let count = 0;
  for (let index = 0; index < limit; index++) {
    const dispatched = await db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('job_outbox')
        .selectAll()
        .where('next_dispatch_at', '<=', sql<Date>`clock_timestamp()`)
        .orderBy('next_dispatch_at')
        .forUpdate()
        .skipLocked()
        .limit(1)
        .executeTakeFirst();
      if (!row) return 'empty';
      const job = await tx
        .selectFrom('operation_jobs')
        .select(['state', 'next_attempt_at'])
        .where('id', '=', row.job_id)
        .executeTakeFirstOrThrow();
      if (job.state === 'succeeded' || job.state === 'failed') {
        await tx.deleteFrom('job_outbox').where('job_id', '=', row.job_id).execute();
        return 'skipped';
      }
      const { now } = await tx
        .selectNoFrom(sql<Date>`clock_timestamp()`.as('now'))
        .executeTakeFirstOrThrow();
      if (job.next_attempt_at > now) {
        await tx
          .updateTable('job_outbox')
          .set({ next_dispatch_at: job.next_attempt_at })
          .where('job_id', '=', row.job_id)
          .execute();
        return 'skipped';
      }
      const generation = row.generation + 1;
      await queue.add('deliver', { jobId: row.job_id }, { jobId: `${row.job_id}-${generation}` });
      await tx
        .updateTable('job_outbox')
        .set({
          generation,
          last_dispatched_at: now,
          next_dispatch_at: new Date(now.getTime() + recoveryIntervalMs),
        })
        .where('job_id', '=', row.job_id)
        .execute();
      return 'published';
    });
    if (dispatched === 'empty') break;
    if (dispatched === 'published') count++;
  }
  return count;
}

/** A delivered but temporarily deferred job is not a lost delivery. Keep its
 * retry durable without waiting for the crash-recovery interval. The generation
 * fence prevents an old consumer from changing a newer publication's deadline. */
export async function rearmDeferredDelivery(
  db: Kysely<Database>,
  jobId: string,
  deliveryId: string,
  delayMs = 500,
): Promise<boolean> {
  if (!Number.isInteger(delayMs) || delayMs < 100 || delayMs > 60_000)
    throw new DomainError('validation_failed');
  return db.transaction().execute(async (tx) => {
    // Redis may deliver before dispatchOutbox commits the new generation. Lock
    // by job ID alone first so that a fast consumer waits for that publication.
    const publication = await tx
      .selectFrom('job_outbox')
      .select('generation')
      .where('job_id', '=', jobId)
      .forUpdate()
      .executeTakeFirst();
    if (!publication || deliveryId !== `${jobId}-${publication.generation}`) return false;
    // Do not lock the job: lifecycle consumers acquire job then outbox locks.
    const result = await sql<{ job_id: string }>`
      update job_outbox as outbox
      set next_dispatch_at = greatest(
        job.next_attempt_at,
        least(outbox.next_dispatch_at, clock_timestamp() + ${delayMs} * interval '1 millisecond')
      )
      from operation_jobs as job
      where outbox.job_id = ${jobId} and job.id = outbox.job_id
        and job.state in ('queued', 'running')
      returning outbox.job_id
    `.execute(tx);
    return result.rows.length === 1;
  });
}

/** No connections or timers exist until this explicitly called factory runs. */
export async function startJobWorker(options: {
  db: Kysely<Database>;
  /** Same database/schema as db; notification loss never disables durable polling. */
  notificationPool?: JobNotificationPool;
  redisUrl: string;
  prefix: string;
  logger: Logger;
  handlers?: JobHandlers;
  /** Routes approved external-effect commands to their durable state machine. */
  processor?: (jobId: string) => Promise<string>;
  concurrency?: number;
  pollIntervalMs?: number;
  recoveryIntervalMs?: number;
}) {
  validateTransportOptions(options);
  const concurrency = options.concurrency ?? 4;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const recoveryIntervalMs = options.recoveryIntervalMs ?? 30_000;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32 ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 50 ||
    pollIntervalMs > 60_000 ||
    !Number.isInteger(recoveryIntervalMs) ||
    recoveryIntervalMs < 100 ||
    recoveryIntervalMs > 3_600_000
  ) {
    throw new DomainError('configuration_invalid');
  }
  // Fail startup when migrations/DB connectivity are missing, before opening Redis clients.
  await options.db.selectFrom('operation_jobs').select('id').limit(1).execute();
  const transport = createJobTransport(options);
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', () => options.logger.log('error', 'jobs.redis_unavailable'));
  const worker = new Worker<JobDelivery>(
    queueName,
    async (delivery) => {
      const parsed = deliverySchema.safeParse(delivery.data);
      if (!parsed.success) throw new DomainError('validation_failed');
      const started = performance.now();
      try {
        options.logger.log('info', 'jobs.delivery_started', {
          jobId: parsed.data.jobId,
          publishedAt: new Date(delivery.timestamp).toISOString(),
          deliveryAgeMs: Math.max(0, Date.now() - delivery.timestamp),
        });
      } catch {
        /* Logging cannot change processing semantics. */
      }
      const result = options.processor
        ? await options.processor(parsed.data.jobId)
        : await processJob(options.db, parsed.data.jobId, options.handlers);
      const deferredRetryScheduled =
        result === 'deferred' && delivery.id !== undefined
          ? await rearmDeferredDelivery(options.db, parsed.data.jobId, delivery.id)
          : false;
      options.logger.log(result === 'failed' ? 'error' : 'info', 'jobs.delivery_processed', {
        jobId: parsed.data.jobId,
        result,
        durationMs: Math.round(performance.now() - started),
        ...(result === 'deferred' ? { deferredRetryScheduled } : {}),
      });
      return result;
    },
    { connection, prefix: options.prefix, concurrency },
  );
  worker.on('error', () => options.logger.log('error', 'jobs.worker_unavailable'));
  worker.on('failed', () => options.logger.log('error', 'jobs.delivery_failed'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> | undefined;
  let stopping = false;
  let wakePending = false;
  let notifications: Awaited<ReturnType<typeof listenForJobOutbox>> | undefined;
  let connectingNotifications: Promise<void> | undefined;
  const ensureNotifications = () => {
    if (!options.notificationPool || notifications || connectingNotifications || stopping) return;
    connectingNotifications = listenForJobOutbox(options.notificationPool, wake, () => {
      notifications = undefined;
      options.logger.log('warn', 'jobs.notifications_unavailable');
    })
      .then((listener) => {
        if (stopping) listener.close();
        else {
          notifications = listener;
          wake();
        }
      })
      .catch(() => {
        options.logger.log('warn', 'jobs.notifications_unavailable');
      })
      .finally(() => {
        connectingNotifications = undefined;
      });
  };
  const poll = async () => {
    // Optional hint transport must never suspend the authoritative outbox poll.
    ensureNotifications();
    if (stopping) return;
    try {
      await dispatchOutbox(options.db, transport.queue, { recoveryIntervalMs });
    } catch {
      options.logger.log('error', 'jobs.outbox_dispatch_failed');
    }
  };
  // One dispatcher at a time. A commit arriving during dispatch requests another
  // pass rather than being lost between the query and the fallback timer.
  function wake() {
    if (stopping) return;
    if (polling) {
      wakePending = true;
      return;
    }
    if (timer) clearTimeout(timer);
    wakePending = false;
    polling = poll().finally(() => {
      polling = undefined;
      if (stopping) return;
      if (wakePending) wake();
      else timer = setTimeout(wake, pollIntervalMs);
    });
  }
  try {
    await Promise.all([worker.waitUntilReady(), transport.queue.waitUntilReady()]);
    wake();
    await polling;
  } catch (error) {
    stopping = true;
    if (timer) clearTimeout(timer);
    notifications?.close();
    await connectingNotifications;
    await worker.close(true);
    connection.disconnect();
    await transport.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    queue: transport.queue,
    worker,
    close(): Promise<void> {
      closing ??= (async () => {
        stopping = true;
        if (timer) clearTimeout(timer);
        await polling;
        notifications?.close();
        await connectingNotifications;
        try {
          await worker.close();
        } finally {
          connection.disconnect();
          await transport.close();
        }
      })();
      return closing;
    },
  };
}
