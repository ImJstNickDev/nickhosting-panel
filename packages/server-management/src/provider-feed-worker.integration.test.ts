import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { GatewayHeartbeatRequest, ProviderChange } from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
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

/** Count requests accepted by an isolated HTTP listener behind real adapters.
 * The worker and Gateway share only their ordinary PostgreSQL state. */
async function heartbeatFixture(count: number) {
  const f = await setup(count, true);
  vi.unstubAllGlobals();
  const routes: string[] = [];
  const batches: GatewayHeartbeatRequest[] = [];
  const principals: string[] = [];
  const state = {
    shape: 'ok' as 'ok' | 'wrong-instance' | 'denied' | 'old' | 'omitted',
    version: '1.11.0',
    snapshotError: undefined as number | undefined,
  };
  const receipt = { epoch: randomUUID(), revision: '1', digest: 'a'.repeat(64) };
  f.scenario.scoped = true;
  const server = createServer(async (req, res) => {
    const endpoint = new URL(req.url ?? '/', url);
    const route = endpoint.pathname.split('/').at(-1) ?? '';
    routes.push(route);
    principals.push(req.headers.authorization ?? '');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const discovery = {
      schemaVersion: 1,
      extension: 'nickhosting',
      extensionVersion: state.version,
      target: { panel: 'fixture', blueprint: 'fixture' },
      capabilities: {
        clientKeyManagement: true,
        serverChangeEvents: true,
        linkedServerSnapshots: true,
        gatewayInventory: true,
        backupEvents: true,
      },
      worldReadPrincipal: 'b'.repeat(64),
    };
    let response: unknown;
    if (route === 'revision') {
      const input = JSON.parse(body) as { coordinated?: GatewayHeartbeatRequest };
      const request = input.coordinated;
      const coordinated: Record<string, unknown> = {};
      if (request) {
        batches.push(request);
        const checkedAt = new Date(state.shape === 'old' ? Date.now() - 45000 : Date.now())
          .toISOString()
          .replace('Z', '123Z');
        if (request.health)
          coordinated.health =
            state.shape === 'denied'
              ? { error: 403 }
              : {
                  value: {
                    schemaVersion: 1,
                    instanceId: state.shape === 'wrong-instance' ? randomUUID() : f.instanceId,
                    checkedAt,
                    scopes: request.health.flatMap((uuid) => {
                      const event = f.entries.get(uuid);
                      return event
                        ? [
                            {
                              providerUuid: uuid,
                              ownerId: 7,
                              revision: event.revision,
                              valid: true,
                              pending: f.scenario.pendingScopes.has(uuid),
                            },
                          ]
                        : [];
                    }),
                  },
                };
        if (request.snapshots)
          coordinated.snapshots = state.snapshotError
            ? { error: state.snapshotError }
            : {
                value: {
                  schemaVersion: 1,
                  instanceId: f.instanceId,
                  servers: request.snapshots.flatMap((id) => f.entries.get(id) ?? []),
                },
              };
        if (request.capabilities)
          coordinated.capabilities = { value: { checkedAt, extension: discovery } };
      }
      response = { ...receipt, waitedMs: 0, ...(state.shape === 'omitted' ? {} : { coordinated }) };
    } else if (route === 'capabilities') response = discovery;
    else {
      const passthrough = await f.fetcher(endpoint.href, {
        method: req.method,
        ...(body ? { body } : {}),
      });
      res.statusCode = passthrough.status;
      response = await passthrough.json();
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(async () => {
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing isolated port');
  const origin = `http://127.0.0.1:${address.port}`;
  const env = { NH_PTERODACTYL_BASE_URL: origin, NH_PTERODACTYL_APPLICATION_KEY: 'fixture' };
  await f.db
    .updateTable('provider_change_feeds')
    .set({ provider_url: origin })
    .where('instance_id', '=', f.instanceId)
    .execute();
  const api = await createManagementRuntime({ db: f.db, codec, env });
  const prepare = async () => {
    const plan = await api.prepareGatewayHeartbeat?.();
    if (!plan || !api.adapter.gatewayTopology) throw new Error('missing heartbeat plan');
    const result = await api.adapter.gatewayTopology.revision(receipt, [], [], 0, plan.request);
    return { plan, sections: result.coordinated };
  };
  const refresh = (key = 'fixture') =>
    refreshProviderFeeds(f.db, codec, { ...env, NH_PTERODACTYL_APPLICATION_KEY: key });
  const cached = (event: ProviderChange) =>
    cachedProviderStartLimits(
      f.db,
      event.server.externalId,
      origin,
      new Date(),
      providerCredentialBinding(origin, 'fixture'),
    );
  const tick = async (intervalMs: number) => {
    const plan = await api.prepareGatewayHeartbeat?.(intervalMs);
    if (!api.adapter.gatewayTopology) throw new Error('missing topology');
    const result = await api.adapter.gatewayTopology.revision(receipt, [], [], 0, plan?.request);
    await plan?.accept(result.coordinated);
  };
  return { ...f, api, prepare, tick, refresh, cached, routes, batches, principals, state };
}

it('serves due feed work and discovery on the existing HTTP heartbeat with zero standalone worker reads', async () => {
  const f = await heartbeatFixture(19);
  const first = f.snapshots[0];
  if (!first) throw new Error('missing test server');
  await f.db
    .updateTable('provider_server_projections')
    .set({ synchronized_at: new Date() })
    .where('server_id', '!=', first.server.externalId)
    .execute();
  expect(await f.api.adapter.supportsGatewayInventory()).toBe(true);
  expect(f.routes.splice(0)).toEqual(['capabilities']);
  // The cache watermark uses the same millisecond precision as discovery().
  await database.pool.query(
    "update blueprint_capability_discovery set checked_at=date_trunc('milliseconds',clock_timestamp())-interval '48 seconds'",
  );
  const { plan, sections } = await f.prepare();
  await plan.accept(sections);
  expect(f.batches[0]?.health).toHaveLength(19);
  expect(f.batches[0]?.snapshots).toEqual([first.server.providerUuid]);
  expect(f.batches[0]?.capabilities).toBe(true);
  const observed = sections?.capabilities?.checkedAt;
  const { rows } = await database.pool.query(
    "select checked_at,extension->>'worldReadPrincipal' as principal from blueprint_capability_discovery",
  );
  if (!observed) throw new Error('missing capability receipt');
  expect(rows[0]).toEqual({ checked_at: new Date(observed), principal: 'b'.repeat(64) });
  await f.refresh();
  expect(f.routes).toEqual(['revision']);
  expect(new Set(f.principals)).toEqual(new Set(['Bearer fixture']));
  expect(await f.cached(first)).toEqual(first.limits);
  expect(await f.api.prepareGatewayHeartbeat?.()).toBeUndefined();
  // Dead/inactive Gateway: no renewal from local reads and no waiting for a poll.
  await database.pool.query(
    "update gateway_feed_heartbeat set checked_at=clock_timestamp()-interval '31 seconds'",
  );
  await f.refresh();
  expect(f.routes).toEqual(['revision', 'health']);
});

it.each([1, 7])('counts the steady 60s wire window with a worker offset of %is', async (offset) => {
  const f = await heartbeatFixture(19);
  await f.api.adapter.supportsGatewayInventory();
  await f.tick(4000);
  f.routes.length = 0;
  f.batches.length = 0;
  // Shift stored observation clocks instead of sleeping. Each scheduled poll
  // uses the real adapter and HTTP listener, including the 15th at t=60.
  for (let t = 1; t <= 60; t++) {
    await database.pool.query(`
      update provider_server_projections set synchronized_at=synchronized_at-interval '1 second',
        scope_healthy_at=scope_healthy_at-interval '1 second';
      update gateway_feed_heartbeat set requested_at=requested_at-interval '1 second', checked_at=checked_at-interval '1 second';
      update blueprint_capability_discovery set checked_at=checked_at-interval '1 second'`);
    if (t % 4 === 0) await f.tick(4000);
    if (t % 15 === offset) await f.refresh();
  }
  expect(f.routes).toEqual(Array(15).fill('revision'));
  expect(f.batches.filter((work) => work.capabilities)).toHaveLength(1);
  expect(f.batches.filter((work) => work.snapshots).map((work) => work.snapshots?.length)).toEqual([
    19,
  ]);
});

it('rotates bounded chunks fairly and immediately falls back for the missing HTTP scope', async () => {
  const f = await heartbeatFixture(101);
  await f.db
    .updateTable('provider_server_projections')
    .set({ synchronized_at: new Date() })
    .execute();
  await f.api.adapter.supportsGatewayInventory();
  f.routes.length = 0;
  const first = await f.prepare();
  await first.plan.accept(first.sections);
  expect(first.plan.request.health).toHaveLength(100);
  expect(first.plan.request.snapshots).toBeUndefined();
  await f.refresh();
  expect(f.routes).toEqual(['revision', 'health']);
  expect(
    new URL(String(f.fetcher.mock.calls.at(-1)?.[0])).searchParams.get('scopes')?.split(','),
  ).toHaveLength(1);
  const second = await f.prepare();
  expect(second.plan.request.health).toHaveLength(1);
  expect(first.plan.request.health).not.toContain(second.plan.request.health?.[0]);
  await second.plan.accept(second.sections);
  await f.refresh();
  expect(f.routes).toEqual(['revision', 'health', 'revision']);
});

it('withdraws refused, stale, malformed and absent heartbeat sections and retains independent discovery', async () => {
  const f = await heartbeatFixture(1);
  const first = f.snapshots[0];
  if (!first) throw new Error('missing test server');
  await f.api.adapter.supportsGatewayInventory();
  await f.refresh();
  for (const shape of ['denied', 'old', 'wrong-instance', 'omitted'] as const) {
    f.state.shape = shape;
    await database.pool.query(
      "update gateway_feed_heartbeat set requested_at=clock_timestamp()-interval '20 seconds'",
    );
    const { plan, sections } = await f.prepare();
    await plan.accept(sections);
    expect(await f.cached(first)).toBeNull();
    await f.refresh();
    expect(f.routes.slice(-2)).toEqual(['revision', 'health']);
    expect(await f.cached(first)).toEqual(first.limits);
  }
});

it('withdraws only the refused snapshot on native 409, triggers early independent repair, and fences a stale refusal', async () => {
  const f = await heartbeatFixture(2);
  const [due, stable] = f.snapshots as [ProviderChange, ProviderChange];
  const id = due.server.externalId;
  await f.api.adapter.supportsGatewayInventory();
  await f.refresh();
  const dueSoon = () =>
    f.db
      .updateTable('provider_server_projections')
      .set({ synchronized_at: new Date(Date.now() - 53000) })
      .where('server_id', '=', id)
      .execute();
  await dueSoon();
  expect(await f.cached(due)).toEqual(due.limits);
  f.state.snapshotError = 409;
  const denied = await f.prepare();
  expect(denied.plan.request.snapshots).toEqual([due.server.providerUuid]);
  await denied.plan.accept(denied.sections);
  expect(await f.cached(due)).toBeNull();
  expect(await f.cached(stable)).toEqual(stable.limits);
  f.routes.length = 0;
  await f.refresh();
  expect(f.routes).toEqual(['server-snapshots', 'health']);
  expect(await f.cached(due)).toEqual(due.limits);
  await dueSoon();
  await database.pool.query(
    "update gateway_feed_heartbeat set requested_at=clock_timestamp()-interval '20 seconds'",
  );
  const stale = await f.prepare();
  const changed = { ...due, revision: 2, type: 'limits.updated' as const };
  await applyProviderChange(f.db, changed);
  await stale.plan.accept(stale.sections);
  expect(
    await f.db
      .selectFrom('provider_server_projections')
      .select(['revision', 'valid'])
      .where('server_id', '=', id)
      .executeTakeFirst(),
  ).toEqual({ revision: '2', valid: true });
});

it('preserves a scope across telemetry but rejects an owner change restored before heartbeat completion', async () => {
  const f = await heartbeatFixture(2);
  const [stable, changed] = f.snapshots as [ProviderChange, ProviderChange];
  await f.api.adapter.supportsGatewayInventory();
  const { plan, sections } = await f.prepare();
  await f.db
    .updateTable('managed_servers')
    .set({ runtime_state: 'running' })
    .where('id', '=', stable.server.externalId)
    .execute();
  for (const owner of [9, 7])
    await f.db
      .updateTable('managed_servers')
      .set({ provider_user_id: owner })
      .where('id', '=', changed.server.externalId)
      .execute();
  await plan.accept(sections);
  expect(await f.cached(stable)).toEqual(stable.limits);
  expect(await f.cached(changed)).toBeNull();
});

it('fences a heartbeat when webhook generation, standalone result or discovery credential supersedes it', async () => {
  const f = await heartbeatFixture(1);
  const first = f.snapshots[0];
  if (!first) throw new Error('missing test server');
  await f.api.adapter.supportsGatewayInventory();
  const { plan, sections } = await f.prepare();
  await applyProviderChange(f.db, {
    ...first,
    eventId: randomUUID(),
    revision: 2,
    type: 'limits.updated',
  });
  await plan.accept(sections);
  expect(await f.cached(first)).toBeNull();
  f.entries.set(first.server.providerUuid, {
    ...first,
    revision: 2,
    occurredAt: new Date().toISOString(),
  });
  await f.refresh();
  expect(await f.cached(first)).toEqual(first.limits);
  await database.pool.query(
    "update gateway_feed_heartbeat set requested_at=clock_timestamp()-interval '20 seconds'",
  );
  const pending = await f.prepare();
  await f.refresh();
  await pending.plan.accept(undefined);
  expect(await f.cached(first)).toEqual(first.limits);
  await database.pool.query(
    "update gateway_feed_heartbeat set requested_at=clock_timestamp()-interval '20 seconds'",
  );
  const old = await f.prepare();
  await f.refresh('rotated');
  await old.plan.accept(old.sections);
  expect(await f.cached(first)).toBeNull();
  f.state.version = '1.10.0';
  await f.refresh('legacy');
  expect(await f.api.prepareGatewayHeartbeat?.()).toBeUndefined();
});
