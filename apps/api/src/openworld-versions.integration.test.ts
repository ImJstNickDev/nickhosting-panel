import { type AuthContext, DomainError, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { Hono } from 'hono';
import { sql } from 'kysely';
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
  await sql`insert into "user" (id,name,email,role,"emailVerified") values ('owner','Owner','owner@example.test','owner',true)`.execute(
    database.db,
  );
});
beforeEach(async () => {
  source.mockReset();
  await database.db.deleteFrom('openworld_release_catalog').execute();
  await database.db.deleteFrom('openworld_update_settings').execute();
  await database.db.deleteFrom('openworld_gateway_release_checks').execute();
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

it('stores the Owner notice, applies deployment overrides and rejects invalid values and delegated edits', async () => {
  const path = '/v1/owner/integrations/openworld/update-settings';
  const set = (api: ReturnType<typeof app>, seconds: number) =>
    api.request(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noticeSeconds: seconds }),
    });
  const api = app(owner);
  expect(await (await api.request(path)).json()).toEqual({ noticeSeconds: 60, locked: false });
  expect((await set(api, 0)).status).toBe(400);
  expect((await set(app({ ...owner, role: 'operator' }), 120)).status).toBe(403);
  expect(await (await set(api, 120)).json()).toEqual({ noticeSeconds: 120, locked: false });
  const env = app(owner, { NH_OPENWORLD_UPDATE_NOTICE_SECONDS: '45' });
  expect(await (await env.request(path)).json()).toEqual({ noticeSeconds: 45, locked: true });
  expect((await set(env, 20)).status).toBe(409);
  expect(await (await api.request(path)).json()).toEqual({ noticeSeconds: 120, locked: false });
});

it('shows only the latest correlated Gateway failure for the exact archive to the Owner', async () => {
  const api = app(owner);
  source.mockResolvedValue(first);
  const prefix = Buffer.alloc(40);
  prefix[16] = 8;
  prefix.write('OWMU', 17);
  const nonce = '01020304';
  Buffer.from(nonce, 'hex').copy(prefix, 21);
  prefix.writeUInt16LE(12, 28);
  const status = (v: string) =>
    Buffer.concat([prefix, Buffer.from([0, 0, 0, v.length]), Buffer.from(v)]).toString('hex');
  const when = (n: number) => new Date(1000 * n).toISOString();
  const evidence = {
    sha256: 'a'.repeat(64),
    nonce,
    checkedAt: when(2),
    statusPacketHex: status('other'),
  };
  const send = (client: ReturnType<typeof app>, input: unknown) =>
    client.request(`${path}/a1.2.9/gateway-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  expect((await send(app({ ...owner, role: 'user' }), evidence)).status).toBe(403);
  expect((await send(api, { ...evidence, nonce: '00000000' })).status).toBe(400);
  expect((await send(api, { ...evidence, sha256: '0'.repeat(64) })).status).toBe(409);
  expect(await (await send(api, evidence)).json()).toMatchObject({
    outcome: 'failed',
    reason: 'version_mismatch',
  });
  expect((await (await api.request(path)).json()).releases).toEqual([
    { ...first.releases[0], gatewayFailure: { reason: 'version_mismatch', checkedAt: when(2) } },
    first.releases[1],
  ]);
  expect(await listOpenworldReleases(database.db, codec)).toEqual(first.releases);
  expect(
    (await send(api, { ...evidence, checkedAt: when(1), statusPacketHex: status('a1.2.9') }))
      .status,
  ).toBe(409);
  const changed = {
    ...first,
    releases: first.releases.map((r) => ({ ...r, sha256: 'd'.repeat(64) })),
  };
  source.mockResolvedValueOnce(changed);
  expect((await (await api.request(`${path}/sync`, { method: 'POST' })).json()).releases).toEqual(
    changed.releases,
  );
  await api.request(`${path}/sync`, { method: 'POST' });
  expect(
    await (
      await send(api, { ...evidence, checkedAt: when(3), statusPacketHex: status('a1.2.9') })
    ).json(),
  ).toMatchObject({ outcome: 'passed' });
  expect((await (await api.request(path)).json()).releases).toEqual(first.releases);
  const controlled = {
    sha256: evidence.sha256,
    checkedAt: when(4),
    kind: 'controlled-incompatibility',
    observedVersion: 'a1.2.9',
    serverReady: true,
    probes: 3,
    result: 'no-status-reply',
  };
  expect((await send(api, { ...controlled, serverReady: false })).status).toBe(400);
  expect((await send(api, { ...controlled, observedVersion: 'a1.2.8' })).status).toBe(409);
  expect(await (await send(api, controlled)).json()).toMatchObject({
    outcome: 'failed',
    reason: 'protocol_mismatch',
  });
  expect(await listOpenworldReleases(database.db, codec)).toEqual(first.releases);
});
