import { type AuthContext, DomainError, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readOpenworldCatalog } from '../../../games/openworld/src/catalog-source.js';
import {
  listOpenworldReleases,
  openworldReleaseCatalog,
} from '../../../packages/server-management/src/openworld-catalog.js';
import type { Variables } from './app.js';
import { registerOpenworldRoutes } from './openworld.js';

vi.mock('../../../games/openworld/src/catalog-source.js', async (load) => ({
  ...(await load<typeof import('../../../games/openworld/src/catalog-source.js')>()),
  readOpenworldCatalog: vi.fn(),
}));
const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 24) } });
const owner: AuthContext = {
  role: 'owner',
  actorUserId: 'owner',
  subjectUserId: 'owner',
  sessionType: 'regular',
  ownerElevation: false,
};
const path = '/v1/owner/integrations/openworld/versions';
const release = (version: string) => ({ version, size: 1200, sha256: 'a'.repeat(64) });
const first = { source: 'official' as const, releases: [release('a1.2.9'), release('a1.2.8')] };
const second = { source: 'metiva' as const, releases: [release('a1.2.10'), ...first.releases] };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
const source = vi.mocked(readOpenworldCatalog);
beforeAll(async () => {
  database = await createTestDatabase();
});
beforeEach(async () => {
  source.mockReset();
  await database.db.deleteFrom('openworld_release_catalog').execute();
});
afterAll(() => database.destroy());
function app(context: AuthContext, env: Record<string, string> = {}) {
  const api = new Hono<{ Variables: Variables }>();
  api.onError((error) => {
    if (error instanceof DomainError)
      return Response.json({ error: error.code }, { status: error.status });
    throw error;
  });
  registerOpenworldRoutes(api, { db: database.db, principal: async () => context, codec, env });
  return api;
}
it('requires a regular Owner before reading or synchronizing', async () => {
  const api = app({ ...owner, role: 'operator' });
  expect((await api.request(path)).status).toBe(403);
  expect((await api.request(`${path}/sync`, { method: 'POST' })).status).toBe(403);
  expect(source).not.toHaveBeenCalled();
});
it('shares atomic explicit sync with the wizard, retains the last success on failure, and scopes reads to the current credential', async () => {
  const env = { NH_METIVA_ACCESS_TOKEN: 'mtv_first' };
  const api = app(owner, env);
  source.mockResolvedValueOnce(first);
  expect(await (await api.request(path)).json()).toMatchObject(first);
  source.mockResolvedValueOnce(second);
  expect(await (await api.request(`${path}/sync`, { method: 'POST' })).json()).toMatchObject(
    second,
  );
  expect(await listOpenworldReleases(database.db, codec, env)).toEqual(second.releases);
  source.mockRejectedValue(new DomainError('integration_unavailable'));
  expect((await api.request(`${path}/sync`, { method: 'POST' })).status).toBe(503);
  expect(await (await api.request(path)).json()).toMatchObject(second);
  env.NH_METIVA_ACCESS_TOKEN = 'mtv_rotated';
  expect((await api.request(path)).status).toBe(503);
  expect(source).toHaveBeenLastCalledWith('mtv_rotated');
  source.mockResolvedValueOnce(first);
  expect(await listOpenworldReleases(database.db, codec, env)).toEqual(first.releases);
});
it('preserves a newer generation when two processes finish out of order', async () => {
  const slowRead = Promise.withResolvers<typeof first>();
  source.mockReturnValueOnce(slowRead.promise).mockResolvedValueOnce(second);
  const older = openworldReleaseCatalog(database.db, codec, {}, 'sync');
  await vi.waitFor(() => expect(source).toHaveBeenCalledTimes(1));
  const newer = await openworldReleaseCatalog(
    database.db.withSchema(database.schema),
    codec,
    {},
    'sync',
  );
  slowRead.resolve(first);
  expect((await older).releases).toEqual(newer.releases);
  expect(await listOpenworldReleases(database.db, codec, {})).toEqual(second.releases);
});
it('returns stale wizard data immediately and throttles failed background refreshes', async () => {
  const seed = database.db.withSchema(database.schema);
  source.mockResolvedValueOnce(first);
  await openworldReleaseCatalog(seed, codec, {}, 'sync');
  await seed
    .updateTable('openworld_release_catalog')
    .set({ synced_at: new Date(0) })
    .execute();
  const reader = database.db.withSchema(database.schema);
  const slowRead = Promise.withResolvers<typeof first>();
  source.mockReturnValueOnce(slowRead.promise);
  expect(await listOpenworldReleases(reader, codec, {})).toEqual(first.releases);
  await vi.waitFor(() => expect(source).toHaveBeenCalledTimes(2));
  slowRead.reject(new DomainError('integration_unavailable'));
  expect(await listOpenworldReleases(reader, codec, {})).toEqual(first.releases);
  expect(source).toHaveBeenCalledTimes(2);
  source.mockResolvedValueOnce(second);
  expect((await openworldReleaseCatalog(reader, codec, {}, 'sync')).releases).toEqual(
    second.releases,
  );
});
