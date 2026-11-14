import { DomainError } from '@nickhosting/core';
import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Variables } from './app.js';
import { registerSatisfactoryApiRoutes } from './satisfactory-api.js';
import type { ServerRouteOptions } from './servers.js';

const mocked = vi.hoisted(() => ({
  authorize: vi.fn(),
  setToken: vi.fn(),
  configured: vi.fn(),
  apply: vi.fn(),
  world: vi.fn(),
  advanced: vi.fn(),
}));
vi.mock('@nickhosting/server-management', () => ({ authorizeServer: mocked.authorize }));
vi.mock('../../../packages/server-management/src/satisfactory-api.js', () => ({
  setSatisfactoryApiToken: mocked.setToken,
  satisfactoryApiConfigured: mocked.configured,
  applySatisfactoryOptions: mocked.apply,
  mutateSatisfactoryWorld: mocked.world,
  applySatisfactoryAdvancedSettings: mocked.advanced,
  resolveSatisfactoryApi: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocked.authorize.mockResolvedValue({ mapping_id: 'mapping' });
  mocked.configured.mockResolvedValue(true);
});
function app() {
  const query = {
    select: () => query,
    where: () => query,
    executeTakeFirst: async () => ({ game_id: 'satisfactory' }),
  };
  const value = new Hono<{ Variables: Variables }>();
  value.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'error' },
      error instanceof DomainError && error.code === 'forbidden' ? 403 : 400,
    ),
  );
  registerSatisfactoryApiRoutes(value, {
    db: { selectFrom: () => query },
    codec: {},
    principal: async () => ({ actor: { id: 'owner' } }),
  } as unknown as Pick<ServerRouteOptions, 'db' | 'codec' | 'principal'>);
  return value;
}
it('returns only whether the token is configured', async () => {
  const response = await app().request(
    '/v1/servers/11111111-1111-4111-8111-111111111111/satisfactory/api',
  );
  expect(await response.json()).toEqual({ configured: true });
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('requires manage permission before accepting token or option updates', async () => {
  mocked.authorize.mockRejectedValue(new DomainError('forbidden'));
  const response = await app().request(
    '/v1/servers/11111111-1111-4111-8111-111111111111/satisfactory/api/token',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secret' }),
    },
  );
  expect(response.status).toBe(403);
  expect(mocked.authorize.mock.calls[0]?.[3]).toBe('server:manage');
  expect(mocked.setToken).not.toHaveBeenCalled();
});
it('rejects malformed token writes without calling the secret store', async () => {
  const response = await app().request(
    '/v1/servers/11111111-1111-4111-8111-111111111111/satisfactory/api/token',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '', unexpected: 'value' }),
    },
  );
  expect(response.status).toBe(400);
  expect(mocked.setToken).not.toHaveBeenCalled();
});

it.each(['save', 'create', 'load'])('requires manage permission for world %s', async (action) => {
  mocked.authorize.mockRejectedValue(new DomainError('forbidden'));
  const response = await app().request(
    `/v1/servers/11111111-1111-4111-8111-111111111111/satisfactory/api/worlds/${action}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  expect(response.status).toBe(403);
  expect(mocked.authorize.mock.calls[0]?.[3]).toBe('server:manage');
  expect(mocked.world).not.toHaveBeenCalled();
});
it('rejects unconfirmed world loads without calling the lifecycle service', async () => {
  const response = await app().request(
    '/v1/servers/11111111-1111-4111-8111-111111111111/satisfactory/api/worlds/load',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saveName: 'Factory' }),
    },
  );
  expect(response.status).toBe(400);
  expect(mocked.world).not.toHaveBeenCalled();
});
it('passes validated world requests to the shared service', async () => {
  const response = await app().request(
    '/v1/servers/11111111-1111-4111-8111-111111111111/satisfactory/api/worlds/load',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saveName: 'Factory', confirm: true }),
    },
  );
  expect(response.status).toBe(204);
  expect(mocked.world.mock.calls[0]?.[4]).toEqual({
    action: 'load',
    input: { saveName: 'Factory', confirm: true, enableAdvancedGameSettings: false },
  });
});

it('authorizes server reads before opening a Worlds stream or decrypting snapshots', async () => {
  mocked.authorize.mockRejectedValueOnce(new DomainError('forbidden'));
  const response = await app().request(
    '/v1/servers/11111111-1111-4111-8111-111111111111/satisfactory/api/worlds/stream',
  );
  expect(response.status).toBe(403);
  expect(mocked.authorize).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    '11111111-1111-4111-8111-111111111111',
    'server:read',
  );
});
