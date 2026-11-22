import { randomBytes, randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createDatabase } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  type ApplicationServer,
  createPterodactylAdapter,
  type Resources,
} from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pollFleet } from '../../../apps/worker/src/reconcile.js';
import { createManagementRuntime } from './runtime.js';
import { managementFixture } from './test-fixtures.js';

const offline: Resources = {
  current_state: 'offline',
  is_suspended: false,
  resources: {
    memory_bytes: 0,
    cpu_absolute: 0,
    disk_bytes: 10,
    network_rx_bytes: 0,
    network_tx_bytes: 0,
    uptime: 0,
  },
};

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeEach(async () => {
  database = await createTestDatabase();
});
afterEach(async () => database?.destroy());

async function fleet(count: number, afterRead?: (row: object | undefined) => void) {
  const f = await managementFixture(database.db);
  const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
  const servers = f.inventory.slice(0, count).map((allocation, index) => {
    const localId = randomUUID();
    const uuid = randomUUID();
    const remote: ApplicationServer = {
      id: index + 1,
      uuid,
      identifier: (index + 1).toString(16).padStart(8, '0'),
      name: 'Fixture',
      external_id: localId,
      description: null,
      suspended: false,
      limits: f.limits,
      feature_limits: { allocations: 1, databases: 0, backups: 1 },
      node: f.providerNodeId,
      user: 1,
      allocation: allocation.id,
      nest: 1,
      egg: 1,
      container: { installed: true, startup_command: 'fixture', image: 'fixture:1' },
      relationships: {
        allocations: { object: 'list', data: [{ attributes: { ...allocation, assigned: true } }] },
      },
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    return { localId, allocation, remote };
  });
  await f.db
    .insertInto('managed_servers')
    .values(
      servers.map(({ localId, remote }) => ({
        id: localId,
        name: remote.name,
        owner_id: f.context.subjectUserId,
        mapping_id: f.mappingId,
        node_id: f.nodeId,
        external_id: localId,
        provider_user_id: remote.user,
        pterodactyl_id: remote.id,
        pterodactyl_uuid: remote.uuid,
        pterodactyl_identifier: remote.identifier,
        limits: JSON.stringify(remote.limits),
        installation_state: 'installed' as const,
        runtime_state: 'offline' as const,
        connection_mode: 'direct' as const,
      })),
    )
    .execute();
  await f.db
    .insertInto('server_allocations')
    .values(
      servers.map(({ localId, allocation }) => ({
        id: randomUUID(),
        server_id: localId,
        node_id: f.nodeId,
        pterodactyl_allocation_id: allocation.id,
        address: allocation.ip,
        backend_address: allocation.ip,
        port: allocation.port,
        role: 'game',
        protocols: ['udp'],
        is_primary: true,
      })),
    )
    .execute();

  const list = vi.fn(async (uuids: string[]) => {
    const data = servers.filter(({ remote }) => uuids.includes(remote.uuid)).reverse();
    return Response.json({
      object: 'list',
      data: data.map(({ remote }) => ({ attributes: remote })),
    });
  });
  const detail = vi.fn(async (id: number) => {
    const match = servers.find(({ remote }) => remote.id === id);
    return match
      ? Response.json({ attributes: match.remote })
      : new Response(null, { status: 404 });
  });
  const adapter = createPterodactylAdapter({
    baseURL: 'https://panel.example.test',
    applicationKey: 'isolated',
    fetcher: async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('include')).toBe('allocations');
      const match = /^\/api\/application\/servers\/(\d+)$/.exec(url.pathname);
      if (match) return detail(Number(match[1]));
      expect(url.pathname).toBe('/api/application/servers');
      return list((url.searchParams.get('filter[uuid]') ?? '').split(','));
    },
  });
  const individual = vi.spyOn(adapter, 'getApplicationServer');
  const batches = vi.spyOn(adapter, 'getApplicationServers');
  const resources = vi.spyOn(adapter, 'getResources').mockResolvedValue(offline);
  const db = afterRead
    ? f.db.withPlugin({
        transformQuery: ({ node }) => node,
        async transformResult({ result }) {
          afterRead(result.rows[0]);
          return result;
        },
      })
    : f.db;
  const runtime = await createManagementRuntime({
    db,
    codec,
    adapter,
    reconcileExternal: async () => ({ recovered: 0, failed: 0 }),
  });
  return { db: f.db, servers, list, detail, individual, batches, resources, runtime };
}

