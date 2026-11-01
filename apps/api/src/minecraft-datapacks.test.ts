import { type AuthContext, DomainError } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import type { ManagementRuntime } from '@nickhosting/server-management';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMinecraftDatapackService } from '../../../packages/server-management/src/minecraft-datapacks.js';
import type { Variables } from './app.js';
import { registerMinecraftDatapackRoutes } from './minecraft-datapacks.js';

vi.mock('../../../packages/server-management/src/minecraft-datapacks.js', () => ({
  createMinecraftDatapackService: vi.fn(),
}));
const actor = {
  actorUserId: 'actor',
  subjectUserId: 'actor',
  role: 'user',
  sessionType: 'regular',
  ownerElevation: false,
} as AuthContext;
function fixture() {
  const service = {
    snapshot: vi.fn(async () => ({ world: 'world', packs: [], changes: [] })),
    prepare: vi.fn(async () => ({ changeId: 'change', state: 'ready' })),
    apply: vi.fn(async () => ({ state: 'published', reload: 'requested' })),
    cancel: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ metadata: null, reason: 'too_large' })),
    recover: vi.fn(async () => ({ recovered: 0, uncertain: 1 })),
  };
  vi.mocked(createMinecraftDatapackService).mockReturnValue(
    service as unknown as ReturnType<typeof createMinecraftDatapackService>,
  );
  const app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'internal_error' },
      error instanceof DomainError ? (error.status as 400) : 500,
    ),
  );
  const principal = vi.fn(async () => actor);
  registerMinecraftDatapackRoutes(app, {
    db: {} as ReturnType<typeof createDatabase>['db'],
    env: {},
    principal,
    body: async (c) => c.req.json(),
    management: async () => ({}) as ManagementRuntime,
  });
  return { app, service, principal };
}
beforeEach(() => vi.clearAllMocks());
describe('Minecraft datapack handler boundaries', () => {
  it('returns private world-scoped inventory without cache', async () => {
    const f = fixture();
    const response = await f.app.request('/v1/servers/server/minecraft/datapacks?world=second');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(f.service.snapshot).toHaveBeenCalledExactlyOnceWith(actor, 'server', 'second');
  });
  it('passes preparation to the managed service without mutating providers in the handler', async () => {
    const f = fixture();
    const payload = {
      world: 'world',
      action: 'disable',
      path: 'world/datapacks/a.zip',
      idempotencyKey: 'test',
    };
    const response = await f.app.request('/v1/servers/server/minecraft/datapacks/changes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(201);
    expect(f.service.prepare).toHaveBeenCalledExactlyOnceWith(actor, 'server', payload);
  });
  it('keeps requested reload distinct from completed', async () => {
    const f = fixture();
    const payload = { world: 'world', idempotencyKey: 'apply' };
    const response = await f.app.request('/v1/servers/server/minecraft/datapacks/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(await response.json()).toEqual({ state: 'published', reload: 'requested' });
    expect(f.service.apply).toHaveBeenCalledExactlyOnceWith(actor, 'server', payload);
  });
  it('rejects an absent session before service access', async () => {
    const f = fixture();
    f.principal.mockRejectedValue(new DomainError('unauthenticated'));
    const response = await f.app.request('/v1/servers/server/minecraft/datapacks');
    expect(response.status).toBe(401);
    expect(f.service.snapshot).not.toHaveBeenCalled();
  });
  it('does not conceal uncertain publication', async () => {
    const f = fixture();
    f.service.apply.mockRejectedValue(new DomainError('operation_uncertain'));
    const response = await f.app.request('/v1/servers/server/minecraft/datapacks/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ world: 'world', idempotencyKey: 'x' }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'operation_uncertain' });
  });
});
