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
it('requests native save enumeration through the existing authenticated transport', async () => {
  const data = { sessions: [], currentSessionIndex: -1 };
  const request = vi.fn().mockResolvedValue({ data });
  const api = new SatisfactoryApi({ request });
  expect(await api.sessions()).toEqual(data);
  expect(request).toHaveBeenCalledWith({ function: 'EnumerateSessions' }, undefined);
  request.mockResolvedValueOnce({ errorCode: 'insufficient_scope' });
  await expect(api.sessions()).rejects.toThrow();
});

const savedSession = {
  sessionName: 'Factory',
  saveHeaders: [
    {
      saveVersion: 1,
      buildVersion: 513885,
      saveName: 'Factory_autosave',
      mapName: 'Persistent_Level',
      mapOptions: '',
      sessionName: 'Factory',
      playDurationSeconds: 100,
      saveDateTime: '2026-11-01T10:00:00Z',
      isModdedSave: false,
      isEditedSave: false,
      isCreativeModeEnabled: false,
    },
  ],
};
it('allows an active world to be saved and stopped without requiring an existing save', async () => {
  const request = vi.fn();
  const api = new SatisfactoryApi({ request });
  expect(await api.canAutoSleep(state)).toBe(true);
  expect(await api.canAutoSleep({ ...state, numConnectedPlayers: 1 })).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
it('checks current saves for an unloaded world and never retains a previous existence result', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ data: { sessions: [savedSession], currentSessionIndex: -1 } })
    .mockResolvedValueOnce({ data: { sessions: [], currentSessionIndex: -1 } });
  const api = new SatisfactoryApi({ request });
  const unloaded = { ...state, isGameRunning: false };
  const signal = AbortSignal.timeout(1500);
  expect(await api.canAutoSleep(unloaded, signal)).toBe(true);
  expect(await api.canAutoSleep(unloaded, signal)).toBe(false);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledWith({ function: 'EnumerateSessions' }, signal);
});
it.each([
  { data: { sessions: [], currentSessionIndex: -1 } },
  { data: { sessions: [{ sessionName: 'Factory', saveHeaders: [] }], currentSessionIndex: 0 } },
  { data: { sessions: [{ sessionName: 'Factory', saveHeaders: [{}] }], currentSessionIndex: 0 } },
  { data: { sessions: [savedSession], currentSessionIndex: 1 } },
  { data: {} },
  { errorCode: 'insufficient_scope' },
])('keeps setup online without verified saved headers: %j', async (response) => {
  const api = new SatisfactoryApi({ request: async () => response });
  // Even nonempty active/auto-load names are not evidence of an existing world.
  expect(await api.canAutoSleep({ ...state, isGameRunning: false })).toBe(false);
});
it('keeps setup online if enumeration times out or the backend becomes unavailable', async () => {
  const api = new SatisfactoryApi({
    request: async (_body, signal) => {
      signal?.throwIfAborted();
      throw new Error('Backend unavailable');
    },
  });
  const unloaded = { ...state, isGameRunning: false };
  expect(await api.canAutoSleep(unloaded, AbortSignal.abort())).toBe(false);
  expect(await api.canAutoSleep(unloaded)).toBe(false);
});
it('uses native world and advanced settings payloads without console interpolation', async () => {
  const request = vi.fn().mockResolvedValue(undefined);
  const api = new SatisfactoryApi({ request });
  await api.createWorld('Factory');
  await api.loadWorld('Factory_autosave', false);
  await api.applyAdvancedSettings({ 'FG.Test': 'True' });
  expect(request.mock.calls.map((call) => call[0])).toEqual([
    {
      function: 'CreateNewGame',
      data: {
        NewGameData: {
          SessionName: 'Factory',
          StartingLocation: '',
          SkipOnboarding: true,
          AdvancedGameSettings: {},
          CustomOptionsOnlyForModding: {},
        },
      },
    },
    {
      function: 'LoadGame',
      data: { SaveName: 'Factory_autosave', EnableAdvancedGameSettings: false },
    },
    {
      function: 'ApplyAdvancedGameSettings',
      data: { AppliedAdvancedGameSettings: { 'FG.Test': 'True' } },
    },
  ]);
});

it('bootstraps using native tokens and extracts only an unambiguous application token', async () => {
  const applicationToken = `${Buffer.from(JSON.stringify({ pl: 'APIToken' })).toString('base64')}.${'ab'.repeat(64)}`;
  const request = vi
    .fn()
    .mockResolvedValueOnce({ data: { authenticationToken: 'initial.token' } })
    .mockResolvedValueOnce({ data: { authenticationToken: 'admin.token' } })
    .mockResolvedValueOnce({ data: { authenticationToken: 'resumed.token' } })
    .mockResolvedValueOnce({ data: {} })
    .mockResolvedValueOnce({
      data: { commandResult: `Generated application token:\n${applicationToken}\n` },
    });
  const api = new SatisfactoryApi({ request });
  expect(await api.passwordlessLogin('InitialAdmin')).toBe('initial.token');
  expect(await api.claim('Factory', ' private password ')).toBe('admin.token');
  expect(await api.passwordLogin(' private password ')).toBe('resumed.token');
  await api.setClientPassword('players');
  expect(await api.generateApplicationToken()).toBe(applicationToken);
  expect(request.mock.calls.map(([body]) => body)).toEqual([
    { function: 'PasswordlessLogin', data: { MinimumPrivilegeLevel: 'InitialAdmin' } },
    {
      function: 'ClaimServer',
      data: { ServerName: 'Factory', AdminPassword: ' private password ' },
    },
    {
      function: 'PasswordLogin',
      data: { MinimumPrivilegeLevel: 'Administrator', Password: ' private password ' },
    },
    { function: 'SetClientPassword', data: { Password: 'players' } },
    { function: 'RunCommand', data: { Command: 'server.GenerateAPIToken' } },
  ]);
  const prefix = Buffer.from(JSON.stringify({ pl: 'APIToken' })).toString('base64');
  request.mockResolvedValue({ data: { commandResult: `${prefix}.aa ${prefix}.bb` } });
  await expect(api.generateApplicationToken()).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
  request.mockResolvedValue({
    data: { commandResult: `${Buffer.from('{"pl":"Administrator"}').toString('base64')}.aa` },
  });
  await expect(api.generateApplicationToken()).rejects.toMatchObject({
    code: 'integration_unavailable',
  });
});

it.each([
  ['invalid_token', 'game_authentication_failed'],
  ['server_claimed', 'game_setup_conflict'],
  ['server_unavailable', 'game_not_ready'],
  ['save_game_failed', 'game_save_failed'],
  ['function_not_found', 'game_request_unsupported'],
  ['unknown_private_native_error', 'integration_unavailable'],
])('classifies %s without exposing native response data', async (errorCode, code) => {
  const api = new SatisfactoryApi({
    request: async () => ({
      errorCode,
      errorMessage: 'password=secret',
      errorData: { token: 'secret' },
    }),
  });
  await expect(api.state()).rejects.toMatchObject({ code });
  try {
    await api.state();
  } catch (error) {
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(JSON.stringify(error)).not.toContain('unknown_private_native_error');
  }
});
