import { authSessionId, DomainError } from '@nickhosting/core';
import { getSettings } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ManagementRuntime } from '@nickhosting/server-management';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerPlatformRoutes } from './platform.js';
import { registerServerRoutes, type ServerRouteOptions } from './servers.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let actor: Awaited<ReturnType<typeof managementFixture>>['context'];
let app: Hono<{ Variables: Variables }>;
let env: Record<string, string | undefined>;
const management = vi.fn<() => Promise<ManagementRuntime>>();
const principal = vi.fn<ServerRouteOptions['principal']>(async () => actor);
const domains = [
  { id: 'one', hostname: 'one.example.test', zoneId: 'a'.repeat(32), enabled: true },
  { id: 'two', hostname: 'two.example.test', zoneId: 'b'.repeat(32), enabled: true },
  { id: 'disabled', hostname: 'disabled.example.test', zoneId: 'c'.repeat(32), enabled: false },
];
const otherDomain = { selection: 'deny' as const, domainIds: ['two'] };
const otherContent = { sourceConcurrent: 1 };

function request(kind: 'domain' | 'content', input?: unknown, game = 'minecraft') {
  return app.request(`/v1/owner/integrations/${game}/${kind}-policy`, {
    method: input === undefined ? 'GET' : 'PUT',
    ...(input === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  await database.db.deleteFrom('platform_settings').where('key', '=', 'platform').execute();
  f = await managementFixture(database.db, { interactive: true });
  await f.db
    .updateTable('platform_settings')
    .set({
      value: {
        pterodactylBaseUrl: 'https://panel.example.test',
        dnsDomains: domains,
        dnsDefaultDomainId: 'one',
        dnsGamePolicies: { 'other-installed-game': otherDomain },
        gameContentPolicies: { 'other-installed-game': otherContent },
        contentSourceConcurrent: 3,
        contentSourceUserConcurrent: 2,
        contentDownloadOrigins: ['https://downloads.example.test'],
      },
    })
    .where('key', '=', 'platform')
    .execute();
  actor = f.owner;
  env = {};
  principal.mockClear();
  management.mockReset().mockRejectedValue(new Error('No provider operations in policy settings'));
  app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'internal_error' },
      error instanceof DomainError ? (error.status as 400) : 500,
    ),
  );
  registerPlatformRoutes(app, { db: f.db, env, principal, management });
  registerServerRoutes(app, {
    db: f.db,
    env,
    principal,
    management,
    acquireUploadSlot: () => () => {},
  });
});

