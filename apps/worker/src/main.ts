import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, DomainError, encryptionKeyFromBase64, SecretCodec } from '@nickhosting/core';
import { createDatabase } from '@nickhosting/database';
import { processJob, startJobWorker } from '@nickhosting/jobs';
import { createManagementRuntime } from '@nickhosting/server-management';
import { reconcileServers } from './reconcile.js';

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const logger = createLogger((record) => {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  });
  if (!env.DATABASE_URL || !env.REDIS_URL || !env.NH_JOB_PREFIX)
    throw new DomainError('configuration_invalid');
  const { db } = createDatabase(env.DATABASE_URL);
  try {
    const management = async () => {
      if (!env.NH_SECRETS_MASTER_KEY) throw new DomainError('configuration_invalid');
      const keyId = env.NH_SECRETS_KEY_ID ?? 'primary';
      return createManagementRuntime({
        db,
        env,
        codec: new SecretCodec({
          activeKeyId: keyId,
          keys: { [keyId]: encryptionKeyFromBase64(env.NH_SECRETS_MASTER_KEY) },
        }),
      });
    };
    const runtime = await startJobWorker({
      db,
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
    let stopping = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reconciliation: Promise<void> | undefined;
    const poll = async () => {
      try {
        await reconcileServers(db, management, logger, env);
      } catch {
        logger.log('warn', 'servers.reconciliation_failed');
      } finally {
        if (!stopping)
          timer = setTimeout(() => {
            reconciliation = poll();
          }, 5000);
      }
    };
    reconciliation = poll();
    logger.log('info', 'worker.started');
    let closed: Promise<void> | undefined;
    const close = () => {
      closed ??= (async () => {
        stopping = true;
        if (timer) clearTimeout(timer);
        await reconciliation;
        try {
          await runtime.close();
        } finally {
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
