import { randomBytes, randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import {
  type ApplicationServer,
  createPterodactylAdapter,
  type Resources,
} from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  expect(f.list).toHaveBeenCalledTimes(2);
  expect(f.detail).toHaveBeenCalledTimes(48);
  expect(f.resources).toHaveBeenCalledTimes(48);
  expect(f.resources).not.toHaveBeenCalledWith(bad?.remote.identifier);
});

it('stops individual recovery and later batches when the first recovered read hits the Application quota', async () => {
  const f = await fleet(49);
  f.list.mockResolvedValueOnce(Response.json({ object: 'list', data: [{}] }));
  f.detail.mockResolvedValueOnce(
    new Response(null, { status: 429, headers: { 'Retry-After': '5' } }),
  );
  const result = await f.runtime.reconcile();
  expect(result.observed).toBe(0);
  expect(result.unavailable.sort()).toEqual(f.servers.map(({ localId }) => localId).sort());
  expect(f.batches).toHaveBeenCalledTimes(1);
  expect(f.individual).toHaveBeenCalledTimes(1);
  expect(f.detail).toHaveBeenCalledTimes(1);
  expect(f.resources).not.toHaveBeenCalled();
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
