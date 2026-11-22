import { type AuthContext, DomainError } from '@nickhosting/core';
import { sql } from 'kysely';
import type { OpenworldRuleAction } from '../../../games/openworld/src/rules.js';
import {
  performOpenworldRule,
  readOpenworldRules,
} from '../../../games/openworld/src/rules-native.js';
import { openworldActionReceipt } from './openworld-action-receipts.js';
import {
  assertCurrentOpenworldScope,
  createOpenworldNativeConnection,
  type OpenworldNativeOptions,
  openworldProcessRef,
  readOpenworldScope,
  sharedReads,
} from './openworld-telemetry.js';

type Request = { processRef: string; requestId: string; action: OpenworldRuleAction };

type RulesOptions = OpenworldNativeOptions & {
  readFiles?: (
    who: AuthContext,
    serverId: string,
    signal: AbortSignal,
  ) => Promise<{ roles?: Uint8Array; zones?: Uint8Array }>;
};

export function createOpenworldRules(options: RulesOptions) {
  const { db, fetcher = fetch, now = Date.now, readFiles } = options;
  const connect = options.native ?? createOpenworldNativeConnection(options);
  const reads = sharedReads<Awaited<ReturnType<typeof readOpenworldRules>>>(64, now, 1000);
  return {
    async list(who: AuthContext, serverId: string) {
      const reader = { who, resource: 'rules' as const };
      const scope = await readOpenworldScope(db, serverId, reader);
      if (scope.reason) throw new DomainError('game_not_ready');
      // Another panel process or a game administrator can edit these rules between reads.
      const result = await reads.get(scope.liveKey, 0, () =>
        connect(scope, (origin, token, signal) => {
          let saved: ReturnType<NonNullable<RulesOptions['readFiles']>> | undefined;
          const documents = (key: 'roles' | 'zones') =>
            readFiles &&
            (async () => {
              saved ??= readFiles(who, serverId, signal);
              return (await saved)[key];
            });
          return readOpenworldRules(
            { origin, token, signal, fetcher },
            scope.version,
            documents('roles'),
            documents('zones'),
          );
        }),
      );
      assertCurrentOpenworldScope(scope, await readOpenworldScope(db, serverId, reader));
      return { ...result, processRef: openworldProcessRef(scope) };
    },
    async change(who: AuthContext, serverId: string, input: Request) {
      const ruleGrant = input.action.kind === 'difficulty' ? 'rules.manage' : 'bans.manage';
      const reader = { who, resource: 'rules', ruleGrant } as const;
      const scope = await readOpenworldScope(db, serverId, reader);
      const receipt = openworldActionReceipt(db, who, serverId, 'rule', input, {
        ruleAction: input.action.kind,
      });
      const prior = await receipt.existing();
      if (prior) return prior;
      if (scope.reason) throw new DomainError('game_not_ready');
      if (openworldProcessRef(scope) !== input.processRef) throw new DomainError('conflict');
      return connect(
        scope,
        (origin, token, signal) =>
          receipt.run((markDispatched) =>
            db.transaction().execute(async (tx) => {
              // Do not allow competing NickPanel instances to verify different changes against the same state.
              const lock = await sql<{
                acquired: boolean;
              }>`select pg_try_advisory_xact_lock(hashtextextended(current_schema() || ${`:openworld:rules:${serverId}`},0)) as acquired`.execute(
                tx,
              );
              if (!lock.rows[0]?.acquired) throw new DomainError('conflict');
              await performOpenworldRule(
                { origin, token, signal, fetcher },
                scope.version,
                input.action,
                async () => {
                  assertCurrentOpenworldScope(
                    scope,
                    await readOpenworldScope(tx, serverId, reader),
                  );
                  if (signal.aborted) throw new DomainError('game_not_ready');
                  markDispatched();
                },
              );
            }),
          ),
        false,
      );
    },
  };
}
