import { type createLogger, DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
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
      if (!row) return false;
      const job = await tx
        .selectFrom('operation_jobs')
        .select(['state', 'next_attempt_at'])
        .where('id', '=', row.job_id)
        .executeTakeFirstOrThrow();
      if (job.state === 'succeeded' || job.state === 'failed') {
        await tx.deleteFrom('job_outbox').where('job_id', '=', row.job_id).execute();
        return false;
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
        return false;
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
      return true;
    });
    if (!dispatched) break;
    count++;
  }
  return count;
}

/** No connections or timers exist until this explicitly called factory runs. */
export async function startJobWorker(options: {
  db: Kysely<Database>;
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
      const result = options.processor
        ? await options.processor(parsed.data.jobId)
        : await processJob(options.db, parsed.data.jobId, options.handlers);
      options.logger.log(result === 'failed' ? 'error' : 'info', 'jobs.delivery_processed', {
        jobId: parsed.data.jobId,
        result,
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
  const poll = async () => {
    try {
      await dispatchOutbox(options.db, transport.queue, {
        recoveryIntervalMs,
      });
    } catch {
      options.logger.log('error', 'jobs.outbox_dispatch_failed');
    } finally {
      if (!stopping)
        timer = setTimeout(() => {
          polling = poll();
        }, pollIntervalMs);
    }
  };
  try {
    await Promise.all([worker.waitUntilReady(), transport.queue.waitUntilReady()]);
    polling = poll();
  } catch (error) {
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
