import { DomainError } from '@nickhosting/core';
import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Variables } from './app.js';
import { registerSatisfactoryOverviewRoutes } from './satisfactory-overview.js';
import type { ServerRouteOptions } from './servers.js';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  state: vi.fn(),
  resolve: vi.fn(),
  configured: vi.fn(),
}));
vi.mock('@nickhosting/server-management', () => ({ authorizeServer: mocks.authorize }));
vi.mock('../../../packages/server-management/src/satisfactory-api.js', () => ({
  resolveSatisfactoryApi: mocks.resolve,
  satisfactoryApiConfigured: mocks.configured,
}));
const state = {
  activeSessionName: 'Factory',
  numConnectedPlayers: 3,
  playerLimit: 4,
  techTier: 2,
  activeSchematic: '',
  gamePhase: '',
  isGameRunning: true,
  totalGameDuration: 3600,
  isGamePaused: false,
  averageTickRate: 30,
  autoLoadSessionName: 'Factory',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ mapping_id: 'mapping', runtime_state: 'offline' });
  mocks.configured.mockResolvedValue(true);
  mocks.resolve.mockResolvedValue({ state: mocks.state });
  mocks.state.mockResolvedValue(state);
});
function app(snapshot?: unknown, game = 'satisfactory') {
  const app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json({ error: error instanceof DomainError ? error.code : 'error' }, 403),
  );
  registerSatisfactoryOverviewRoutes(app, {
    principal: async () => ({}),
    codec: { decrypt: () => JSON.stringify(snapshot) },
    db: {
      selectFrom: (table: string) => {
        const query = {
          select: () => query,
          where: () => query,
          executeTakeFirst: async () =>
            table === 'runtime_egg_mappings'
              ? { game_id: game }
              : snapshot
                ? { envelope: {} }
                : undefined,
        };
        return query;
      },
    },
  } as unknown as Pick<ServerRouteOptions, 'principal' | 'codec' | 'db'>);
  return app;
}
const path = '/v1/servers/11111111-1111-4111-8111-111111111111/satisfactory/api/overview';
it('returns dated historical data without contacting or waking an offline backend', async () => {
  const response = await app({
    QueryServerState: { observedAt: 1700000000000, body: { data: { serverGameState: state } } },
  }).request(path);
  expect(await response.json()).toEqual({
    configured: true,
    state,
    observedAt: new Date(1700000000000).toISOString(),
    source: 'snapshot',
  });
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('does not invent state for an empty cache', async () => {
  expect(await (await app().request(path)).json()).toMatchObject({
    state: null,
    source: 'unavailable',
  });
});
it('queries native state only while running and configured', async () => {
  mocks.authorize.mockResolvedValue({ mapping_id: 'mapping', runtime_state: 'running' });
  expect(await (await app().request(path)).json()).toMatchObject({ state, source: 'live' });
  expect(mocks.state).toHaveBeenCalledOnce();
});
it('rejects access before reading cached observations', async () => {
  mocks.authorize.mockRejectedValue(new DomainError('forbidden'));
  expect((await app().request(path)).status).toBe(403);
  expect(mocks.configured).not.toHaveBeenCalled();
});
it('rejects another integration', async () => {
  expect((await app(undefined, 'minecraft').request(path)).status).toBe(403);
  expect(mocks.resolve).not.toHaveBeenCalled();
});
