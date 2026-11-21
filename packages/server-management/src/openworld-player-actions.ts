import { createHash } from 'node:crypto';
import { type AuthContext, DomainError, type DomainErrorCode } from '@nickhosting/core';
import {
  dispatchOpenworldPlayerAction,
  prepareOpenworldPlayerAction,
  readOpenworldDestinations,
} from '../../../games/openworld/src/native-player-actions.js';
import type { OpenworldActionRequest } from '../../../games/openworld/src/player-actions.js';
import { createOpenworldPlayerChannel } from './openworld-player-channel.js';
import { type OpenworldNativeOptions, readOpenworldScope } from './openworld-telemetry.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createOpenworldPlayerActions(options: OpenworldNativeOptions) {
  const { db, fetcher = fetch, now = Date.now } = options;
  const channel = createOpenworldPlayerChannel(options);
  return {
    destinations(who: AuthContext, serverId: string) {
      return channel.read(who, serverId, 'moderate', (origin, token, signal) =>
        readOpenworldDestinations({ origin, token, signal, fetcher }),
      );
    },
    async perform(who: AuthContext, serverId: string, input: OpenworldActionRequest) {
      const grant = input.action.kind === 'screenshot' ? 'screenshots' : 'moderate';
      const reader = { who, resource: 'players' as const, playerGrant: grant } as const;
      await readOpenworldScope(db, serverId, reader);
      const key =
        'openworld-player-' +
        digest([serverId, who.actorUserId, who.subjectUserId, input.requestId]);
      const fingerprint = digest(input);
      const result = { requestId: input.requestId, outcome: 'accepted' as const };
      const prior = () =>
        db.selectFrom('audit_events').select('metadata').where('id', '=', key).executeTakeFirst();
      const replay = (m: Record<string, unknown>) => {
        if (m.fingerprint !== fingerprint) throw new DomainError('conflict');
        if (m.outcome === 'accepted') return result;
        if (m.outcome === 'failed' && typeof m.error === 'string')
          throw new DomainError(m.error as DomainErrorCode);
        throw new DomainError('operation_uncertain');
      };
      const existing = await prior();
      if (existing) return replay(existing.metadata);

      return channel.mutate(
        who,
        serverId,
        grant,
        input.processRef,
        async (origin, token, signal, recheck) => {
          const native = { origin, token, signal, fetcher };
          await recheck();
          // Keep the durable fence before dispatch. A process crash can leave an uncertain
          // result, but never a second invocation of a non-idempotent native command.
          const metadata = {
            serverId,
            operationId: input.requestId,
            source: 'panel',
            playerAction: input.action.kind,
            connectionId: input.player.id,
            fingerprint,
          };
          const claimed = await db
            .insertInto('audit_events')
            .values({
              id: key,
              actor_user_id: who.actorUserId,
              subject_user_id: who.subjectUserId,
              action: 'server.openworld.player.action',
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
          const finish = (outcome: string, error?: DomainErrorCode) =>
            db
              .updateTable('audit_events')
              .set({ metadata: { ...metadata, outcome, ...(error ? { error } : {}) } })
              .where('id', '=', key)
              .returning('id')
              .executeTakeFirstOrThrow();
          let dispatched = false;
          try {
            await prepareOpenworldPlayerAction(native, input.player, input.action, now);
            await recheck();
            if (signal.aborted) throw new DomainError('game_not_ready');
            dispatched = true;
            await dispatchOpenworldPlayerAction(native, input.player.id, input.action);
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
      );
    },
  };
}
