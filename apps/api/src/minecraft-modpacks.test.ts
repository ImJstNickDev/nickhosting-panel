import { randomUUID } from 'node:crypto';
import { type ContentHttp, createModpackCatalog } from '@nickhosting/content-providers';
import { type AuthContext, DomainError } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import { authorizeServer, type ManagementRuntime } from '@nickhosting/server-management';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { minecraftModpackSchemaAvailable } from '../../../packages/server-management/src/minecraft-modpack-schema.js';
import { createMinecraftModpackBridge } from '../../../packages/server-management/src/modpack-bridge.js';
import type { Variables } from './app.js';
import { registerMinecraftModpackRoutes } from './minecraft-modpacks.js';

vi.mock('../../../packages/server-management/src/modpack-bridge.js', () => ({
  createMinecraftModpackBridge: vi.fn(),
}));
vi.mock('../../../packages/server-management/src/minecraft-modpack-schema.js', () => ({
  minecraftModpackSchemaAvailable: vi.fn(),
}));
vi.mock('@nickhosting/server-management', async (load) => ({
  ...(await load<typeof import('@nickhosting/server-management')>()),
  authorizeServer: vi.fn(),
}));
vi.mock('@nickhosting/content-providers', async (load) => ({
  ...(await load<typeof import('@nickhosting/content-providers')>()),
  createModpackCatalog: vi.fn(),
}));
const actor = {
  actorUserId: 'actor',
  subjectUserId: 'actor',
  role: 'user',
  sessionType: 'regular',
  ownerElevation: false,
} as AuthContext;
const serverId = randomUUID();
const operationId = randomUUID();
const base = `/v1/servers/${serverId}/minecraft/modpacks`;
function fixture() {
  const snapshot = { installed: null, operation: { id: operationId, state: 'queued' } };
  const service = {
    snapshot: vi.fn(async () => snapshot),
    prepare: vi.fn(async () => snapshot),
    apply: vi.fn(async () => snapshot),
    cancel: vi.fn(async () => snapshot),
    recover: vi.fn(async () => snapshot),
  };
  vi.mocked(createMinecraftModpackBridge).mockReturnValue(
    service as unknown as ReturnType<typeof createMinecraftModpackBridge>,
  );
  const catalog = {
    search: vi.fn(async () => ({ items: [], offset: 0, limit: 20, total: 0 })),
    details: vi.fn(async () => ({ id: 'pack' })),
    versions: vi.fn(async () => ({ items: [] })),
    resolve: vi.fn(),
  };
  vi.mocked(createModpackCatalog).mockReturnValue(
    catalog as unknown as ReturnType<typeof createModpackCatalog>,
  );
  const result = vi.fn(async () => ({ server_id: serverId }));
  const db = {
    selectFrom: vi.fn(() => ({ select: () => ({ where: () => ({ executeTakeFirst: result }) }) })),
  } as unknown as ReturnType<typeof createDatabase>['db'];
  const http = {} as ContentHttp;
  const minecraftOptions = vi.fn(async () => ({ http }));
  const management = vi.fn(async () => ({ minecraftOptions }) as unknown as ManagementRuntime);
  const principal = vi.fn(async () => actor);
  const app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'internal_error' },
      error instanceof DomainError ? (error.status as 400) : 500,
    ),
  );
  registerMinecraftModpackRoutes(app, {
    db,
    env: {},
    principal,
    management,
    body: async (c) => c.req.json(),
  });
  return {
    app,
    service,
    catalog,
    principal,
    snapshot,
    management,
    minecraftOptions,
    result,
    db,
    http,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(minecraftModpackSchemaAvailable).mockResolvedValue(true);
});
describe('Modpack API boundaries', () => {
  it('returns a private snapshot and all six actual catalog choices', async () => {
    const f = fixture();
    const snapshot = await f.app.request(base);
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get('cache-control')).toBe('no-store');
    expect(f.service.snapshot).toHaveBeenCalledWith(actor, serverId);
    const catalog = await f.app.request(`${base}/catalog`);
    expect(await catalog.json()).toEqual({
      providers: [
        { id: 'modrinth', available: true },
        { id: 'curseforge', available: false },
        { id: 'ftb', available: true },
        { id: 'technic', available: true },
        { id: 'voidswrath', available: true },
        { id: 'atlauncher', available: true },
      ],
    });
  });
  it('browses metadata without preparation, resolution or publication', async () => {
    const f = fixture();
    expect(
      (await f.app.request(`${base}/catalog/search?provider=ftb&query=sky&offset=20`)).status,
    ).toBe(200);
    expect((await f.app.request(`${base}/catalog/technic/sky-pack`)).status).toBe(200);
    expect(
      (await f.app.request(`${base}/catalog/atlauncher/Pack%20Name/versions?offset=0`)).status,
    ).toBe(200);
    expect(f.catalog.search).toHaveBeenCalledWith(
      { provider: 'ftb', query: 'sky', offset: 20 },
      expect.any(AbortSignal),
    );
    expect(f.catalog.versions).toHaveBeenCalledWith(
      'Pack Name',
      { offset: 0 },
      expect.any(AbortSignal),
    );
    expect(authorizeServer).toHaveBeenCalledTimes(3);
    expect(f.service.prepare).not.toHaveBeenCalled();
    expect(f.catalog.resolve).not.toHaveBeenCalled();
  });
  it('serves categories through the authorized catalog and passes category filters', async () => {
    const f = fixture();
    const response = await f.app.request(`${base}/catalog/categories?provider=ftb`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    expect(
      (await f.app.request(`${base}/catalog/search?provider=modrinth&category=adventure`)).status,
    ).toBe(200);
    expect(f.catalog.search).toHaveBeenCalledWith(
      { provider: 'modrinth', query: '', offset: 0, category: 'adventure' },
      expect.any(AbortSignal),
    );
    expect(
      (await f.app.request(`${base}/catalog/search?provider=modrinth&category=bad%3Afacet`)).status,
    ).toBe(400);
    expect(f.service.prepare).not.toHaveBeenCalled();
  });
  it('only explicit preparation/application request intents enter the durable service', async () => {
    const f = fixture();
    const input = {
      provider: 'modrinth',
      projectId: 'pack',
      versionId: 'v1',
      idempotencyKey: 'one',
    };
    for (const action of ['prepare', 'apply'] as const) {
      const response = await f.app.request(`${base}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual(f.snapshot);
      expect(f.service[action]).toHaveBeenCalledWith(actor, serverId, input);
    }
  });
  it('cancel/recover return the updated full snapshot and validate operation IDs', async () => {
    const f = fixture();
    const cancel = await f.app.request(`${base}/operations/${operationId}`, { method: 'DELETE' });
    expect(await cancel.json()).toEqual(f.snapshot);
    const recover = await f.app.request(`${base}/operations/${operationId}/recover`, {
      method: 'POST',
      body: '{}',
    });
    expect(await recover.json()).toEqual(f.snapshot);
    expect(f.service.cancel).toHaveBeenCalledWith(actor, serverId, operationId);
    expect(f.service.recover).toHaveBeenCalledWith(actor, serverId, operationId);
    expect((await f.app.request(`${base}/operations/invalid`, { method: 'DELETE' })).status).toBe(
      400,
    );
  });
  it('rejects unauthenticated and unauthorized catalog access before providers', async () => {
    const f = fixture();
    f.principal.mockRejectedValueOnce(new DomainError('unauthenticated'));
    expect((await f.app.request(base)).status).toBe(401);
    expect(f.management).not.toHaveBeenCalled();
    vi.mocked(authorizeServer).mockRejectedValueOnce(new DomainError('forbidden'));
    expect((await f.app.request(`${base}/catalog/search?provider=modrinth`)).status).toBe(403);
    expect(f.catalog.search).not.toHaveBeenCalled();
  });
  it('contains source-before-migration and absent provider credentials without touching lifecycle tables', async () => {
    const f = fixture();
    vi.mocked(minecraftModpackSchemaAvailable).mockResolvedValueOnce(false);
    expect((await f.app.request(base)).status).toBe(503);
    expect(f.service.snapshot).not.toHaveBeenCalled();
    expect((await f.app.request(`${base}/catalog/search?provider=curseforge`)).status).toBe(503);
    expect(f.catalog.search).not.toHaveBeenCalled();
    expect((await f.app.request(`${base}/catalog/search?provider=unknown`)).status).toBe(400);
    expect(
      (await f.app.request(`${base}/catalog/search?provider=modrinth&offset=999999`)).status,
    ).toBe(400);
  });
  it('keeps uncertain publication visible instead of reporting success', async () => {
    const f = fixture();
    f.service.apply.mockRejectedValue(new DomainError('operation_uncertain'));
    const response = await f.app.request(`${base}/apply`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'operation_uncertain' });
  });
});