it.each([
  [19, 1],
  [100, 3],
])('observes %i servers with %i HTTP identity reads', async (count, requests) => {
  const f = await fleet(count);
  expect(await f.runtime.reconcile()).toMatchObject({
    observed: count,
    deferred: [],
    unavailable: [],
  });
  expect(f.list).toHaveBeenCalledTimes(requests);
  expect(f.list.mock.calls.flatMap(([uuids]) => uuids).sort()).toEqual(
    f.servers.map(({ remote }) => remote.uuid).sort(),
  );
  expect(f.individual).not.toHaveBeenCalled();
  expect(f.resources.mock.calls.map(([id]) => id).sort()).toEqual(
    f.servers.map(({ remote }) => remote.identifier).sort(),
  );
  expect(await f.db.selectFrom('server_metrics').select('server_id').execute()).toHaveLength(count);
});

it('isolates missing and reassigned provider identities and rejects local revisions changed during the batch', async () => {
  const f = await fleet(4);
  const [missing, foreign, changed, valid] = f.servers;
  if (!missing || !foreign || !changed || !valid) throw new Error('fixture incomplete');
  f.list.mockImplementationOnce(async () => {
    for (const name of ['intermediate', changed.remote.name]) {
      await f.db
        .updateTable('managed_servers')
        .set({ name })
        .where('id', '=', changed.localId)
        .execute();
    }
    return Response.json({
      object: 'list',
      data: [
        valid.remote,
        { ...foreign.remote, user: foreign.remote.user + 1 },
        changed.remote,
      ].map((attributes) => ({ attributes })),
    });
  });
  const result = await f.runtime.reconcile();
  expect(result.observed).toBe(1);
  expect(result.deferred).toEqual([changed.localId]);
  expect(result.unavailable.sort()).toEqual([missing.localId, foreign.localId].sort());
  expect(f.resources).not.toHaveBeenCalledWith(missing.remote.identifier);
  expect(f.resources).not.toHaveBeenCalledWith(foreign.remote.identifier);
  expect(f.resources).not.toHaveBeenCalledWith(changed.remote.identifier);
  expect(f.individual).not.toHaveBeenCalled();
  expect(await f.db.selectFrom('server_metrics').select('server_id').execute()).toEqual([
    { server_id: valid.localId },
  ]);
});

it.each(['stable', 'changed again', 'rate limited'] as const)(
  'refreshes one queued identity exactly once when its revision changes after the provider batch: %s',
  async (outcome) => {
    const f = await fleet(2);
    let queued: (typeof f.servers)[number] | undefined;
    let freshIdentityRead = false;
    f.resources.mockImplementation(async (identifier) => {
      if (!queued) {
        queued = f.servers.find(({ remote }) => remote.identifier !== identifier);
        if (!queued) throw new Error('fixture incomplete');
        // Change the second server after provider I/O but before the worker reaches it.
        await f.db
          .updateTable('managed_servers')
          .set({ name: 'Changed in queue' })
          .where('id', '=', queued.localId)
          .execute();
      }
      return {
        ...offline,
        resources: { ...offline.resources, disk_bytes: freshIdentityRead ? 200 : 100 },
      };
    });
    f.detail.mockImplementationOnce(async (id) => {
      if (!queued || queued.remote.id !== id) throw new Error('unexpected individual read');
      if (outcome === 'rate limited')
        return new Response(null, { status: 429, headers: { 'Retry-After': '5' } });
      if (outcome === 'changed again') {
        await f.db
          .updateTable('managed_servers')
          .set({ name: 'Changed during recovery' })
          .where('id', '=', queued.localId)
          .execute();
      }
      freshIdentityRead = true;
      return Response.json({ attributes: queued.remote });
    });
    const result = await f.runtime.reconcile();
    if (!queued) throw new Error('expected a queued server');
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.detail).toHaveBeenCalledExactlyOnceWith(queued.remote.id);
    const saved = await f.db
      .selectFrom('server_metrics')
      .select(['server_id', 'disk_bytes'])
      .execute();
    expect(
      saved.filter((row) => row.server_id !== queued?.localId).map((row) => row.disk_bytes),
    ).toEqual(['100']);
    if (outcome === 'stable') {
      expect(result).toMatchObject({ observed: 2, unavailable: [], deferred: [] });
      expect(f.resources).toHaveBeenCalledTimes(2);
      expect(saved.filter((row) => row.server_id === queued?.localId)).toEqual([
        { server_id: queued.localId, disk_bytes: '200' },
      ]);
    } else {
      expect(result.observed).toBe(1);
      expect(result.deferred).toEqual(outcome === 'changed again' ? [queued.localId] : []);
      expect(result.unavailable).toEqual(outcome === 'rate limited' ? [queued.localId] : []);
      expect(saved).toHaveLength(1);
    }
  },
);

