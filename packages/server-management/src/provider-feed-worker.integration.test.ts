import { randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ProviderChange } from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { providerCredentialBinding } from './provider-capabilities.js';
import {
  applyProviderChange,
  cachedProviderStartLimits,
  linkProviderFeedServer,
  refreshLinkedProviderSnapshots,
} from './provider-change-feed.js';
import { refreshProviderFeeds } from './provider-feed-worker.js';
import { createManagementRuntime } from './runtime.js';
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
  const scenario = {
    batch,
    pending: 0,
    scoped: false,
    failedLinks: new Map<string, number>(),
    pendingScopes: new Set<string>(),
    beforeBatch: async () => {},
    beforeHealth: async () => {},
  };
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
        ...(scenario.scoped
          ? {
              scopes: (new URL(String(input)).searchParams.get('scopes')?.split(',') ?? []).flatMap(
                (id) => {
                  const entry = entries.get(id);
                  return entry
                    ? [
                        {
                          providerUuid: id,
                          ownerId: 7,
                          revision: entry.revision,
                          valid: entry.type !== 'identity.invalidated',
                          pending: scenario.pendingScopes.has(id),
                        },
                      ]
                    : [];
                },
              ),
            }
          : {}),
        lastDeliveredAt: null,
        checkedAt: new Date().toISOString(),
      });
    }
    const id = path.split('/').at(-1);
    const found = id && entries.get(id);
    if (id && init?.method === 'PUT' && scenario.failedLinks.has(id))
      return new Response(null, { status: scenario.failedLinks.get(id) });
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
  const cached = (e: ProviderChange) =>
    cachedProviderStartLimits(
      db,
      e.server.externalId,
      url,
      new Date(),
      providerCredentialBinding(url, 'fixture'),
    );
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

it('serves 19 proved scopes despite an unrelated outbox row, and repairs a missed webhook', async () => {
  const f = await setup(19, true);
  f.scenario.scoped = true;
  f.scenario.pending = 1;
  await f.refresh();
  expect(f.calls()).toEqual(['GET capabilities', 'POST server-snapshots', 'GET health']);
  for (const event of f.snapshots) expect(await f.cached(event)).toEqual(event.limits);
  const [missed, pending, omitted, unaffected] = f.snapshots as [
    ProviderChange,
    ProviderChange,
    ProviderChange,
    ProviderChange,
  ];
  f.entries.set(missed.server.providerUuid, {
    ...missed,
    revision: 2,
    limits: { ...missed.limits, cpu: 17 },
  });
  f.scenario.pendingScopes.add(pending.server.providerUuid);
  f.entries.delete(omitted.server.providerUuid);
  f.fetcher.mockClear();
  await f.refresh();
  expect(f.calls()).toEqual(['GET health']);
  for (const event of [missed, pending, omitted]) expect(await f.cached(event)).toBeNull();
  expect(await f.cached(unaffected)).toEqual(unaffected.limits);
  f.fetcher.mockClear();
  await f.refresh();
  expect(f.calls()).toEqual(['POST server-snapshots', 'GET health']);
  expect(await f.cached(missed)).toEqual({ ...missed.limits, cpu: 17 });
  expect(await f.cached(omitted)).toBeNull();
  expect(await cachedProviderStartLimits(f.db, missed.server.externalId, url)).toBeNull();
  const delivered = { ...unaffected, revision: 2, type: 'limits.updated' as const };
  await applyProviderChange(f.db, delivered);
  expect(await f.cached(unaffected)).toBeNull();
  expect(await f.cached(missed)).toEqual({ ...missed.limits, cpu: 17 });
  expect(
    await cachedProviderStartLimits(
      f.db,
      missed.server.externalId,
      url,
      new Date(),
      'rotated-fixture',
    ),
  ).toBeNull();
  await f.db
    .updateTable('managed_servers')
    .set({ provider_user_id: 8 })
    .where('id', '=', missed.server.externalId)
    .execute();
  expect(await f.cached(missed)).toBeNull();
  await f.refresh();
  expect(await f.cached(missed)).toBeNull();
  // A rollback to a legacy health contract must revoke the per-link proofs.
  f.scenario.scoped = false;
  await f.refresh();
  expect(await f.cached(missed)).toBeNull();
});

it.each([404, 409])(
  'backs off an initial %i durably, retries a changed binding immediately and clears recovered failure',
  async (status) => {
    const f = await setup(2, true);
    const first = f.snapshots[0];
    if (!first) throw new Error('missing fixture');
    const id = first.server.externalId;
    await f.db.deleteFrom('provider_server_projections').where('server_id', '=', id).execute();
    f.scenario.failedLinks.set(first.server.providerUuid, status);
    await f.refresh();
    const retries = () =>
      f.db
        .selectFrom('provider_feed_link_retries')
        .selectAll()
        .where('server_id', '=', id)
        .executeTakeFirst();
    const active = await retries();
    expect(active?.attempts).toBe(1);
    expect(active?.retry_at.getTime()).toBeGreaterThan(Date.now() + 50_000);
    f.fetcher.mockClear();
    await f.refresh();
    await f.refresh();
    expect(f.calls()).toEqual(['GET health', 'GET health']);
    await f.db
      .updateTable('provider_feed_link_retries')
      .set({ retry_at: new Date(0) })
      .where('server_id', '=', id)
      .execute();
    await f.refresh();
    expect((await retries())?.attempts).toBe(2);
    await f.db
      .updateTable('managed_servers')
      .set({ pterodactyl_identifier: 'newbind' })
      .where('id', '=', id)
      .execute();
    f.entries.set(first.server.providerUuid, {
      ...first,
      server: { ...first.server, identifier: 'newbind' },
    });
    f.scenario.failedLinks.delete(first.server.providerUuid);
    f.fetcher.mockClear();
    await f.refresh();
    expect(f.calls()).toEqual([`PUT ${first.server.providerUuid}`, 'GET health']);
    expect(await retries()).toBeUndefined();
    expect(await f.cached(first)).toEqual(first.limits);
  },
);

