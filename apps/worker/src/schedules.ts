import type { createLogger } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import { runDueSchedules } from '@nickhosting/server-management';

/** Independent scheduler loop; does not wait for provider reconciliation. Database/outbox is authoritative;
 * provider effects remain exclusively in the existing lifecycle processor. */
export async function pollSchedules(
  db: ReturnType<typeof createDatabase>['db'],
  env: Readonly<Record<string, string | undefined>>,
  logger: ReturnType<typeof createLogger>,
) {
  try {
    const result = await runDueSchedules(db, env, {
      onError: (scheduleId) => logger.log('warn', 'schedules.candidate_failed', { scheduleId }),
    });
    if (result.dispatched || result.skipped || result.failures)
      logger.log('info', 'schedules.polled', result);
    return result;
  } catch {
    logger.log('warn', 'schedules.poll_failed');
    return null;
  }
}
