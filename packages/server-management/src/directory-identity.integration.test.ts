import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { authSessionId, SecretCodec } from '@nickhosting/core';
import { createDatabase } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ApplicationServer } from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryIdentityCache } from './directory-identity.js';
import { createProject, setProjectMember } from './registry.js';
import { createManagementRuntime } from './runtime.js';
import { managementFixture, pendingUploadFixture } from './test-fixtures.js';

describe('directory browsing identity proof reuse', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let f: Awaited<ReturnType<typeof managementFixture>>;
  let serverId: string;
  let clock: number;
  let deferredProofs: Array<ReturnType<typeof Promise.withResolvers<ApplicationServer>>>;
  function deferredProof() {
    const value = Promise.withResolvers<ApplicationServer>();
    deferredProofs.push(value);
    return value;
  }
  let cache: ReturnType<typeof createDirectoryIdentityCache>;
  const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
  const remote = vi.fn<() => Promise<ApplicationServer>>();
  const listing = vi.fn(async (_identifier: string, _directory = '') => []);
  const uploaded = vi.fn(async () => 'isolated upload');

  async function identity(): Promise<ApplicationServer> {
    const server = await f.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    const node = await f.db
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', server.node_id)
      .executeTakeFirstOrThrow();
    const allocations = await f.db
      .selectFrom('server_allocations')
      .selectAll()
      .where('server_id', '=', serverId)
      .execute();
    return {
      id: server.pterodactyl_id,
      uuid: server.pterodactyl_uuid,
      identifier: server.pterodactyl_identifier,
      external_id: server.external_id,
      node: node.pterodactyl_node_id,
      user: server.provider_user_id,
      allocation: allocations.find((row) => row.is_primary)?.pterodactyl_allocation_id,
      relationships: {
        allocations: {
          data: allocations.map((row) => ({
            attributes: {
              id: row.pterodactyl_allocation_id,
              ip: row.address,
              port: row.port,
              assigned: true,
            },
          })),
        },
      },
    } as ApplicationServer;
  }
  const runtime = (adapter = f.adapter) =>
    createManagementRuntime({ db: f.db, codec, adapter, directoryIdentityCache: cache });
  const browse = async (path = '') => (await runtime()).listFiles(f.context, serverId, path);
  const upload = async () => (await runtime()).uploadAccess(f.context, serverId, uploaded);

  beforeEach(async () => {
    database = await createTestDatabase();
    f = await managementFixture(database.db, { interactive: true });
    serverId = await f.server();
    clock = 0;
    deferredProofs = [];
    cache = createDirectoryIdentityCache(() => clock);
    remote.mockReset().mockImplementation(identity);
    listing.mockClear();
    uploaded.mockReset().mockResolvedValue('isolated upload');
    f.adapter.getApplicationServer = remote;
    f.adapter.listFiles = listing;
  });
  afterEach(async () => {
    cache?.close();
    vi.useRealTimers();
    for (const proof of deferredProofs ?? []) proof.resolve(await identity());
    if (deferredProofs?.length) await delay(30);
    await database?.destroy();
  });

  it('reuses identity across newly constructed runtimes and folders without caching their listing', async () => {
    for (const path of ['', 'world', 'world/playerdata']) await browse(path);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(listing.mock.calls.map((call) => call[1])).toEqual(['', 'world', 'world/playerdata']);
  });

  it('reuses a browsed identity across 49 uploads without reusing upload callbacks', async () => {
    await browse();
    for (let index = 0; index < 49; index++) await upload();
    expect(remote).toHaveBeenCalledTimes(1);
    expect(uploaded).toHaveBeenCalledTimes(49);
    expect(listing).toHaveBeenCalledTimes(1);
  });

  it('also prepares a cold upload identity once and expires it without extending TTL', async () => {
    await upload();
    clock = 54_999;
    await upload();
    expect(remote).toHaveBeenCalledTimes(1);
    clock = 60_000;
    await upload();
    expect(remote).toHaveBeenCalledTimes(2);
    expect(uploaded).toHaveBeenCalledTimes(3);
  });

  it('keeps proof across non-identity metadata, telemetry and feed heartbeat updates', async () => {
    await browse();
    await f.db
      .updateTable('managed_servers')
      .set({
        name: 'Renamed fixture',
        runtime_state: 'running',
        last_observed_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', serverId)
      .execute();
    await f.db
      .updateTable('provider_change_feeds')
      .set({ healthy_at: new Date(), generation: '2' })
      .execute();
    await browse('world');
    expect(remote).toHaveBeenCalledTimes(1);
    expect(listing).toHaveBeenCalledTimes(2);
  });

  it('expires at sixty seconds without extending TTL on hits', async () => {
    await browse();
    clock = 54_999;
    await browse('world');
    expect(remote).toHaveBeenCalledTimes(1);
    clock = 60_000;
    await browse('logs');
    expect(remote).toHaveBeenCalledTimes(2);
  });

  it('renews at fifty-five seconds without blocking fresh listings and waits after expiry', async () => {
    await browse();
    const proof = deferredProof();
    remote.mockReturnValueOnce(proof.promise);
    clock = 55_000;
    await browse('world');
    await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(2));
    expect(listing).toHaveBeenCalledTimes(2);
    clock = 59_999;
    await browse('logs');
    expect(remote).toHaveBeenCalledTimes(2);
    clock = 60_000;
    const expired = browse('world/playerdata');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listing).toHaveBeenCalledTimes(3);
    proof.resolve(await identity());
    await expired;
    expect(remote).toHaveBeenCalledTimes(2);
    expect(listing).toHaveBeenCalledTimes(4);
  });

  it('does not extend the sixty-second deadline when a background renewal fails', async () => {
    await browse();
    const renewal = deferredProof();
    remote.mockReturnValueOnce(renewal.promise);
    clock = 55_000;
    await browse('world');
    await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(2));
    renewal.reject(new Error('isolated renewal failure'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    clock = 60_000;
    remote.mockRejectedValueOnce(new Error('isolated expired proof failure'));
    await expect(browse('logs')).rejects.toThrow('isolated expired proof failure');
    expect(listing).toHaveBeenCalledTimes(2);
    await browse('logs');
    expect(listing).toHaveBeenCalledTimes(3);
    expect(remote).toHaveBeenCalledTimes(4);
  });

  it('automatically renews once at fifty-five seconds without polling unused replacements', async () => {
    // Observe and invoke only the cache's scheduled callbacks. Global fake timers
    // would also replace pg socket/pool timers and obscure disposal behavior.
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const renewals = () => timers.mock.calls.filter((call) => call[1] === 55_000);
    try {
      await browse();
      expect(renewals()).toHaveLength(1);
      clock = 55_000;
      renewals()[0]?.[0]();
      await vi.waitFor(() => expect(renewals()).toHaveLength(2));
      expect(remote).toHaveBeenCalledTimes(2);
      clock = 110_000;
      renewals()[1]?.[0]();
      await delay(20);
      expect(remote).toHaveBeenCalledTimes(2);
      await browse('world');
      await vi.waitFor(() => expect(renewals()).toHaveLength(3));
      expect(remote).toHaveBeenCalledTimes(3);
    } finally {
      cache.close();
      timers.mockRestore();
    }
  });

  it('does not resurrect an invalidated entry when its older renewal finishes', async () => {
    await browse();
    const renewal = deferredProof();
    remote.mockReturnValueOnce(renewal.promise);
    clock = 55_000;
    await browse('world');
    await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(2));
    cache.invalidate(serverId);
    renewal.resolve(await identity());
    await new Promise((resolve) => setTimeout(resolve, 30));
    await browse('logs');
    expect(remote).toHaveBeenCalledTimes(3);
  });

  it('renews expired directory proofs without deadlocking a single-connection pool', async () => {
    const small = createDatabase(process.env.NH_TEST_DATABASE_URL as string, {
      max: 1,
      options: `-c search_path=${database.schema}`,
    });
    try {
      const service = await createManagementRuntime({
        db: small.db,
        codec,
        adapter: f.adapter,
        directoryIdentityCache: cache,
      });
      await service.listFiles(f.context, serverId, '');
      clock = 60_000;
      await Promise.all(
        ['world', 'logs', 'plugins'].map((path) => service.listFiles(f.context, serverId, path)),
      );
      expect(remote).toHaveBeenCalledTimes(2);
      expect(listing).toHaveBeenCalledTimes(4);
    } finally {
      cache.close();
      await small.db.destroy();
    }
  });

  it('waits for expired background proof renewal with the upload gate minimum two-connection pool', async () => {
    const small = createDatabase(process.env.NH_TEST_DATABASE_URL as string, {
      max: 2,
      options: `-c search_path=${database.schema}`,
    });
    const renewal = deferredProof();
    let request: Promise<unknown> | undefined;
    try {
      const service = await createManagementRuntime({
        db: small.db,
        codec,
        adapter: f.adapter,
        directoryIdentityCache: cache,
      });
      await service.uploadAccess(f.context, serverId, uploaded);
      clock = 55_000;
      remote.mockReturnValueOnce(renewal.promise);
      await service.uploadAccess(f.context, serverId, uploaded);
      await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(2));
      clock = 60_000;
      request = service.uploadAccess(f.context, serverId, uploaded);
      await delay(30);
      expect(uploaded).toHaveBeenCalledTimes(2);
      renewal.resolve(await identity());
      await request;
      expect(uploaded).toHaveBeenCalledTimes(3);
      expect(remote).toHaveBeenCalledTimes(2);
    } finally {
      renewal.resolve(await identity());
      await request?.catch(() => {});
      cache.close();
      await small.db.destroy();
    }
  });

  it('closing the cache rejects an in-flight proof without listing or resurrection', async () => {
    const proof = deferredProof();
    remote.mockReturnValueOnce(proof.promise);
    const request = browse();
    const rejected = expect(request).rejects.toThrow('conflict');
    await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(1));
    cache.close();
    proof.resolve(await identity());
    await rejected;
    await expect(browse()).rejects.toThrow('integration_unavailable');
    expect(remote).toHaveBeenCalledTimes(1);
    expect(listing).not.toHaveBeenCalled();
  });

  it('joins concurrent cold proofs across distinct runtimes', async () => {
    const proof = deferredProof();
    remote.mockReturnValueOnce(proof.promise);
    const requests = ['', 'world', 'logs'].map(browse);
    await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(1));
    proof.resolve(await identity());
    await Promise.all(requests);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(listing).toHaveBeenCalledTimes(3);
  });

  it('does not reuse proof with another provider adapter binding', async () => {
    await browse();
    const replacement = await runtime({ ...f.adapter });
    await replacement.listFiles(f.context, serverId, 'world');
    expect(remote).toHaveBeenCalledTimes(2);
  });

  it.each(
    [
      'identity',
      'node',
      'claim',
      'credential',
      'account-status',
      'feed-enabled',
      'projection-revision',
      'projection-valid',
    ].flatMap((change) => ['directory', 'upload'].map((mode) => ({ change, mode }))),
  )('invalidates a warm $mode proof after $change changes', async ({ change, mode }) => {
    const account = await f.db
      .selectFrom('provider_accounts')
      .selectAll()
      .where('user_id', '=', f.context.subjectUserId)
      .executeTakeFirstOrThrow();
    await f.db
      .insertInto('provider_server_projections')
      .values({
        server_id: serverId,
        instance_id: account.instance_id as string,
        revision: '1',
        payload: {},
        valid: true,
        identity_invalidated: false,
        synchronized_at: new Date(),
      })
      .execute();
    await browse();
    if (change === 'identity')
      await f.db
        .updateTable('managed_servers')
        .set({ pterodactyl_uuid: randomUUID() })
        .where('id', '=', serverId)
        .execute();
    if (change === 'node')
      await f.db
        .updateTable('managed_nodes')
        .set({ pterodactyl_node_id: f.providerNodeId + 10000 })
        .where('id', '=', f.nodeId)
        .execute();
    if (change === 'claim') {
      const existing = await f.db
        .selectFrom('server_allocations')
        .selectAll()
        .where('server_id', '=', serverId)
        .executeTakeFirstOrThrow();
      // Existing allocation identities are immutable; an additional independently
      // claimed endpoint changes the proof without bypassing that DB invariant.
      await f.db
        .insertInto('server_allocations')
        .values({
          ...existing,
          direct_endpoint: existing.direct_endpoint
            ? JSON.stringify(existing.direct_endpoint)
            : null,
          id: randomUUID(),
          pterodactyl_allocation_id: existing.pterodactyl_allocation_id + 10000,
          port: 29999,
          role: 'query',
          is_primary: false,
        })
        .execute();
    }
    if (change === 'credential')
      await f.db
        .updateTable('provider_accounts')
        .set({ key_operation_id: randomUUID() })
        .where('user_id', '=', f.context.subjectUserId)
        .execute();
    if (change === 'account-status')
      await f.db
        .updateTable('provider_accounts')
        .set({ status: 'pending' })
        .where('user_id', '=', f.context.subjectUserId)
        .execute();
    if (change === 'feed-enabled')
      await f.db
        .updateTable('provider_change_feeds')
        .set({ enabled: false })
        .where('instance_id', '=', account.instance_id as string)
        .execute();
    if (change === 'projection-revision')
      await f.db
        .updateTable('provider_server_projections')
        .set({ revision: '2' })
        .where('server_id', '=', serverId)
        .execute();
    if (change === 'projection-valid')
      await f.db
        .updateTable('provider_server_projections')
        .set({ valid: false })
        .where('server_id', '=', serverId)
        .execute();
    // The injected adapter isolates proof invalidation; credential resolution itself
    // remains covered by provider-account/scoped-adapter integration tests.
    if (mode === 'upload') await upload();
    else await browse('world');
    expect(remote).toHaveBeenCalledTimes(2);
  });

  it('fails closed on explicit projection identity invalidation', async () => {
    await browse();
    const account = await f.db
      .selectFrom('provider_accounts')
      .selectAll()
      .where('user_id', '=', f.context.subjectUserId)
      .executeTakeFirstOrThrow();
    await f.db
      .insertInto('provider_server_projections')
      .values({
        server_id: serverId,
        instance_id: account.instance_id as string,
        revision: '1',
        payload: {},
        valid: true,
        synchronized_at: new Date(),
        identity_invalidated: true,
      })
      .execute();
    await expect(browse('world')).rejects.toThrow('provenance_mismatch');
    await expect(upload()).rejects.toThrow('provenance_mismatch');
    expect(listing).toHaveBeenCalledTimes(1);
    expect(uploaded).not.toHaveBeenCalled();
  });

  it('does not cache failed remote identity reads or serve expired proofs on error', async () => {
    await browse();
    clock = 60_000;
    remote.mockRejectedValueOnce(new Error('isolated provider unavailable'));
    await expect(browse('world')).rejects.toThrow('isolated provider unavailable');
    expect(listing).toHaveBeenCalledTimes(1);
    await browse('world');
    await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(3));
    await delay(20);
  });

  it('invalidates proof after a directory provider failure', async () => {
    await browse();
    listing.mockRejectedValueOnce(new Error('isolated listing unavailable'));
    await expect(browse('world')).rejects.toThrow('isolated listing unavailable');
    await browse('world');
    expect(remote).toHaveBeenCalledTimes(2);
  });

  it('denies a revoked session before consulting a warm proof or listing', async () => {
    await browse();
    await f.db
      .updateTable('session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', f.context[authSessionId] as string)
      .execute();
    await expect(browse('world')).rejects.toThrow('unauthenticated');
    await expect(upload()).rejects.toThrow('unauthenticated');
    expect(remote).toHaveBeenCalledTimes(1);
    expect(listing).toHaveBeenCalledTimes(1);
    expect(uploaded).not.toHaveBeenCalled();
  });

  it('denies revoked project membership even with a warm proof', async () => {
    const project = await createProject(f.db, f.owner, { name: 'Shared fixture' });
    await f.db
      .updateTable('managed_servers')
      .set({ owner_id: f.owner.subjectUserId, project_id: project.id })
      .where('id', '=', serverId)
      .execute();
    await setProjectMember(f.db, f.owner, project.id, {
      userId: f.context.subjectUserId,
      role: 'manager',
    });
    await browse();
    await upload();
    await setProjectMember(f.db, f.owner, project.id, {
      userId: f.context.subjectUserId,
      role: null,
    });
    await expect(browse('world')).rejects.toThrow('forbidden');
    await expect(upload()).rejects.toThrow('forbidden');
    expect(remote).toHaveBeenCalledTimes(1);
    expect(listing).toHaveBeenCalledTimes(1);
    expect(uploaded).toHaveBeenCalledTimes(1);
  });

  it.each(['active-operation', 'pending-upload'] as const)(
    'rejects uploads with %s even with a warm identity proof',
    async (blocker) => {
      await browse();
      if (blocker === 'pending-upload') await pendingUploadFixture(f.db, serverId);
      else
        await f.db
          .updateTable('managed_servers')
          .set({ active_operation_id: randomUUID() })
          .where('id', '=', serverId)
          .execute();
      await expect(upload()).rejects.toThrow(
        blocker === 'pending-upload' ? 'operation_uncertain' : 'conflict',
      );
      expect(uploaded).not.toHaveBeenCalled();
      expect(remote).toHaveBeenCalledTimes(1);
    },
  );

  it('invalidates reused identity after an unknown upload failure without replaying it', async () => {
    await browse();
    uploaded.mockRejectedValueOnce(new Error('isolated uncertain upload'));
    await expect(upload()).rejects.toThrow('isolated uncertain upload');
    expect(uploaded).toHaveBeenCalledTimes(1);
    await browse();
    expect(remote).toHaveBeenCalledTimes(2);
    expect(uploaded).toHaveBeenCalledTimes(1);
  });

  it('keeps upload lock contention fail-fast despite a warm identity proof', async () => {
    await browse();
    const held = Promise.withResolvers<void>();
    const entered = vi.fn(async () => held.promise);
    const request = (await runtime()).uploadAccess(f.context, serverId, entered);
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
      await expect(upload()).rejects.toThrow('operation_busy');
      expect(uploaded).not.toHaveBeenCalled();
      expect(remote).toHaveBeenCalledTimes(1);
    } finally {
      held.resolve();
      await request;
    }
    await upload();
    expect(uploaded).toHaveBeenCalledTimes(1);
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'keeps fresh remote corroboration for ordinary access(write=%s)',
    async (write) => {
      await browse();
      const effect = vi.fn(async () => 'isolated effect');
      await (await runtime()).access(f.context, serverId, write, effect);
      await (await runtime()).access(f.context, serverId, write, effect);
      expect(remote).toHaveBeenCalledTimes(3);
      expect(effect).toHaveBeenCalledTimes(2);
    },
  );

  it.each(
    ['identity', 'credential', 'session'].flatMap((change) =>
      ['directory', 'upload'].map((mode) => ({ change, mode })),
    ),
  )(
    'rejects $change changes while the remote $mode proof is in flight',
    async ({ change, mode }) => {
      const snapshot = await identity();
      const proof = deferredProof();
      remote.mockReturnValueOnce(proof.promise);
      const request = mode === 'upload' ? upload() : browse();
      const rejected = expect(request).rejects.toThrow(
        change === 'session' ? 'unauthenticated' : 'conflict',
      );
      await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(1));
      if (change === 'identity')
        await f.db
          .updateTable('managed_servers')
          .set({ pterodactyl_identifier: 'newfixtureidentifier' })
          .where('id', '=', serverId)
          .execute();
      if (change === 'credential')
        await f.db
          .updateTable('provider_accounts')
          .set({ key_operation_id: randomUUID() })
          .where('user_id', '=', f.context.subjectUserId)
          .execute();
      if (change === 'session')
        await f.db
          .updateTable('session')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', f.context[authSessionId] as string)
          .execute();
      proof.resolve(snapshot);
      await rejected;
      expect(listing).not.toHaveBeenCalled();
      expect(uploaded).not.toHaveBeenCalled();
    },
  );
});