it.each([false, true])(
  'withdraws existing health locally when no target remains and denies a future link the old drain (scoped %s)',
  async (scoped) => {
    const f = await setup(1, true);
    const first = f.snapshots[0];
    if (!first) throw new Error('missing fixture');
    const id = first.server.externalId;
    f.scenario.scoped = scoped;
    await f.refresh();
    expect(await f.cached(first)).toEqual(first.limits);
    await f.db
      .updateTable('managed_servers')
      .set({ pterodactyl_id: null, pterodactyl_uuid: null, pterodactyl_identifier: null })
      .where('id', '=', id)
      .execute();
    f.fetcher.mockClear();
    await f.refresh('rotated');
    expect(f.calls()).toEqual([]);
    const feed = await f.db
      .selectFrom('provider_change_feeds')
      .select('healthy_at')
      .where('instance_id', '=', f.instanceId)
      .executeTakeFirstOrThrow();
    expect(feed.healthy_at).toBeNull();
    const proof = await f.db
      .selectFrom('provider_server_projections')
      .select('scope_healthy_at')
      .where('server_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(proof.scope_healthy_at).toBeNull();
    await f.db
      .updateTable('managed_servers')
      .set({
        pterodactyl_id: first.server.providerId,
        pterodactyl_uuid: first.server.providerUuid,
        pterodactyl_identifier: first.server.identifier,
      })
      .where('id', '=', id)
      .execute();
    await f.db.deleteFrom('provider_server_projections').where('server_id', '=', id).execute();
    await linkProviderFeedServer(f.db, f.instanceId, id, first);
    expect(await f.cached(first)).toBeNull();
  },
);

it.each(['link', 'batch'] as const)(
  'discards in-flight legacy health when a concurrent %s publishes a snapshot; keeps an independent scoped proof',
  async (source) => {
    const f = await setup(2, true);
    const [stable, changed] = f.snapshots as [ProviderChange, ProviderChange];
    const id = changed.server.externalId;
    f.scenario.scoped = true;
    await f.refresh();
    expect(await f.cached(stable)).toEqual(stable.limits);
    f.scenario.scoped = false;
    if (source === 'link') {
      await f.db.deleteFrom('provider_server_projections').where('server_id', '=', id).execute();
      f.scenario.failedLinks.set(changed.server.providerUuid, 409);
    }
    const next = { ...changed, revision: 2, occurredAt: new Date().toISOString() };
    f.scenario.beforeHealth = async () => {
      if (source === 'link') await linkProviderFeedServer(f.db, f.instanceId, id, next);
      else
        await refreshLinkedProviderSnapshots(
          f.db,
          f.instanceId,
          [{ id, providerUuid: changed.server.providerUuid, revision: '1' }],
          [next],
        );
    };
    await f.refresh();
    expect(await f.cached(stable)).toEqual(stable.limits);
    expect(await f.cached(changed)).toBeNull();
    f.scenario.beforeHealth = async () => {};
    await f.refresh();
    expect(await f.cached(changed)).toEqual(next.limits);
  },
);

it('coalesces API and worker discovery under one credential and preserves the original observation on reuse', async () => {
  const f = await setup(1, true);
  const env = { NH_PTERODACTYL_BASE_URL: url, NH_PTERODACTYL_APPLICATION_KEY: 'fixture' };
  const api = await createManagementRuntime({ db: f.db, codec, env });
  const stamp = vi.fn<(at: Date) => void>();
  await Promise.all([api.adapter.supportsGatewayInventory(stamp), f.refresh()]);
  expect(f.calls().filter((c) => c === 'GET capabilities')).toHaveLength(1);
  const original = stamp.mock.calls[0]?.[0];
  expect(original).toBeInstanceOf(Date);
  await api.adapter.supportsGatewayInventory(stamp);
  expect(stamp.mock.calls[1]?.[0]).toEqual(original);
  await database.pool.query(
    "update blueprint_capability_discovery set checked_at = clock_timestamp() - interval '61 seconds'",
  );
  await api.adapter.supportsGatewayInventory(stamp);
  expect(f.calls().filter((c) => c === 'GET capabilities')).toHaveLength(2);
  await f.refresh('rotated');
  expect(f.calls().filter((c) => c === 'GET capabilities')).toHaveLength(3);
});
