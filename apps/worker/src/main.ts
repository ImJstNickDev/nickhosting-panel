import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, DomainError } from '@nickhosting/core';
import { createDatabase } from '@nickhosting/database';
import { startJobWorker } from '@nickhosting/jobs';

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const logger = createLogger((record) => {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  });
  if (!env.DATABASE_URL || !env.REDIS_URL || !env.NH_JOB_PREFIX)
    throw new DomainError('configuration_invalid');
  const { db } = createDatabase(env.DATABASE_URL);
  try {
    const runtime = await startJobWorker({
      db,
      redisUrl: env.REDIS_URL,
      prefix: env.NH_JOB_PREFIX,
      logger,
    });
    logger.log('info', 'worker.started');
    let closed: Promise<void> | undefined;
    const close = () => {
      closed ??= (async () => {
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
