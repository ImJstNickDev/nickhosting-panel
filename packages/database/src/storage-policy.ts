import { DomainError } from '@nickhosting/core';
import type { Kysely } from 'kysely';
import type { Database } from './index.js';

/** Call under the shared resources lock before granting mutations/reservations.
 * A blocked transition may already have applied provider limits: never bypass it. */
export async function assertStoragePolicyIdle(db: Kysely<Database>, exceptTransitionId?: string) {
  let query = db
    .selectFrom('storage_policy_transitions')
    .select('id')
    .where('status', 'in', ['applying', 'blocked']);
  if (exceptTransitionId) query = query.where('id', '!=', exceptTransitionId);
  if (await query.executeTakeFirst())
    throw new DomainError('conflict', 409, { reason: 'storage_policy_transition' });
}