describe('scoped Owner integration policies', () => {
  it('returns only scoped domain policy and safe domain labels', async () => {
    const response = await request('domain');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      gameId: 'minecraft',
      policy: { selection: 'all', domainIds: [] },
      domains: domains.map(({ id, hostname, enabled }) => ({ id, hostname, enabled })),
      inheritedDefaultDomainId: 'one',
      locked: false,
    });
    expect(principal.mock.calls[0]?.[1]).toBe(true);
    expect(management).not.toHaveBeenCalled();
  });

  it('serializes scoped writes and preserves unrelated integrations and settings', async () => {
    const policy = { selection: 'allow', domainIds: ['two'], defaultDomainId: 'two' };
    const [domain, content] = await Promise.all([
      request('domain', policy),
      request('content', { sourceConcurrent: 2, sourceUserConcurrent: 1 }),
    ]);
    expect(domain.status).toBe(200);
    expect(content.status).toBe(200);
    const settings = await getSettings(f.db);
    expect(settings.values.dnsGamePolicies).toEqual({
      'other-installed-game': otherDomain,
      minecraft: policy,
    });
    expect(settings.values.gameContentPolicies).toEqual({
      'other-installed-game': otherContent,
      minecraft: { sourceConcurrent: 2, sourceUserConcurrent: 1 },
    });
    expect(settings.values.dnsDomains).toEqual(domains);
    expect(settings.values.contentSourceConcurrent).toBe(3);
    const audit = await f.db
      .selectFrom('audit_events')
      .select(['actor_user_id', 'action', 'metadata'])
      .where('action', 'in', ['game.domain_policy.updated', 'game.content_policy.updated'])
      .execute();
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_user_id: f.owner.actorUserId,
          action: 'game.domain_policy.updated',
          metadata: { gameId: 'minecraft' },
        }),
        expect.objectContaining({
          actor_user_id: f.owner.actorUserId,
          action: 'game.content_policy.updated',
          metadata: { gameId: 'minecraft' },
        }),
      ]),
    );
    expect(management).not.toHaveBeenCalled();
  });

  it('exposes effective global content ceilings and restores inheritance with an empty policy', async () => {
    const response = await request('content', {
      sourceConcurrent: 10,
      sourceUserConcurrent: 1,
      downloadOrigins: ['https://downloads.example.test', 'https://not-trusted.example.test'],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      policy: { sourceConcurrent: 10, sourceUserConcurrent: 1 },
      locked: false,
      effective: {
        values: {
          sourceConcurrent: 3,
          sourceUserConcurrent: 1,
          downloadOrigins: ['https://downloads.example.test'],
        },
      },
    });
    const reset = await request('content', {});
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({
      policy: {},
      effective: { values: { sourceConcurrent: 3, sourceUserConcurrent: 2 } },
    });
    expect((await getSettings(f.db)).values.gameContentPolicies['other-installed-game']).toEqual(
      otherContent,
    );
  });

  it('rejects invalid domains, an ineligible default, unrelated fields and unsupported game IDs', async () => {
    for (const input of [
      { selection: 'allow', domainIds: ['unknown'] },
      { selection: 'allow', domainIds: ['one'], defaultDomainId: 'two' },
      { selection: 'deny', domainIds: ['two'], defaultDomainId: 'two' },
      { selection: 'all', domainIds: [], defaultDomainId: 'disabled' },
      { selection: 'all', domainIds: ['one', 'one'] },
      { selection: 'all', domainIds: [], sharedLabel: 'custom' },
      { selection: 'all', domainIds: [], dnsTarget: 'untrusted.example.test' },
    ])
      expect((await request('domain', input)).status).toBe(400);
    expect((await request('content', { sourceConcurrent: 0 })).status).toBe(400);
    expect((await request('content', { sourceRoot: '/other/path' })).status).toBe(400);
    expect(
      (await request('content', { downloadOrigins: ['http://untrusted.example.test'] })).status,
    ).toBe(400);
    for (const kind of ['domain', 'content'] as const) {
      expect((await request(kind, undefined, 'untrusted-module')).status).toBe(404);
      expect((await request(kind, {}, 'untrusted-module')).status).toBe(404);
    }
  });

  it('enforces environment locks without persisting their values', async () => {
    env.NH_DNS_GAME_POLICIES = JSON.stringify({
      minecraft: { selection: 'allow', domainIds: ['one'] },
    });
    env.NH_GAME_CONTENT_POLICIES = JSON.stringify({ minecraft: { sourceConcurrent: 1 } });
    expect(await (await request('domain')).json()).toMatchObject({
      locked: true,
      policy: { selection: 'allow', domainIds: ['one'] },
    });
    expect(await (await request('content')).json()).toMatchObject({
      locked: true,
      policy: { sourceConcurrent: 1 },
    });
    expect((await request('domain', { selection: 'all', domainIds: [] })).status).toBe(409);
    expect((await request('content', {})).status).toBe(409);
    const settings = await getSettings(f.db);
    expect(settings.values.dnsGamePolicies.minecraft).toBeUndefined();
    expect(settings.values.gameContentPolicies.minecraft).toBeUndefined();
  });

  it('rechecks the real session role and denies regular users, support and expired sessions', async () => {
    actor = f.context;
    for (const kind of ['domain', 'content'] as const) {
      expect((await request(kind)).status).toBe(403);
      expect((await request(kind, {})).status).toBe(403);
    }
    actor = { ...f.owner, sessionType: 'support' };
    expect((await request('domain')).status).toBe(403);
    expect((await request('content', {})).status).toBe(403);
    actor = f.owner;
    await f.db
      .updateTable('session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', f.owner[authSessionId] as string)
      .execute();
    expect((await request('domain', { selection: 'all', domainIds: [] })).status).toBe(401);
    expect((await request('content')).status).toBe(401);
  });
});

describe('runtime mapping editability', () => {
  it('reports active server use and allows reuse after deletion without a provider read', async () => {
    const mapping = async () =>
      (
        (await (await app.request('/v1/owner/runtime-mappings')).json()) as Array<{
          id: string;
          inUse: boolean;
        }>
      ).find((row) => row.id === f.mappingId);
    expect(await mapping()).toMatchObject({ inUse: false });
    const id = await f.server();
    expect(await mapping()).toMatchObject({ inUse: true });
    await f.db
      .updateTable('managed_servers')
      .set({ deleted_at: new Date() })
      .where('id', '=', id)
      .execute();
    expect(await mapping()).toMatchObject({ inUse: false });
    expect(management).not.toHaveBeenCalled();
  });
});
