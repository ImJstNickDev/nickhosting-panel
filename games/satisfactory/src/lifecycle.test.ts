import type { AuthorizedGameServices } from '@nickhosting/game-sdk';
import { expect, it, vi } from 'vitest';
import { SatisfactoryApi } from './api.js';
import { createSatisfactoryLifecycle } from './lifecycle.js';

const state = {
  activeSessionName: 'Factory',
  numConnectedPlayers: 1,
  playerLimit: 4,
  techTier: 1,
  activeSchematic: '',
  gamePhase: '',
  isGameRunning: true,
  totalGameDuration: 10,
  isGamePaused: false,
  averageTickRate: 30,
  autoLoadSessionName: 'Factory',
};
it('uses authenticated player counts for idle and saves before shutdown', async () => {
  const request = vi
    .fn()
    .mockImplementation(async (body) =>
      body.function === 'QueryServerState' ? { data: { serverGameState: state } } : undefined,
    );
  const lifecycle = createSatisfactoryLifecycle(async () => new SatisfactoryApi({ request }));
  const services = { operationId: 'test-123' } as AuthorizedGameServices;
  expect(await lifecycle.observeIdle?.(services)).toMatchObject({ idle: false, playerCount: 1 });
  await lifecycle.saveAndStop?.(services);
  expect(request.mock.calls.slice(-2).map((call) => call[0])).toEqual([
    { function: 'SaveGame', data: { SaveName: 'NickHosting_test-123' } },
    { function: 'Shutdown' },
  ]);
});
