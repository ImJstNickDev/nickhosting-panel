import { randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ProviderChange } from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyProviderChange, cachedProviderStartLimits } from './provider-change-feed.js';
import { refreshProviderFeeds } from './provider-feed-worker.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const url = 'https://panel.example.test';
const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 2) } });
beforeEach(async () => {
  database = await createTestDatabase();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await database?.destroy();
});

async function setup(count: number, batch: boolean) {
  const db = database.db;
  const fixture = await managementFixture(db);
  const feed = await db
    .selectFrom('provider_change_feeds')
    .select('instance_id')
    .where('provider_url', '=', url)
    .executeTakeFirstOrThrow();
  const instanceId = feed.instance_id;
  const snapshots: ProviderChange[] = Array.from({ length: count }, (_, i) => ({
    schemaVersion: 1,
    eventId: randomUUID(),
    instanceId,
    type: 'snapshot',
    revision: 1,
    occurredAt: new Date().toISOString(),
    limits: { ...fixture.limits, threads: null },
    server: {
      providerId: i + 1,
      providerUuid: randomUUID(),
      externalId: randomUUID(),
      identifier: (i + 1).toString(16).padStart(8, '0'),
      nodeId: fixture.providerNodeId,
    },
  }));
  await db
    .insertInto('managed_servers')
    .values(
      snapshots.map(({ server }) => ({
        id: server.externalId,
        external_id: server.externalId,
        owner_id: fixture.context.subjectUserId,
        name: 'fixture',
        node_id: fixture.nodeId,
        mapping_id: fixture.mappingId,
        pterodactyl_id: server.providerId,
        pterodactyl_uuid: server.providerUuid,
        pterodactyl_identifier: server.identifier,
        provider_user_id: 7,
        limits: JSON.stringify(fixture.limits),
        installation_state: 'installed' as const,
        runtime_state: 'offline' as const,
        connection_mode: 'direct' as const,
      })),
    )
    .execute();
  const old = new Date(Date.now() - 90_000);
  await db
    .insertInto('provider_server_projections')
    .values(
      snapshots.map((event) => ({
        instance_id: instanceId,
        server_id: event.server.externalId,
        revision: '1',
        payload: { ...event, occurredAt: old.toISOString() },
        valid: true,
        identity_invalidated: false,
        synchronized_at: old,
      })),
    )
    .execute();
  const entries = new Map(snapshots.map((e) => [e.server.providerUuid, e]));
  const scenario = { batch, pending: 0, beforeBatch: async () => {}, beforeHealth: async () => {} };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/capabilities'))
      return Response.json({
        schemaVersion: 1,
        extension: 'nickhosting',
        extensionVersion: 'fixture',
        target: { panel: 'fixture', blueprint: 'fixture' },
        capabilities: {
          clientKeyManagement: true,
          serverChangeEvents: true,
          backupEvents: true,
          ...(scenario.batch ? { linkedServerSnapshots: true } : {}),
        },
      });
    expect(path).toContain(`/instances/${instanceId}/`);
    if (path.endsWith('/server-snapshots')) {
      const { serverUuids } = JSON.parse(String(init?.body)) as { serverUuids: string[] };
      await scenario.beforeBatch();
      return Response.json({
        schemaVersion: 1,
        instanceId,
        servers: serverUuids.flatMap((id) => entries.get(id) ?? []).reverse(),
      });
    }
    if (path.endsWith('/health')) {
      await scenario.beforeHealth();
      return Response.json({
        schemaVersion: 1,
        instanceId,
        pendingEvents: scenario.pending,
        lastDeliveredAt: null,
        checkedAt: new Date().toISOString(),
      });
    }
    const id = path.split('/').at(-1);
    const found = id && entries.get(id);
    if (found && init?.method === 'PUT')
      expect(JSON.parse(String(init.body))).toEqual({ ...found.server, expectedOwnerId: 7 });
    return found ? Response.json(found) : new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  const calls = () =>
    fetcher.mock.calls.map(([input, init]) =>
      [init?.method, new URL(String(input)).pathname.split('/').at(-1)].join(' '),
    );
  const refresh = (key = 'fixture') =>
    refreshProviderFeeds(db, codec, {
      NH_PTERODACTYL_BASE_URL: url,
      NH_PTERODACTYL_APPLICATION_KEY: key,
    });
  const cached = (e: ProviderChange) => cachedProviderStartLimits(db, e.server.externalId, url);
  return { db, entries, snapshots, instanceId, fetcher, calls, refresh, cached, scenario };
}

it.each([
  [19, 1],
  [101, 2],
])(
  'refreshes %i linked servers in %i bounded HTTP batches and skips fresh projections',
  async (count, expected) => {
    const f = await setup(count, true);
    await f.refresh();
    expect(f.calls()).toEqual([
      'GET capabilities',
      ...Array(expected).fill('POST server-snapshots'),
      'GET health',
    ]);
    const last = f.snapshots.at(-1);
    if (!last) throw new Error('Missing test server');
    expect(await f.cached(last)).toEqual(last.limits);
    f.fetcher.mockClear();
    await f.refresh();
    expect(f.calls()).toEqual(['GET health']);
    f.fetcher.mockClear();
    await f.refresh('rotated-key');
    expect(f.calls()).toEqual(['GET capabilities', 'GET health']);
  },
);

it('uses individual GETs with an older extension and PUTs only an unlinked identity', async () => {
  const f = await setup(19, false);
  const first = f.snapshots[0];
  if (!first) throw new Error('Missing test server');
  await f.db
    .deleteFrom('provider_server_projections')
    .where('server_id', '=', first.server.externalId)
    .execute();
  await f.refresh();
  expect(f.calls().filter((c) => c.startsWith('PUT '))).toEqual([
    `PUT ${first.server.providerUuid}`,
  ]);
  expect(f.calls().filter((c) => c.startsWith('GET '))).toHaveLength(20);
  expect(f.calls()).not.toContain('POST server-snapshots');
  expect(await f.cached(first)).toEqual(first.limits);
});

it('isolates omissions and invalidations, preserves a newer webhook, and keeps the outbox fence', async () => {
  const f = await setup(4, true);
  const [ok, missing, invalid, racing] = f.snapshots as [
    ProviderChange,
    ProviderChange,
    ProviderChange,
    ProviderChange,
  ];
  f.entries.delete(missing.server.providerUuid);
  f.entries.set(invalid.server.providerUuid, {
    ...invalid,
    revision: 2,
    type: 'identity.invalidated',
  });
  f.entries.delete(racing.server.providerUuid);
  const change: ProviderChange = {
    ...racing,
    eventId: randomUUID(),
    revision: 2,
    type: 'limits.updated',
    limits: { ...racing.limits, cpu: 14 },
  };
  f.scenario.beforeBatch = async () => {
    await applyProviderChange(f.db, change);
  };
  f.scenario.pending = 1;
  await f.refresh();
  expect(await f.cached(ok)).toBeNull();
  f.scenario.pending = 0;
  f.scenario.beforeBatch = async () => {};
  await f.refresh();
  expect(await f.cached(ok)).toEqual(ok.limits);
  expect(await f.cached(missing)).toBeNull();
  expect(await f.cached(invalid)).toBeNull();
  expect(await f.cached(racing)).toEqual(change.limits);
  f.scenario.beforeHealth = async () => {
    await applyProviderChange(f.db, {
      ...ok,
      eventId: randomUUID(),
      revision: 2,
      type: 'limits.updated',
    });
  };
  await f.refresh();
  expect(await f.cached(ok)).toBeNull();
});
