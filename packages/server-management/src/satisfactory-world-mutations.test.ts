import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  lock: true,
  authorization: vi.fn().mockResolvedValue({ active_operation_id: null }),
  audit: vi.fn(),
  state: vi.fn(),
  sessions: vi.fn(),
  advancedSettings: vi.fn(),
  applyAdvancedSettings: vi.fn(),
  save: vi.fn(),
  createWorld: vi.fn(),
}));
vi.mock('kysely', () => ({
  sql: () => ({ execute: async () => ({ rows: [{ acquired: fixture.lock }] }) }),
}));
vi.mock('@nickhosting/database', () => ({ recordAudit: fixture.audit }));
vi.mock('./registry.js', () => ({ authorizeServer: fixture.authorization }));
vi.mock('./satisfactory-tls.js', () => ({
  readSatisfactoryTlsIdentity: async () => ({ certificatePem: 'unused' }),
}));
vi.mock('../../../games/satisfactory/src/api.js', () => ({
  SatisfactoryApi: class {
    state = fixture.state;
    sessions = fixture.sessions;
    advancedSettings = fixture.advancedSettings;
    applyAdvancedSettings = fixture.applyAdvancedSettings;
    save = fixture.save;
    createWorld = fixture.createWorld;
  },
}));
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
  X509Certificate: class {
    raw = Buffer.from('certificate');
  },
}));

import type { AuthContext, SecretCodec } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { Kysely } from 'kysely';
import { beforeEach } from 'vitest';
import { applySatisfactoryAdvancedSettings, mutateSatisfactoryWorld } from './satisfactory-api.js';

const id = '11111111-1111-4111-8111-111111111111';
const context = {} as AuthContext;
const codec = { decrypt: () => 'token' } as unknown as SecretCodec;
function database(runtimeState = 'running', installationState = 'installed') {
  const db = {
    connection: () => ({ execute: (work: (connection: unknown) => unknown) => work(db) }),
    selectFrom: (table: string) => {
      const query = {
        select: () => query,
        where: () => query,
        innerJoin: () => query,
        executeTakeFirst: async () =>
          table.startsWith('managed_servers')
            ? {
                game_id: 'satisfactory',
                installation_state: installationState,
                runtime_state: runtimeState,
              }
            : table === 'server_allocations'
              ? { backend_address: '127.0.0.1', port: 7777 }
              : { envelope: {} },
      };
      return query;
    },
  };
  return db as unknown as Kysely<Database>;
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.lock = true;
  fixture.authorization.mockResolvedValue({ active_operation_id: null });
  fixture.state.mockResolvedValue({ isGameRunning: true, activeSessionName: 'Factory' });
  fixture.sessions.mockResolvedValue({ sessions: [] });
  fixture.advancedSettings.mockResolvedValue({
    creativeModeEnabled: false,
    advancedGameSettings: { 'FG.Test': 'False' },
  });
});
it('rejects mutations when lifecycle lock is held or another operation is active', async () => {
  fixture.lock = false;
  await expect(
    mutateSatisfactoryWorld(database(), codec, context, id, {
      action: 'create',
      input: { sessionName: 'New', confirm: true },
    }),
  ).rejects.toThrow();
  fixture.lock = true;
  fixture.authorization.mockResolvedValue({ active_operation_id: 'operation' });
  await expect(
    mutateSatisfactoryWorld(database(), codec, context, id, {
      action: 'create',
      input: { sessionName: 'New', confirm: true },
    }),
  ).rejects.toThrow();
  expect(fixture.state).not.toHaveBeenCalled();
});
it.each([
  ['offline', 'installed'],
  ['running', 'installing'],
])('blocks world and advanced mutations for %s/%s', async (runtime, installation) => {
  const db = database(runtime, installation);
  await expect(
    mutateSatisfactoryWorld(db, codec, context, id, {
      action: 'create',
      input: { sessionName: 'New', confirm: true },
    }),
  ).rejects.toThrow();
  await expect(
    applySatisfactoryAdvancedSettings(db, codec, context, id, {
      settings: { 'FG.Test': 'True' },
      expectedSessionName: 'Factory',
      confirmEnable: true,
    }),
  ).rejects.toThrow();
  expect(fixture.state).not.toHaveBeenCalled();
});
it('requires matching world, active game, known settings and explicit creative enablement', async () => {
  const db = database();
  for (const input of [
    { settings: { 'FG.Test': 'True' }, expectedSessionName: 'Other', confirmEnable: true },
    { settings: { 'FG.Test': 'True' }, expectedSessionName: 'Factory', confirmEnable: false },
    { settings: { unknown: 'True' }, expectedSessionName: 'Factory', confirmEnable: true },
  ])
    await expect(
      applySatisfactoryAdvancedSettings(db, codec, context, id, input),
    ).rejects.toThrow();
  fixture.state.mockResolvedValue({ isGameRunning: false, activeSessionName: 'Factory' });
  await expect(
    applySatisfactoryAdvancedSettings(db, codec, context, id, {
      settings: { 'FG.Test': 'True' },
      expectedSessionName: 'Factory',
      confirmEnable: true,
    }),
  ).rejects.toThrow();
  expect(fixture.applyAdvancedSettings).not.toHaveBeenCalled();
});
it('applies authorized settings through the native API and records audit', async () => {
  await applySatisfactoryAdvancedSettings(database(), codec, context, id, {
    settings: { 'FG.Test': 'True' },
    expectedSessionName: 'Factory',
    confirmEnable: true,
  });
  expect(fixture.applyAdvancedSettings).toHaveBeenCalledWith({ 'FG.Test': 'True' });
  expect(fixture.authorization).toHaveBeenCalledTimes(2);
  expect(fixture.audit.mock.calls.map((call) => call[2])).toEqual([
    'satisfactory.advanced-settings.requested',
    'satisfactory.advanced-settings.updated',
  ]);
});
