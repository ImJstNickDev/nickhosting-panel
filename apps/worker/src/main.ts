import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, DomainError, encryptionKeyFromBase64, SecretCodec } from '@nickhosting/core';
import { createDatabase } from '@nickhosting/database';
import { processJob, startJobWorker } from '@nickhosting/jobs';
import {
  createManagementRuntime,
  createManagementTransportCoordinator,
  ensureProviderAccounts,
  recordWorkerHeartbeat,
  refreshHostObservations,
} from '@nickhosting/server-management';
import { startHostObservationLoop } from './host-observations.js';
import { pollMinecraftMetadata } from './minecraft-metadata.js';
import { refreshProviderFeeds, startProviderFeedLoop } from './provider-feed.js';
import { reconcileServers } from './reconcile.js';
import { pollSchedules } from './schedules.js';

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const logger = createLogger((record) => {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  });
  if (!env.DATABASE_URL || !env.REDIS_URL || !env.NH_JOB_PREFIX)
    throw new DomainError('configuration_invalid');
  const { db, pool } = createDatabase(env.DATABASE_URL);
  const transportCoordinator = createManagementTransportCoordinator();
  try {
    const management = async () => {
      if (!env.NH_SECRETS_MASTER_KEY) throw new DomainError('configuration_invalid');
      const keyId = env.NH_SECRETS_KEY_ID ?? 'primary';
      return createManagementRuntime({
        db,
        env,
        logger,
        transportCoordinator,
        codec: new SecretCodec({
          activeKeyId: keyId,
          keys: { [keyId]: encryptionKeyFromBase64(env.NH_SECRETS_MASTER_KEY) },
        }),
      });
    };
    const runtime = await startJobWorker({
      db,
      notificationPool: pool,
      redisUrl: env.REDIS_URL,
      prefix: env.NH_JOB_PREFIX,
      logger,
      processor: async (jobId) => {
        const row = await db
          .selectFrom('server_operations')
          .select('job_id')
          .where('job_id', '=', jobId)
          .executeTakeFirst();
        return row ? (await management()).process(jobId) : processJob(db, jobId);
      },
    });
    const observations = startHostObservationLoop(
      async () => {
        await refreshHostObservations(db, env, { force: true });
      },
      () => logger.log('warn', 'host.observation_unavailable'),
    );
    const providerAccounts = startProviderFeedLoop(
      async () => {
        if (!env.NH_SECRETS_MASTER_KEY) return;
        const keyId = env.NH_SECRETS_KEY_ID ?? 'primary';
        const codec = new SecretCodec({
          activeKeyId: keyId,
          keys: { [keyId]: encryptionKeyFromBase64(env.NH_SECRETS_MASTER_KEY) },
        });
        await ensureProviderAccounts(db, codec, env, { coordinator: transportCoordinator });
      },
      () => logger.log('warn', 'provider.enrollment_unavailable'),
    );
    const providerFeeds = startProviderFeedLoop(
      async () => {
        if (!env.NH_SECRETS_MASTER_KEY) return;
        const keyId = env.NH_SECRETS_KEY_ID ?? 'primary';
        const codec = new SecretCodec({
          activeKeyId: keyId,
          keys: { [keyId]: encryptionKeyFromBase64(env.NH_SECRETS_MASTER_KEY) },
        });
        await refreshProviderFeeds(db, codec, env, transportCoordinator);
      },
      () => logger.log('warn', 'provider.feed_unavailable'),
    );
    let stopping = false;
    const workerInstanceId = randomUUID();
    const heartbeat = async (state: 'running' | 'degraded' | 'stopped') => {
      try {
        await recordWorkerHeartbeat(db, workerInstanceId, env.NH_JOB_PREFIX ?? '', state);
      } catch {
        logger.log('warn', 'worker.heartbeat_unavailable');
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reconciliation: Promise<void> | undefined;
    const poll = async () => {
      let successful = false;
      try {
        const schedules = await pollSchedules(db, env, logger);
        await reconcileServers(db, management, logger, env);
        successful =
          schedules !== null &&
          runtime.worker.isRunning() &&
          (await runtime.queue.getBackend().client).status === 'ready';
      } catch {
        logger.log('warn', 'servers.reconciliation_failed');
      } finally {
        await heartbeat(successful ? 'running' : 'degraded');
        if (!stopping)
          timer = setTimeout(() => {
            reconciliation = poll();
          }, 5000);
      }
    };
    let metadataTimer: ReturnType<typeof setTimeout> | undefined;
    let metadataPoll: Promise<void> | undefined;
    const refreshMetadata = async () => {
      await pollMinecraftMetadata(db, env, logger);
      if (!stopping)
        metadataTimer = setTimeout(() => {
          metadataPoll = refreshMetadata();
        }, 30_000);
    };
    metadataPoll = refreshMetadata();
    reconciliation = poll();
    logger.log('info', 'worker.started');
    let closed: Promise<void> | undefined;
    const close = () => {
      closed ??= (async () => {
        stopping = true;
        if (timer) clearTimeout(timer);
        if (metadataTimer) clearTimeout(metadataTimer);
        await Promise.all([
          reconciliation,
          metadataPoll,
          observations.close(),
          providerFeeds.close(),
          providerAccounts.close(),
        ]);
        try {
          await runtime.close();
        } finally {
          await heartbeat('stopped');
          await db.destroy();
        }
        logger.log('info', 'worker.stopped');
      })();
      return closed;
    };
    const stop = () => {
      void close().catch(() => {
        logger.log('error', 'worker.shutdown_failed');
        process.exitCode = 1;
      });
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return {
      async close() {
        process.removeListener('SIGTERM', stop);
        process.removeListener('SIGINT', stop);
        await close();
      },
    };
  } catch (error) {
    await db.destroy();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'worker.start_failed' })}\n`);
    process.exitCode = 1;
  });
}
