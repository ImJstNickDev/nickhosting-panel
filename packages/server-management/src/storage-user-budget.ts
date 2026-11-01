import type { DB } from './admission.js';

/** Zero is an explicit unlimited exception; null follows the current default. */
export async function getUserStorageBudget(db: DB, userId: string, defaultMiB: number) {
  const persistent = await db
    .selectFrom('storage_user_budgets')
    .select('storage_mib')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (persistent) return Number(persistent.storage_mib ?? defaultMiB);
  const legacy = await db
    .selectFrom('resource_user_limits')
    .select(['storage_mib', 'expires_at'])
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return legacy && (!legacy.expires_at || legacy.expires_at > new Date())
    ? Number(legacy.storage_mib)
    : defaultMiB;
}
