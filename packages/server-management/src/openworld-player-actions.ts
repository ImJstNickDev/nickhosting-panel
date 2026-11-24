import { type AuthContext, DomainError } from '@nickhosting/core';
import {
  dispatchOpenworldPlayerAction,
  prepareOpenworldPlayerAction,
  readOpenworldDestinations,
} from '../../../games/openworld/src/native-player-actions.js';
import type { OpenworldActionRequest } from '../../../games/openworld/src/player-actions.js';
import { openworldActionReceipt } from './openworld-action-receipts.js';
import { createOpenworldPlayerChannel } from './openworld-player-channel.js';
import { type OpenworldNativeOptions, readOpenworldScope } from './openworld-telemetry.js';

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
      const receipt = openworldActionReceipt(db, who, serverId, 'player', input, {
        playerAction: input.action.kind,
        connectionId: input.player.id,
      });
      const existing = await receipt.existing();
      if (existing) return existing;

      return channel.mutate(
        who,
        serverId,
        grant,
        input.processRef,
        async (origin, token, signal, recheck) => {
          const native = { origin, token, signal, fetcher };
          await recheck();
          return receipt.run(async (markDispatched) => {
            await prepareOpenworldPlayerAction(native, input.player, input.action, now);
            await recheck();
            if (signal.aborted) throw new DomainError('game_not_ready');
            markDispatched();
            await dispatchOpenworldPlayerAction(native, input.player.id, input.action);
          });
        },
      );
    },
  };
}
