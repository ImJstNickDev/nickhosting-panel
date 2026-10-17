import { type AuthContext, DomainError } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import {
  authorizeServer,
  inspectMinecraftWorlds,
  type ManagementRuntime,
} from '@nickhosting/server-management';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Variables } from './app.js';
import { registerMinecraftRoutes } from './minecraft.js';

vi.mock('@nickhosting/server-management', async (original) => ({
  ...(await original<typeof import('@nickhosting/server-management')>()),
  authorizeServer: vi.fn(),
  inspectMinecraftWorlds: vi.fn(),
}));
const actor = { subjectUserId: 'reader' } as AuthContext;
const db = {} as ReturnType<typeof createDatabase>['db'];
const snapshot = {
  installed: true,
  supported: true,
  selectedWorld: 'world',
  release: '26.1',
  compatibility: 'unavailable' as const,
  worlds: [],
};

function fixture() {
  const app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'internal_error' },
      error instanceof DomainError ? (error.status as 400) : 500,
    ),
  );
  const authorizeTransfer = vi.fn(async () => {});
  const access = vi.fn(async (_actor, _server, work) => work('provider', db, actor));
  const service = {
    adapter: {},
    fileReadAccess: access,
    authorizeTransfer,
  } as unknown as ManagementRuntime;
  const management = vi.fn(async () => service);
  registerMinecraftRoutes(app, {
    db,
    env: {},
    principal: async () => actor,
    body: async (c) => c.req.json(),
    management,
  });
  return { app, access, management, authorizeTransfer };
}
beforeEach(() => {
  vi.mocked(authorizeServer)
    .mockReset()
    .mockResolvedValue({} as Awaited<ReturnType<typeof authorizeServer>>);
  vi.mocked(inspectMinecraftWorlds).mockReset().mockResolvedValue(snapshot);
});
describe('world snapshot HTTP access contract', () => {
  it('allows inventory readers through managed identity access and returns an uncached snapshot', async () => {
    const f = fixture();
    const response = await f.app.request('/v1/servers/server/minecraft/worlds');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(snapshot);
    expect(authorizeServer).toHaveBeenCalledExactlyOnceWith(db, actor, 'server');
    expect(f.access).toHaveBeenCalledExactlyOnceWith(actor, 'server', expect.any(Function));
    const authorize = vi.mocked(inspectMinecraftWorlds).mock.calls[0]?.[3];
    await authorize?.();
    expect(f.authorizeTransfer).toHaveBeenCalledExactlyOnceWith(actor, 'server', false, db);
  });
  it('rejects unrelated callers before constructing provider services', async () => {
    const f = fixture();
    vi.mocked(authorizeServer).mockRejectedValue(new DomainError('forbidden'));
    expect((await f.app.request('/v1/servers/server/minecraft/worlds')).status).toBe(403);
    expect(f.management).not.toHaveBeenCalled();
    expect(inspectMinecraftWorlds).not.toHaveBeenCalled();
  });
  it('does not inspect files when managed provider identity verification rejects access', async () => {
    const f = fixture();
    f.access.mockRejectedValue(new DomainError('provenance_mismatch'));
    const response = await f.app.request('/v1/servers/server/minecraft/worlds');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'provenance_mismatch' });
    expect(inspectMinecraftWorlds).not.toHaveBeenCalled();
  });
});
