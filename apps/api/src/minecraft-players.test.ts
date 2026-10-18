import { type AuthContext, DomainError } from '@nickhosting/core';
import { recordAudit } from '@nickhosting/database';
import { verifyMinecraftPlayer } from '@nickhosting/minecraft';
import { type ConsoleRelayOptions, PterodactylError } from '@nickhosting/pterodactyl-adapter';
import {
  inspectMinecraftCombination,
  type ManagementRuntime,
} from '@nickhosting/server-management';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planMinecraftPlayerList } from '../../../games/minecraft/src/management.js';
import { resolveMinecraftStoredPlayers } from '../../../packages/server-management/src/minecraft-content.js';
import { minecraftConfigurationSchema } from '../../../packages/server-management/src/minecraft-content-contracts.js';
import type { Variables } from './app.js';
import { observeMinecraftPlayers, registerMinecraftPlayerRoutes } from './minecraft-players.js';

vi.mock('@nickhosting/database', async (original) => ({
  ...(await original<typeof import('@nickhosting/database')>()),
  recordAudit: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({ values: { contentMetadataUserAgent: 'NickHosting tests' } })),
}));
vi.mock('@nickhosting/minecraft', async (original) => ({
  ...(await original<typeof import('@nickhosting/minecraft')>()),
  verifyMinecraftPlayer: vi.fn(async () => ({
    name: 'PlayerOne',
    uuid: '11111111-1111-1111-1111-111111111111',
    source: 'mojang',
    verifiedAt: new Date().toISOString(),
  })),
}));
vi.mock('@nickhosting/server-management', async (original) => ({
  ...(await original<typeof import('@nickhosting/server-management')>()),
  inspectMinecraftCombination: vi.fn(async () => ({
    combination: { release: '26.1' },
    capabilities: { playerManagement: true },
  })),
}));
const player = { name: 'PlayerOne', uuid: '11111111-1111-1111-1111-111111111111' };
function fixture() {
  const profile = {
    installed: true,
    combination_id: 'choice',
    configuration: { eula: true, properties: {}, operators: [], whitelist: [] },
  };
  const files: Record<string, string> = {
    'ops.json': '[]',
    'whitelist.json': '[]',
    'banned-players.json': '[]',
    'server.properties': 'white-list=false\nenforce-whitelist=false',
  };
  const select = {
    selectAll: () => select,
    where: () => select,
    executeTakeFirst: async () => profile,
  };
  let stored: Record<string, unknown> | undefined;
  const update = {
    set: (value: { configuration: string }) => {
      stored = JSON.parse(value.configuration);
      return update;
    },
    where: () => update,
    execute: vi.fn(async () => {}),
  };
  const db = { selectFrom: vi.fn(() => select), updateTable: vi.fn(() => update) };
  const context = {} as AuthContext;
  const server = {
    pterodactyl_id: 1,
    pterodactyl_uuid: 'uuid',
    external_id: 'external',
    updated_at: new Date(0),
  };
  let denied = false;
  let writeDenied = false;
  let state = 'running';
  let binding = 'provider-a';
  let accessActive = false;
  let receipt =
    '[12:34:56] [Server thread/INFO]: There are 1 of a max of 20 players online: PlayerOne';
  const relayClose = vi.fn();
  const requestLogs = vi.fn();
  const service = {
    adapter: {
      prefetchDownloads: vi.fn(async () => {}),
      readFileForEditor: vi.fn(async (_id, path) => {
        if (!(path in files)) throw new DomainError('integration_unavailable');
        return Buffer.from(files[path] ?? '');
      }),
      getResources: vi.fn(async () => ({ current_state: state })),
      sendCommand: vi.fn(async (_id, command) => {
        if (command === 'op PlayerOne')
          files['ops.json'] = JSON.stringify([{ ...player, level: 4, bypassesPlayerLimit: false }]);
      }),
      relayConsole: vi.fn(async (_id: string, options: ConsoleRelayOptions) => ({
        sendCommand: vi.fn(async () => {
          options.onEvent({ type: 'console', data: receipt });
        }),
        requestLogs,
        requestStats: vi.fn(),
        close: relayClose,
      })),
    },
    access: vi.fn(async (_context, _serverId, write, callback) => {
      if (denied || (write && writeDenied)) throw new DomainError('forbidden');
      accessActive = true;
      try {
        return await callback('identifier', db, context, server);
      } finally {
        accessActive = false;
      }
    }),
    fileReadAccess: vi.fn(async (_context, _serverId, callback) => {
      if (denied) throw new DomainError('forbidden');
      return callback('identifier', db, context, server);
    }),
    authorizeTransfer: vi.fn(async () => {
      if (denied) throw new DomainError('forbidden');
    }),
    consoleBindingForServer: vi.fn(async () => {
      if (accessActive) throw new Error('Nested connection acquisition');
      return binding;
    }),
  };
  const app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'internal_error' },
      error instanceof DomainError ? (error.status as 400) : 500,
    ),
  );
  registerMinecraftPlayerRoutes(app, {
    db: db as never,
    env: {},
    principal: async () => context,
    body: async (c) => c.req.json(),
    management: async () => service as unknown as ManagementRuntime,
  });
  return {
    app,
    service,
    profile,
    files,
    server,
    db,
    stored: () => stored,
    relayClose,
    requestLogs,
    denied: (value: boolean) => {
      denied = value;
    },
    writeDenied: () => {
      writeDenied = true;
    },
    state: (value: string) => {
      state = value;
    },
    binding: (value: string) => {
      binding = value;
    },
    receipt: (value: string) => {
      receipt = value;
    },
    action: (body: unknown) =>
      app.request('/v1/servers/server/minecraft/players/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe('Minecraft player HTTP handlers with isolated boundaries', () => {
  it('returns authoritative files with constant fanout and no identity-provider lookup', async () => {
    const f = fixture();
    f.files['ops.json'] = JSON.stringify([{ ...player, level: 1, bypassesPlayerLimit: false }]);
    const response = await f.app.request('/v1/servers/server/minecraft/players');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      supported: true,
      installed: true,
      operators: [{ ...player, level: 1 }],
      banned: [],
    });
    expect(f.service.adapter.readFileForEditor).toHaveBeenCalledTimes(4);
    expect(f.service.adapter.prefetchDownloads).toHaveBeenCalledExactlyOnceWith('identifier', [
      'ops.json',
      'whitelist.json',
      'banned-players.json',
      'server.properties',
    ]);
    expect(f.service.fileReadAccess).toHaveBeenCalledOnce();
    expect(f.service.access).not.toHaveBeenCalled();
    expect(f.db.updateTable).not.toHaveBeenCalled();
  });
  it('does not turn missing/malformed files into empty lists', async () => {
    const f = fixture();
    delete f.files['banned-players.json'];
    expect((await f.app.request('/v1/servers/server/minecraft/players')).status).toBe(503);
  });
  it('treats only an explicit provider 404 as an empty list', async () => {
    const f = fixture();
    f.service.adapter.readFileForEditor.mockRejectedValueOnce(
      new PterodactylError('not_found', 'client', 'rejected', 404),
    );
    const response = await f.app.request('/v1/servers/server/minecraft/players');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operators: [] });
    f.service.adapter.readFileForEditor.mockRejectedValueOnce(
      new PterodactylError('permission_denied', 'client', 'rejected', 403),
    );
    expect((await f.app.request('/v1/servers/server/minecraft/players')).status).toBe(503);
  });
  it('authorizes before provider access and gates writes separately', async () => {
    const f = fixture();
    f.denied(true);
    expect((await f.app.request('/v1/servers/server/minecraft/players')).status).toBe(403);
    expect(f.service.adapter.readFileForEditor).not.toHaveBeenCalled();
    f.denied(false);
    f.writeDenied();
    expect((await f.action({ action: 'op', name: 'PlayerOne' })).status).toBe(403);
    expect(f.service.adapter.sendCommand).not.toHaveBeenCalled();
  });
  it('gates JSON lists/actions on exact supported installed releases', async () => {
    const f = fixture();
    vi.mocked(inspectMinecraftCombination).mockResolvedValueOnce({
      combination: { release: '1.7.5' },
      capabilities: { playerManagement: false },
    } as never);
    expect(
      await (await f.app.request('/v1/servers/server/minecraft/players')).json(),
    ).toMatchObject({ supported: false });
    expect(f.service.adapter.readFileForEditor).not.toHaveBeenCalled();
    f.profile.installed = false;
    expect((await f.action({ action: 'op', name: 'PlayerOne' })).status).toBe(409);
  });
  it('rejects invalid payloads and stopped/starting servers before dispatch', async () => {
    const f = fixture();
    expect((await f.action({ action: 'op', name: '@a' })).status).toBe(400);
    f.state('offline');
    expect((await f.action({ action: 'op', name: 'PlayerOne' })).status).toBe(409);
    f.state('starting');
    expect((await f.action({ action: 'op', name: 'PlayerOne' })).status).toBe(409);
    expect(f.service.adapter.sendCommand).not.toHaveBeenCalled();
  });
  it('dispatches once and persists confirmed UUID authority without claiming Mojang verification', async () => {
    const f = fixture();
    const response = await f.action({ action: 'op', name: 'PlayerOne' });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ outcome: 'dispatched' });
    expect(f.service.adapter.sendCommand).toHaveBeenCalledExactlyOnceWith(
      'identifier',
      'op PlayerOne',
    );
    expect(f.stored()).toMatchObject({
      operators: ['PlayerOne'],
      playerIdentities: { operators: [{ ...player, source: 'server-file', level: 4 }] },
    });
    expect(vi.mocked(recordAudit).mock.calls.map((call) => call[2])).toEqual([
      'server.console.command',
      'server.console.dispatched',
      'server.minecraft.players.reconciled',
    ]);
    const provider = { lookupName: vi.fn(), lookupUuid: vi.fn() };
    const replay = await resolveMinecraftStoredPlayers(f.stored(), provider);
    expect(replay.playerIdentities?.operators[0]?.uuid).toBe(player.uuid);
    expect(provider.lookupName).not.toHaveBeenCalled();
    const storedPlayer = replay.playerIdentities?.operators[0];
    if (!storedPlayer) throw new Error('Missing stored player');
    expect(
      JSON.parse(
        planMinecraftPlayerList('[]', 'operators', 'add', storedPlayer, {
          operatorLevel: storedPlayer.level,
          bypassesPlayerLimit: storedPlayer.bypassesPlayerLimit,
        }).content,
      ),
    ).toEqual([{ ...player, level: 4, bypassesPlayerLimit: false }]);

    expect(minecraftConfigurationSchema.safeParse(f.stored()).success).toBe(false);
  });
  it('reports ambiguous dispatch and never replays it', async () => {
    const f = fixture();
    f.service.adapter.sendCommand.mockRejectedValueOnce(new DomainError('integration_unavailable'));
    const response = await f.action({ action: 'op', name: 'PlayerOne' });
    expect(await response.json()).toEqual({ code: 'operation_uncertain' });
    expect(f.service.adapter.sendCommand).toHaveBeenCalledOnce();
    expect(f.db.updateTable).not.toHaveBeenCalled();
  });
  it('reports unconfirmed file effects without storing planned success', async () => {
    const f = fixture();
    const response = await f.action({ action: 'whitelist-add', name: 'PlayerOne' });
    expect(await response.json()).toEqual({ code: 'operation_uncertain' });
    expect(f.service.adapter.sendCommand).toHaveBeenCalledOnce();
    expect(f.db.updateTable).not.toHaveBeenCalled();
  });
  it('keeps uncertainty when both post-dispatch audit and failure audit are unavailable', async () => {
    const f = fixture();
    vi.mocked(recordAudit)
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockRejectedValueOnce(new Error('database unavailable'));
    const response = await f.action({ action: 'kick', name: 'PlayerOne' });
    expect(await response.json()).toEqual({ code: 'operation_uncertain' });
    expect(f.service.adapter.sendCommand).toHaveBeenCalledOnce();
  });
  it.each(['op', 'deop', 'whitelist-add', 'whitelist-remove', 'ban', 'pardon', 'kick'])(
    'rejects a reclaimed known-row name before live %s dispatch',
    async (action) => {
      const f = fixture();
      f.files['ops.json'] = JSON.stringify([{ ...player, level: 4, bypassesPlayerLimit: false }]);
      f.files['whitelist.json'] = JSON.stringify([player]);
      f.files['banned-players.json'] = JSON.stringify([player]);
      vi.mocked(verifyMinecraftPlayer).mockResolvedValueOnce({
        ...player,
        uuid: '22222222-2222-2222-2222-222222222222',
        source: 'mojang',
        verifiedAt: new Date().toISOString(),
      });
      const response = await f.action({ action, name: player.name, expectedUuid: player.uuid });
      expect(response.status).toBe(409);
      expect(f.service.adapter.sendCommand).not.toHaveBeenCalled();
    },
  );
  it('rejects a missing selected UUID before resolving or dispatching', async () => {
    const f = fixture();
    f.files['ops.json'] = JSON.stringify([
      {
        ...player,
        uuid: '22222222-2222-2222-2222-222222222222',
        level: 4,
        bypassesPlayerLimit: false,
      },
    ]);
    expect(
      (await f.action({ action: 'deop', name: player.name, expectedUuid: player.uuid })).status,
    ).toBe(409);
    expect(verifyMinecraftPlayer).not.toHaveBeenCalled();
    expect(f.service.adapter.sendCommand).not.toHaveBeenCalled();
  });
  it('allows a renamed live target when its selected UUID still exists in the saved list', async () => {
    const f = fixture();
    f.files['ops.json'] = JSON.stringify([
      { ...player, name: 'OldName', level: 4, bypassesPlayerLimit: false },
    ]);
    f.service.adapter.sendCommand.mockImplementationOnce(async () => {
      f.files['ops.json'] = '[]';
    });
    expect(
      (await f.action({ action: 'deop', name: player.name, expectedUuid: player.uuid })).status,
    ).toBe(202);
    expect(verifyMinecraftPlayer).toHaveBeenCalledOnce();
    expect(f.service.adapter.sendCommand).toHaveBeenCalledExactlyOnceWith(
      'identifier',
      'deop PlayerOne',
    );
  });
  it('does not confirm a new UUID addition from an older saved account with the same name', async () => {
    const f = fixture();
    f.files['ops.json'] = JSON.stringify([
      {
        ...player,
        uuid: '22222222-2222-2222-2222-222222222222',
        level: 4,
        bypassesPlayerLimit: false,
      },
    ]);
    f.service.adapter.sendCommand.mockImplementationOnce(async () => {});
    const response = await f.action({ action: 'op', name: player.name, expectedUuid: player.uuid });
    expect(await response.json()).toEqual({ code: 'operation_uncertain' });
    expect(f.db.updateTable).not.toHaveBeenCalled();
    expect(f.service.adapter.sendCommand).toHaveBeenCalledOnce();
  });
  it('allows a new verified UUID only after targeted verification', async () => {
    const f = fixture();
    expect(
      (await f.action({ action: 'op', name: player.name, expectedUuid: player.uuid })).status,
    ).toBe(202);
    expect(verifyMinecraftPlayer).toHaveBeenCalledOnce();
    expect(f.service.adapter.sendCommand).toHaveBeenCalledExactlyOnceWith(
      'identifier',
      'op PlayerOne',
    );
  });
  it('kick reports dispatch only and never writes persistent lists', async () => {
    const f = fixture();
    expect((await f.action({ action: 'kick', name: 'PlayerOne', reason: 'Reason' })).status).toBe(
      202,
    );
    expect(f.service.adapter.sendCommand).toHaveBeenCalledExactlyOnceWith(
      'identifier',
      'kick PlayerOne Reason',
    );
    expect(f.service.adapter.readFileForEditor).not.toHaveBeenCalled();
    expect(f.db.updateTable).not.toHaveBeenCalled();
  });
  it('shares fresh roster observations while authorizing every caller and invalidating binding/lifecycle changes', async () => {
    const f = fixture();
    const path = '/v1/servers/server/minecraft/players/online';
    const responses = await Promise.all([f.app.request(path), f.app.request(path)]);
    expect(await responses[0]?.json()).toMatchObject({
      state: 'available',
      players: [{ name: 'PlayerOne' }],
    });
    expect(f.service.adapter.relayConsole).toHaveBeenCalledOnce();
    expect(f.requestLogs).not.toHaveBeenCalled();
    expect(f.relayClose).toHaveBeenCalledOnce();
    f.denied(true);
    expect((await f.app.request(path)).status).toBe(403);
    f.denied(false);
    f.binding('provider-b');
    await f.app.request(path);
    expect(f.service.adapter.relayConsole).toHaveBeenCalledTimes(2);
    f.server.updated_at = new Date();
    await f.app.request(path);
    expect(f.service.adapter.relayConsole).toHaveBeenCalledTimes(3);
  });
  it('does not request a roster for a stopped server', async () => {
    const f = fixture();
    f.state('offline');
    expect(
      await (await f.app.request('/v1/servers/server/minecraft/players/online')).json(),
    ).toEqual({ state: 'offline', players: [], observedAt: null });
    expect(f.service.adapter.relayConsole).not.toHaveBeenCalled();
  });
  it('ignores spoofed chat until timeout, closes the relay and returns unavailable', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.receipt(
      '[12:34:56] [Server thread/INFO]: <PlayerOne> There are 1 of a max of 20 players online: PlayerOne',
    );
    const result = observeMinecraftPlayers(
      f.service as unknown as ManagementRuntime,
      'identifier',
      async () => true,
    );
    await vi.advanceTimersByTimeAsync(4500);
    expect(await result).toEqual({ state: 'unavailable', players: [], observedAt: null });
    expect(f.relayClose).toHaveBeenCalledOnce();
  });
});