it('stops the sweep when the Application API rate limits the grouped read', async () => {
  const f = await fleet(100);
  f.list.mockResolvedValueOnce(
    new Response(null, { status: 429, headers: { 'Retry-After': '5' } }),
  );
  const result = await f.runtime.reconcile();
  expect(result.observed).toBe(0);
  expect(result.unavailable.sort()).toEqual(f.servers.map((s) => s.localId).sort());
  expect(f.list).toHaveBeenCalledTimes(1);
  expect(f.batches).toHaveBeenCalledTimes(1);
  expect(f.resources).not.toHaveBeenCalled();
  expect(f.individual).not.toHaveBeenCalled();
  expect(await f.db.selectFrom('server_metrics').select('server_id').execute()).toEqual([]);
});

it('continues with the next group after a provider outage without retrying each server', async () => {
  const f = await fleet(49);
  f.list.mockResolvedValueOnce(new Response(null, { status: 503 }));
  const result = await f.runtime.reconcile();
  const first = new Set(f.list.mock.calls[0]?.[0]);
  expect(result.unavailable.sort()).toEqual(
    f.servers
      .filter(({ remote }) => first.has(remote.uuid))
      .map((server) => server.localId)
      .sort(),
  );
  expect(result.observed).toBe(1);
  expect(f.individual).not.toHaveBeenCalled();
  expect(f.resources).toHaveBeenCalledTimes(1);
});

it('isolates a persistently malformed server while observing its peers and the next group', async () => {
  const f = await fleet(49);
  const normalList = f.list.getMockImplementation();
  if (!normalList) throw new Error('fixture incomplete');
  f.list.mockImplementationOnce(async (uuids) => {
    const bad = f.servers.find((s) => s.remote.uuid === uuids[0]);
    if (!bad) throw new Error('fixture incomplete');
    // The same malformed row is returned by the grouped and individual HTTP routes.
    bad.remote.nest = 0;
    return normalList(uuids);
  });
  const result = await f.runtime.reconcile();
  const bad = f.servers.find((s) => s.remote.nest === 0);
  expect(result.unavailable).toEqual([bad?.localId]);
  expect(result.observed).toBe(48);
  expect(f.list.mock.calls.length).toBeLessThanOrEqual(14);
  expect(f.detail).not.toHaveBeenCalled();
  expect(f.resources).toHaveBeenCalledTimes(48);
  expect(f.resources).not.toHaveBeenCalledWith(bad?.remote.identifier);
  if (!bad) throw new Error('fixture incomplete');
  await f.db
    .updateTable('fleet_reconciliation_retries')
    .set({ retry_at: new Date(0) })
    .execute();
  expect((await f.runtime.reconcile()).unavailable).toEqual([bad.localId]);
  expect(f.detail).toHaveBeenCalledExactlyOnceWith(bad.remote.id);
  expect(
    await f.db.selectFrom('fleet_reconciliation_retries').select('read_detail').execute(),
  ).toEqual([{ read_detail: false }]);
  // A detail which is also broken cannot strand the member when its filter recovers.
  bad.remote.nest = 1;
  await f.db
    .updateTable('fleet_reconciliation_retries')
    .set({ retry_at: new Date(0) })
    .execute();
  expect((await f.runtime.reconcile()).observed).toBe(49);
  expect(f.detail).toHaveBeenCalledTimes(1);
});

