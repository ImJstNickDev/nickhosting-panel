import { expect, it, vi } from 'vitest';
import { SatisfactoryApi } from './api.js';

const state = {
  activeSessionName: 'Factory',
  numConnectedPlayers: 0,
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
it('saves before stopping and never shuts down after a failed save', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ data: { serverGameState: state } })
    .mockResolvedValueOnce({ errorCode: 'save_game_failed' });
  await expect(new SatisfactoryApi({ request }).saveAndStop('backup')).rejects.toThrow();
  expect(request.mock.calls.map((call) => call[0].function)).toEqual([
    'QueryServerState',
    'SaveGame',
  ]);
});
it('uses documented request casing and preserves authentication in the injected transport', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ data: { serverGameState: state } })
    .mockResolvedValue(undefined);
  await new SatisfactoryApi({ request }).saveAndStop('backup');
  expect(request.mock.calls.map((call) => call[0])).toEqual([
    { function: 'QueryServerState' },
    { function: 'SaveGame', data: { SaveName: 'backup' } },
    { function: 'Shutdown' },
  ]);
});
it('does not interpret malformed state or a failed health check as ready', async () => {
  const api = new SatisfactoryApi({ request: async () => ({ data: {} }) });
  await expect(api.state()).rejects.toThrow();
  expect(await api.health()).toBe(false);
});
