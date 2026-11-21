import { createHash } from 'node:crypto';
import { type AuthContext, DomainError, type DomainErrorCode } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { Kysely } from 'kysely';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function openworldActionReceipt(
  db: Kysely<Database>,
  who: AuthContext,
  serverId: string,
  family: 'player' | 'checkpoint',
  input: { requestId: string },
  attributes: Record<string, string | number>,
) {
  const key =
    `openworld-${family}-` +
    digest([serverId, who.actorUserId, who.subjectUserId, input.requestId]);
  const fingerprint = digest(input);
  const result = { requestId: input.requestId, outcome: 'accepted' as const };
  const metadata = {
    serverId,
    operationId: input.requestId,
    source: 'panel',
    ...attributes,
    fingerprint,
  };
  const prior = () =>
    db.selectFrom('audit_events').select('metadata').where('id', '=', key).executeTakeFirst();
  function replay(row: Record<string, unknown>) {
    if (row.fingerprint !== fingerprint) throw new DomainError('conflict');
    if (row.outcome === 'accepted') return result;
    if (row.outcome === 'failed' && typeof row.error === 'string')
      throw new DomainError(row.error as DomainErrorCode);
    throw new DomainError('operation_uncertain');
  }
  const finish = (outcome: string, error?: DomainErrorCode) =>
    db
      .updateTable('audit_events')
      .set({ metadata: { ...metadata, outcome, ...(error ? { error } : {}) } })
      .where('id', '=', key)
      .returning('id')
      .executeTakeFirstOrThrow();

  return {
    async existing() {
      const row = await prior();
      return row ? replay(row.metadata) : null;
    },
    async run(perform: (markDispatched: () => void) => Promise<void>) {
      // The fence is committed before dispatch and survives a process crash.
      const claimed = await db
        .insertInto('audit_events')
        .values({
          id: key,
          actor_user_id: who.actorUserId,
          subject_user_id: who.subjectUserId,
          action: `server.openworld.${family}.action`,
          correlation_id: who.support?.id ?? input.requestId,
          metadata: { ...metadata, outcome: 'requested' },
        })
        .onConflict((c) => c.column('id').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!claimed) {
        const other = await prior();
        if (!other) throw new DomainError('operation_uncertain');
        return replay(other.metadata);
      }
      let dispatched = false;
      try {
        await perform(() => {
          dispatched = true;
        });
      } catch (error) {
        const code =
          error instanceof DomainError
            ? error.code
            : dispatched
              ? 'operation_uncertain'
              : 'integration_unavailable';
        try {
          await finish(code === 'operation_uncertain' ? 'uncertain' : 'failed', code);
        } catch {
          if (dispatched) throw new DomainError('operation_uncertain');
        }
        throw error instanceof DomainError ? error : new DomainError(code);
      }
      try {
        await finish('accepted');
      } catch {
        throw new DomainError('operation_uncertain');
      }
      return result;
    },
  };
}