it('fences a local ABA change during a subdivision before reading Client resources', async () => {
  const f = await fleet(4);
  const normalList = f.list.getMockImplementation();
  if (!normalList) throw new Error('fixture incomplete');
  let changed: (typeof f.servers)[number] | undefined;
  f.list.mockResolvedValueOnce(Response.json({ object: 'list', data: [{}] }));
  f.list.mockImplementationOnce(async (ids) => {
    changed = f.servers.find((s) => s.remote.uuid === ids[0]);
    if (!changed) throw new Error('fixture incomplete');
    const response = await normalList(ids);
    for (const name of ['intermediate', changed.remote.name]) {
      await f.db
        .updateTable('managed_servers')
        .set({ name })
        .where('id', '=', changed.localId)
        .execute();
    }
    return response;
  });
  const result = await f.runtime.reconcile();
  expect(f.list.mock.calls.map(([ids]) => ids.length)).toEqual([4, 2, 2]);
  expect(result).toMatchObject({ observed: 3, deferred: [changed?.localId], unavailable: [] });
  expect(f.resources).not.toHaveBeenCalledWith(changed?.remote.identifier);
  expect(f.detail).not.toHaveBeenCalled();
});

it('stops subdivision at an Application 429 without individual reads', async () => {
  const f = await fleet(48);
  f.list.mockResolvedValueOnce(Response.json({ object: 'list', data: [{}] }));
  f.list.mockResolvedValueOnce(
    new Response(null, { status: 429, headers: { 'Retry-After': '5' } }),
  );
  const result = await f.runtime.reconcile();
  expect(result.observed).toBe(0);
  expect(result.unavailable.sort()).toEqual(f.servers.map(({ localId }) => localId).sort());
  expect(f.list.mock.calls.map(([uuids]) => uuids.length)).toEqual([48, 24]);
  expect(f.detail).not.toHaveBeenCalled();
  expect(f.resources).not.toHaveBeenCalled();
});

it('bounds widespread malformed responses and resumes unfinished subdivisions on later sweeps', async () => {
  const f = await fleet(48);
  const normalList = f.list.getMockImplementation();
  if (!normalList) throw new Error('fixture incomplete');
  // A legacy provider accepts at most one UUID in this filter.
  f.list.mockImplementation(async (ids) =>
    ids.length > 1
      ? Response.json({
          object: 'list',
          data: [],
          meta: { pagination: { current_page: 1, total_pages: 999 } },
        })
      : normalList(ids),
  );
  const recovered = new Set<string>();
  for (let tick = 0; tick < 16 && recovered.size < 48; tick++) {
    f.list.mockClear();
    f.resources.mockClear();
    await f.runtime.reconcile();
    expect(f.list.mock.calls.length).toBeLessThanOrEqual(13);
    for (const [id] of f.resources.mock.calls) recovered.add(id);
  }
  expect(recovered.size).toBe(48);
  expect(f.detail).not.toHaveBeenCalled();
});

it('observes transitions and Gateway wakes before stable members that have never been sampled', async () => {
  const f = await fleet(49);
  const transitioning = f.servers[47];
  const waking = f.servers[48];
  if (!transitioning || !waking) throw new Error('fixture incomplete');
  await f.db
    .updateTable('managed_servers')
    .set({ last_observed_at: new Date() })
    .where('id', 'in', [transitioning.localId, waking.localId])
    .execute();
  await f.db
    .updateTable('managed_servers')
    .set({ runtime_state: 'starting' })
    .where('id', '=', transitioning.localId)
    .execute();
  await database.pool.query(
    `insert into gateway_server_states
    (server_id,generation,enabled,protocol_id,game_version,state,readiness_timeout_seconds,readiness_max_age_seconds,estimate_max_age_seconds,wake_retry_seconds)
    values ($1,gen_random_uuid(),true,'fixture','1','waking',30,15,60,1)`,
    [waking.localId],
  );
  await f.runtime.reconcile();
  expect(
    f.resources.mock.calls
      .slice(0, 2)
      .map(([identifier]) => identifier)
      .sort(),
  ).toEqual([transitioning.remote.identifier, waking.remote.identifier].sort());
});

