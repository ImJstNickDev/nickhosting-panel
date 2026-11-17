import type { AuthorizedGameServices, IdleSleepWakeProvider } from '@nickhosting/game-sdk';
import type { SatisfactoryApi } from './api.js';

/** Core resolves the per-server application token and certificate through its
 * protected store. Game code never receives provider or panel credentials. */
export function createSatisfactoryLifecycle(
  resolveApi: (services: AuthorizedGameServices) => Promise<SatisfactoryApi>,
): IdleSleepWakeProvider {
  return {
    async observeIdle(services) {
      const state = await (await resolveApi(services)).state();
      return {
        idle: state.numConnectedPlayers === 0,
        playerCount: state.numConnectedPlayers,
        observedAt: new Date(),
      };
    },
    async checkReadiness(services) {
      const api = await resolveApi(services);
      if (!(await api.health())) return { ready: false };
      await api.state();
      return { ready: true };
    },
    async saveAndStop(services) {
      const api = await resolveApi(services);
      const state = await api.state();
      if (state.isGameRunning) {
        const operation = services.operationId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
        await api.save(`NickHosting_${operation}`);
      }
      await api.shutdown();
    },
  };
}
