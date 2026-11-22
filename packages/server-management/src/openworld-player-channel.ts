import { type AuthContext, DomainError } from '@nickhosting/core';
import {
  assertCurrentOpenworldScope,
  createOpenworldNativeConnection,
  type OpenworldNativeOptions,
  type OpenworldPlayerGrant,
  type OpenworldScope,
  openworldProcessRef,
  readOpenworldScope,
} from './openworld-telemetry.js';

export function createOpenworldPlayerChannel(options: OpenworldNativeOptions) {
  const native = options.native ?? createOpenworldNativeConnection(options);
  async function access(
    who: AuthContext,
    serverId: string,
    grant: OpenworldPlayerGrant,
    inspection?: 'required' | 'include',
  ) {
    const reader = {
      who,
      resource: inspection === 'required' ? ('player' as const) : ('players' as const),
      playerGrant: grant,
    };
    const scope = await readOpenworldScope(options.db, serverId, reader);
    if (scope.reason) throw new DomainError('game_not_ready');
    const recheck = async () => {
      const current = await readOpenworldScope(options.db, serverId, reader);
      assertCurrentOpenworldScope(scope, current);
      if (inspection === 'include' && scope.canInspectPlayers && !current.canInspectPlayers)
        throw new DomainError('forbidden');
    };
    return { scope, recheck };
  }
  return {
    async read<T>(
      who: AuthContext,
      serverId: string,
      grant: OpenworldPlayerGrant,
      work: (
        origin: string,
        token: string,
        signal: AbortSignal,
        scope: OpenworldScope,
      ) => Promise<T>,
      inspection?: 'required' | 'include',
    ) {
      const { scope, recheck } = await access(who, serverId, grant, inspection);
      const result = await native(scope, (origin, token, signal) =>
        work(origin, token, signal, scope),
      );
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
