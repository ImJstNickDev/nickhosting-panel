import { type AuthContext, assertAuthContext, authSessionId, DomainError } from '@nickhosting/core';
import { type Database, getSettings } from '@nickhosting/database';
import type { Kysely } from 'kysely';
import type { Environment } from './admission.js';

/** Interactive effects retain the verified session binding, not its earlier
 * authority. Use the caller's pinned connection: waiting requests must not each
 * claim a second pool connection merely to authenticate after the server lock. */
export async function currentInteractiveContext(
  db: Kysely<Database>,
  previous: AuthContext,
  env: Environment,
): Promise<AuthContext> {
  const sessionId = previous[authSessionId];
  if (!sessionId) throw new DomainError('unauthenticated');
  const session = await db
    .selectFrom('session')
    .innerJoin('user', 'user.id', 'session.userId')
    .select(['session.expiresAt', 'user.role'])
    .where('session.id', '=', sessionId)
    .where('session.userId', '=', previous.actorUserId)
    .executeTakeFirst();
  if (!session || session.expiresAt <= new Date()) throw new DomainError('unauthenticated');
  let context: AuthContext = { ...previous, role: session.role };
  if (previous.sessionType === 'support') {
    if (!previous.support?.id) throw new DomainError('support_invalid');
    const support = await db
      .selectFrom('support_sessions')
      .selectAll()
      .where('id', '=', previous.support.id)
      .executeTakeFirst();
    if (
      !support ||
      support.parent_session_id !== sessionId ||
      support.actor_user_id !== previous.actorUserId ||
      support.subject_user_id !== previous.subjectUserId
    )
      throw new DomainError('support_invalid');
    const { values } = await getSettings(db, env);
    context = {
      ...context,
      support: {
        id: support.id,
        startedAt: support.started_at,
        expiresAt: support.expires_at,
        lastActivityAt: support.last_activity_at,
        revokedAt: support.revoked_at,
        reason: support.reason,
        idleTtlSeconds: values.supportIdleTtlSeconds,
        absoluteTtlSeconds: values.supportAbsoluteTtlSeconds,
      },
    };
  }
  assertAuthContext(context);
  return context;
}
