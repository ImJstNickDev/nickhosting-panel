import { type AuthContext, DomainError } from '@nickhosting/core';
import {
  assertCurrentOpenworldScope,
  createOpenworldNativeConnection,
  type OpenworldNativeOptions,
  type OpenworldPlayerGrant,
  openworldProcessRef,
  readOpenworldScope,
} from './openworld-telemetry.js';

export function createOpenworldPlayerChannel(options: OpenworldNativeOptions) {
  const native = createOpenworldNativeConnection(options);
  async function access(who: AuthContext, serverId: string, grant: OpenworldPlayerGrant) {
    const reader = { who, resource: 'players' as const, playerGrant: grant };
    const scope = await readOpenworldScope(options.db, serverId, reader);
    if (scope.reason) throw new DomainError('game_not_ready');
    const recheck = async () =>
      assertCurrentOpenworldScope(scope, await readOpenworldScope(options.db, serverId, reader));
    return { scope, recheck };
  }
  return {
    async read<T>(
      who: AuthContext,
      serverId: string,
      grant: OpenworldPlayerGrant,
      work: (origin: string, token: string, signal: AbortSignal) => Promise<T>,
    ) {
      const { scope, recheck } = await access(who, serverId, grant);
      const result = await native(scope, work);
      await recheck();
      return result;
    },
    async mutate<T>(
      who: AuthContext,
      serverId: string,
      grant: OpenworldPlayerGrant,
      processRef: string,
      work: (
        origin: string,
        token: string,
        signal: AbortSignal,
        recheck: () => Promise<void>,
      ) => Promise<T>,
    ) {
      const { scope, recheck } = await access(who, serverId, grant);
      if (openworldProcessRef(scope) !== processRef) throw new DomainError('conflict');
      return native(scope, (origin, token, signal) => work(origin, token, signal, recheck), false);
    },
  };
}