it.each(['batch revision', 'member identity'] as const)(
  'refreshes an expired provider identity after waiting for the %s query',
  async (stage) => {
    let elapsed = 0;
    let reassign: (() => void) | undefined;
    const f = await fleet(1, (row) => {
      if (!reassign || !row || !('revision' in row)) return;
      // These are the two SQL reads between receipt of the HTTP response and Client I/O.
      if ('claims' in row !== (stage === 'member identity')) return;
      elapsed += 6_000;
      reassign();
      reassign = undefined;
    });
    const [server] = f.servers;
    const normalList = f.list.getMockImplementation();
    if (!server || !normalList) throw new Error('fixture incomplete');
    f.list.mockImplementationOnce(async (uuids) => {
      const original = await normalList(uuids);
      reassign = () => {
        server.remote.user++;
      };
      return original;
    });
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      const result = await f.runtime.reconcile();
      expect(result).toMatchObject({ observed: 0, deferred: [], unavailable: [server.localId] });
      expect(elapsed).toBe(6_000);
      expect(f.detail).toHaveBeenCalledExactlyOnceWith(server.remote.id);
      expect(f.resources).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  },
);

it('refreshes queued identities if a slow resource read outlives the batch', async () => {
  const f = await fleet(4);
  let elapsed = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  try {
    f.resources.mockImplementationOnce(async (identifier) => {
      elapsed += 6_000;
      for (const server of f.servers) {
        if (server.remote.identifier !== identifier) server.remote.user++;
      }
      return offline;
    });
    const result = await f.runtime.reconcile();
    expect(f.list.mock.calls.map(([uuids]) => uuids.length)).toEqual([4, 3]);
    expect(result.observed).toBe(1);
    expect(result.unavailable).toHaveLength(3);
    expect(f.resources).toHaveBeenCalledTimes(1);
    expect(f.individual).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it('uses a durable, deferred detail only for the malformed singleton when the filter route stays broken', async () => {
  const f = await fleet(4);
  const bad = f.servers[0];
  const normalList = f.list.getMockImplementation();
  if (!bad || !normalList) throw new Error('fixture incomplete');
  f.list.mockImplementation(async (ids) =>
    ids.includes(bad.remote.uuid) ? Response.json({ object: 'list', data: [{}] }) : normalList(ids),
  );
  expect(await f.runtime.reconcile()).toMatchObject({ observed: 3, unavailable: [bad.localId] });
  expect(f.detail).not.toHaveBeenCalled();
  const due = await f.db.selectFrom('fleet_reconciliation_retries').selectAll().execute();
  expect(due).toMatchObject([{ server_id: bad.localId, batch_size: 1, read_detail: true }]);
  await f.runtime.reconcile();
  expect(f.detail).not.toHaveBeenCalled();
  await f.db
    .updateTable('fleet_reconciliation_retries')
    .set({ retry_at: new Date(0) })
    .execute();
  f.list.mockClear();
  expect(await f.runtime.reconcile()).toMatchObject({ observed: 4, unavailable: [], deferred: [] });
  expect(f.list.mock.calls.map(([ids]) => ids.length)).toEqual([3]);
  expect(f.detail).toHaveBeenCalledExactlyOnceWith(bad.remote.id);
  expect(await f.db.selectFrom('fleet_reconciliation_retries').selectAll().execute()).toEqual([]);
});

it('charges isolated details to the shared subdivision cap and fences reassignment and ABA before Client I/O', async () => {
  const f = await fleet(16);
  await f.db
    .insertInto('fleet_reconciliation_retries')
    .values(
      f.servers.map((s) => ({
        server_id: s.localId,
        batch_size: 1,
        read_detail: true,
        retry_at: new Date(0),
      })),
    )
    .execute();
  const detail = f.detail.getMockImplementation();
  if (!detail) throw new Error('fixture incomplete');
  const rejected: string[] = [];
  f.detail.mockImplementationOnce(async (id) => {
    const server = f.servers.find((s) => s.remote.id === id);
    if (!server) throw new Error('fixture incomplete');
    rejected.push(server.remote.identifier);
    return Response.json({ attributes: { ...server.remote, user: server.remote.user + 1 } });
  });
  f.detail.mockImplementationOnce(async (id) => {
    const server = f.servers.find((s) => s.remote.id === id);
    if (!server) throw new Error('fixture incomplete');
    rejected.push(server.remote.identifier);
    for (const name of ['intermediate', server.remote.name])
      await f.db
        .updateTable('managed_servers')
        .set({ name })
        .where('id', '=', server.localId)
        .execute();
    return detail(id);
  });
  const result = await f.runtime.reconcile();
  expect(result.observed).toBe(10);
  expect(result.deferred).toHaveLength(1);
  expect(f.list).not.toHaveBeenCalled();
  expect(f.detail).toHaveBeenCalledTimes(12);
  for (const identifier of rejected) expect(f.resources).not.toHaveBeenCalledWith(identifier);
  f.detail.mockClear();
  f.detail.mockResolvedValueOnce(
    new Response(null, { status: 429, headers: { 'Retry-After': '1' } }),
  );
  await f.runtime.reconcile();
  expect(f.detail).toHaveBeenCalledTimes(1);
  expect(await f.db.selectFrom('fleet_reconciliation_retries').selectAll().execute()).toHaveLength(
    4,
  );
});

it('retires an active fleet observer when its own PostgreSQL session dies during Client I/O', async () => {
  const f = await fleet(2);
  const url = process.env.NH_TEST_DATABASE_URL;
  if (!url) throw new Error('Missing isolated fixture database');
  const applicationName = `fleet-test-${randomUUID()}`;
  const replica = createDatabase(url, {
    options: `-c search_path=${database.schema}`,
    application_name: applicationName,
    max: 1,
  });
  const started = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  const lost = Promise.withResolvers<void>();
  f.resources.mockImplementationOnce(async () => {
    started.resolve();
    await releaseRead.promise;
    return offline;
  });
  let old: Promise<unknown> | undefined;
  try {
    const pid = (await replica.pool.query<{ pid: number }>('select pg_backend_pid() as pid'))
      .rows[0]?.pid;
    old = pollFleet(replica.pool, async (signal) => {
      signal.addEventListener('abort', () => lost.resolve(), { once: true });
      try {
        await f.runtime.reconcile();
      } finally {
        if (signal.aborted)
          await expect(f.runtime.adapter.getApplicationServer(1)).rejects.toThrow(
            'connection lost',
          );
      }
    }).catch((e) => e);
    await started.promise;
    // This test's single-connection pool owns both the PID and its random application name.
    const termination = await database.pool.query<{ killed: boolean }>(
      `select pg_terminate_backend(pid) as killed
      from pg_stat_activity where pid=$1 and application_name=$2 and datname=current_database()`,
      [pid, applicationName],
    );
    expect(termination.rows).toEqual([{ killed: true }]);
    await lost.promise;
    const clock = () =>
      database.pool.query<{ at: string }>(
        'select next_poll_at::text as at from fleet_reconciliation_clock',
      );
    expect((await clock()).rows[0]?.at).toBe('-infinity');
    await pollFleet(database.pool, async () => {
      expect(await f.runtime.reconcile()).toMatchObject({ observed: 2 });
    });
    const watermark = (await clock()).rows;
    releaseRead.resolve();
    expect(await old).toMatchObject({ message: 'Fleet reconciliation connection lost' });
    expect((await clock()).rows).toEqual(watermark);
    expect(f.detail).not.toHaveBeenCalled();
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.resources).toHaveBeenCalledTimes(3);
    expect(await f.db.selectFrom('server_metrics').selectAll().execute()).toHaveLength(2);
  } finally {
    releaseRead.resolve();
    await old;
    await replica.db.destroy();
  }
});
