import { randomUUID } from 'node:crypto';
import { authSessionId } from '@nickhosting/core';
import { createDatabase } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPhysicalHost } from './configuration.js';
import { managementFixture } from './test-fixtures.js';
import {
  recoverUploadIngestion,
  reserveUploadIngestion,
  uploadStagingAvailableBytes,
} from './upload-admission.js';
import {
  effectiveUploadPolicy,
  uploadMultipartAllowanceBytes,
  uploadPolicyOverrides,
} from './upload-policy.js';

const policy = {
  providerMaxFileBytes: 16 * 1024 ** 2,
  temporaryDiskPath: '/isolated-upload-staging',
  temporaryDiskBudgetBytes: 32 * 1024 ** 2,
  temporaryDiskHeadroomBytes: 1024 ** 2,
};
const env = { NH_OBSERVER_ID: 'isolated-observer' };
const enough = { availableBytes: async () => 1024n ** 3n };
describe('durable multipart ingestion admission', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let f: Awaited<ReturnType<typeof managementFixture>>;
  beforeEach(async () => {
    database = await createTestDatabase();
    f = await managementFixture(database.db);
    const sessionId = randomUUID();
    await database.pool.query(
      'INSERT INTO session(id,token,"userId","expiresAt") VALUES($1,$2,$3,now()+interval \'1 hour\')',
      [sessionId, randomUUID(), f.owner.actorUserId],
    );
    f.owner[authSessionId] = sessionId;
  });
  afterEach(async () => {
    await database?.destroy();
  });
  async function configure(value: unknown = policy, hostId = f.hostId) {
    await f.db
      .updateTable('physical_hosts')
      .set({ upload_policy: value === null ? null : JSON.stringify(value) })
      .where('id', '=', hostId)
      .execute();
  }
  async function recover(id: string, scopeHash?: string) {
    const claim = await f.db
      .selectFrom('upload_ingestion_claims')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return recoverUploadIngestion(f.db, f.owner, id, {
      confirm: true,
      remoteTransferFinished: true,
      temporaryFilesRemoved: true,
      scopeHash: scopeHash ?? claim.scope_hash,
      reason: 'Isolated provider has completed',
      evidence: 'Only a mocked transfer was used; no staging files or remote write exists.',
    });
  }
  async function hostInput() {
    const host = await f.db
      .selectFrom('physical_hosts')
      .selectAll()
      .where('id', '=', f.hostId)
      .executeTakeFirstOrThrow();
    return {
      id: host.id,
      name: host.name,
      memoryLimitMiB: host.memory_limit_mib,
      cpuLimitPercent: host.cpu_limit_percent,
      storagePoolMiB: Number(host.storage_pool_mib),
      memoryHeadroomMiB: host.memory_headroom_mib,
      cpuHeadroomPercent: host.cpu_headroom_percent,
      diskHeadroomMiB: Number(host.disk_headroom_mib),
      localDiskPath: host.local_disk_path,
      observerId: host.observer_id,
      enabled: host.enabled,
      uploadPolicy: host.upload_policy,
    };
  }
  it('is disabled by default and refuses a missing or mismatched host observer', async () => {
    const server = await f.server();
    const sample = vi.fn(enough.availableBytes);
    await expect(
      f.db
        .connection()
        .execute((connection) =>
          reserveUploadIngestion(connection, f.context, server, 1, env, { availableBytes: sample }),
        ),
    ).rejects.toMatchObject({ code: 'configuration_invalid' });
    await configure();
    for (const observer of [{}, { NH_OBSERVER_ID: 'different-host' }])
      await expect(
        f.db.connection().execute((connection) =>
          reserveUploadIngestion(connection, f.context, server, 1, observer, {
            availableBytes: sample,
          }),
        ),
      ).rejects.toMatchObject({ code: 'configuration_invalid' });
    await f.db
      .updateTable('physical_hosts')
      .set({ enabled: false })
      .where('id', '=', f.hostId)
      .execute();
    await expect(
      f.db
        .connection()
        .execute((connection) =>
          reserveUploadIngestion(connection, f.context, server, 1, env, { availableBytes: sample }),
        ),
    ).rejects.toMatchObject({ code: 'configuration_invalid' });
    expect(sample).not.toHaveBeenCalled();
    expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toEqual([]);
  });
  it('enforces the provider per-file bound before sampling or creating a claim', async () => {
    const server = await f.server();
    await configure();
    const sample = vi.fn(enough.availableBytes);
    await expect(
      f.db
        .connection()
        .execute((connection) =>
          reserveUploadIngestion(
            connection,
            f.context,
            server,
            policy.providerMaxFileBytes + 1,
            env,
            { availableBytes: sample },
          ),
        ),
    ).rejects.toMatchObject({ status: 413 });
    expect(sample).not.toHaveBeenCalled();
    expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toEqual([]);
  });
  it('charges the full temporary copy and bounded multipart overhead against budget and real free headroom', async () => {
    const server = await f.server(),
      bytes = 1024 ** 2;
    await configure({ ...policy, temporaryDiskBudgetBytes: bytes });
    await expect(
      f.db
        .connection()
        .execute((connection) =>
          reserveUploadIngestion(connection, f.context, server, bytes, env, enough),
        ),
    ).rejects.toMatchObject({ status: 413 });
    await configure();
    const required = BigInt(
      2 * bytes + uploadMultipartAllowanceBytes + policy.temporaryDiskHeadroomBytes,
    );
    await expect(
      f.db.connection().execute((connection) =>
        reserveUploadIngestion(connection, f.context, server, bytes, env, {
          availableBytes: async (path) =>
            path === policy.temporaryDiskPath ? required - 1n : 1024n ** 3n,
        }),
      ),
    ).rejects.toMatchObject({ code: 'resources_unavailable' });
    await f.db.connection().execute(async (connection) => {
      const lease = await reserveUploadIngestion(connection, f.context, server, bytes, env, {
        availableBytes: async (path) =>
          path === policy.temporaryDiskPath ? required : 1024n ** 3n,
      });
      try {
        const row = await f.db
          .selectFrom('upload_ingestion_claims')
          .selectAll()
          .executeTakeFirstOrThrow();
        expect(row.declared_bytes).toBe(String(bytes));
        expect(row.reserved_bytes).toBe(String(2 * bytes + uploadMultipartAllowanceBytes));
        expect(row.scope.policy.temporaryDiskPath).toBe(policy.temporaryDiskPath);
        await lease.complete();
      } finally {
        await lease.unlock();
      }
    });
    expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toEqual([]);
  });
  it('serializes simultaneous claims on one physical host including sibling nodes', async () => {
    const first = await f.server(),
      second = await f.server();
    await configure();
    const node = await f.db
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', f.nodeId)
      .executeTakeFirstOrThrow();
    const siblingId = randomUUID();
    await f.db
      .insertInto('managed_nodes')
      .values({
        ...node,
        id: siblingId,
        pterodactyl_node_id: node.pterodactyl_node_id + 100000,
        backend_allocation_pool: JSON.stringify(node.backend_allocation_pool),
      })
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ node_id: siblingId })
      .where('id', '=', second)
      .execute();
    const results = await Promise.all(
      [first, second].map((server) =>
        f.db.connection().execute(async (connection) => {
          try {
            const claim = await reserveUploadIngestion(
              connection,
              f.context,
              server,
              1,
              env,
              enough,
            );
            await claim.unlock();
            return { claim: claim.id };
          } catch (error) {
            return { error };
          }
        }),
      ),
    );
    expect(results.filter((result) => result.claim)).toHaveLength(1);
    expect(results.find((result) => result.error)?.error).toMatchObject({ code: 'conflict' });
    expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toHaveLength(1);
  });
  it('allows independent claims on distinct hosts', async () => {
    const second = await managementFixture(f.db);
    const firstServer = await f.server(),
      secondServer = await second.server();
    await configure();
    await configure(policy, second.hostId);
    await Promise.all(
      [
        [firstServer, f.context],
        [secondServer, second.context],
      ].map(async ([server, context]) =>
        f.db.connection().execute(async (connection) => {
          const claim = await reserveUploadIngestion(
            connection,
            context as typeof f.context,
            server as string,
            1,
            env,
            enough,
          );
          await claim.unlock();
        }),
      ),
    );
    expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toHaveLength(2);
  });
  it('retains a claim across a dropped connection and pins the original policy despite new environment settings', async () => {
    const server = await f.server();
    await configure();
    const crash = createDatabase(process.env.NH_TEST_DATABASE_URL ?? '', {
      max: 1,
      options: `-c search_path=${database.schema}`,
    });
    const id = await crash.db
      .connection()
      .execute(
        async (connection) =>
          (await reserveUploadIngestion(connection, f.context, server, 1234, env, enough)).id,
      );
    await crash.db.destroy(); // Simulate process loss: session advisory lock disappears, row does not.
    const retained = await f.db
      .selectFrom('upload_ingestion_claims')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(retained.scope.policy).toEqual(policy);
    const changed = {
      ...env,
      NH_UPLOAD_POLICIES: JSON.stringify({
        [f.hostId]: { ...policy, temporaryDiskPath: '/other-isolated-staging' },
      }),
    };
    await expect(
      f.db
        .connection()
        .execute((connection) =>
          reserveUploadIngestion(connection, f.context, server, 1, changed, enough),
        ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(recover(id, '0'.repeat(64))).rejects.toMatchObject({ code: 'conflict' });
    await recover(id);
    expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toEqual([]);
    const audit = await f.db
      .selectFrom('audit_events')
      .select('metadata')
      .where('action', '=', 'server.upload.recovered')
      .executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({
      scopeHash: retained.scope_hash,
      remoteTransferFinished: true,
      temporaryFilesRemoved: true,
    });
  });
  it('cannot recover an active transfer or recover without regular Owner authority and explicit cleanup evidence', async () => {
    const server = await f.server();
    await configure();
    await f.db.connection().execute(async (connection) => {
      const lease = await reserveUploadIngestion(connection, f.context, server, 1, env, enough);
      try {
        await expect(recover(lease.id)).rejects.toMatchObject({ code: 'conflict' });
      } finally {
        await lease.unlock();
      }
      const row = await f.db
        .selectFrom('upload_ingestion_claims')
        .selectAll()
        .where('id', '=', lease.id)
        .executeTakeFirstOrThrow();
      const input = {
        confirm: true,
        remoteTransferFinished: true,
        temporaryFilesRemoved: true,
        scopeHash: row.scope_hash,
        reason: 'Isolated provider completed',
        evidence: 'Isolated mocked upload requires no real cleanup',
      };
      await expect(recoverUploadIngestion(f.db, f.context, lease.id, input)).rejects.toMatchObject({
        code: 'forbidden',
      });
      await expect(
        recoverUploadIngestion(f.db, { ...f.owner, sessionType: 'support' }, lease.id, input),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        recoverUploadIngestion(f.db, f.owner, lease.id, { ...input, temporaryFilesRemoved: false }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      await recoverUploadIngestion(f.db, f.owner, lease.id, input);
    });
  });
  it.each(['logout', 'demotion'])(
    'revalidates Owner authority after resource-lock wait during recovery: %s',
    async (reason) => {
      const server = await f.server();
      await configure();
      const id = await f.db.connection().execute(async (connection) => {
        const lease = await reserveUploadIngestion(connection, f.context, server, 1, env, enough);
        await lease.unlock();
        return lease.id;
      });
      const blocker = await database.pool.connect();
      let result: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid;
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':resources',0))",
        );
        result = recover(id).then(
          () => ({ success: true }),
          (error: unknown) => error,
        );
        await vi.waitFor(async () => {
          const waiting = await database.pool.query<{ count: string }>(
            'SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
            [pid],
          );
          expect(Number(waiting.rows[0]?.count)).toBe(1);
        });
        if (reason === 'logout')
          await f.db
            .deleteFrom('session')
            .where('id', '=', f.owner[authSessionId] ?? '')
            .execute();
        else
          await f.db
            .updateTable('user')
            .set({ role: 'user' })
            .where('id', '=', f.owner.actorUserId)
            .execute();
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect(await result).toMatchObject({
        code: reason === 'logout' ? 'unauthenticated' : 'forbidden',
      });
      expect(
        await f.db.selectFrom('upload_ingestion_claims').selectAll().where('id', '=', id).execute(),
      ).toHaveLength(1);
    },
  );
  it('checks the destination filesystem independently of the staging mount', async () => {
    const server = await f.server();
    await configure();
    const observe = vi.fn(async (path: string) =>
      path === policy.temporaryDiskPath ? 1024n ** 3n : 1n,
    );
    await expect(
      f.db.connection().execute((connection) =>
        reserveUploadIngestion(connection, f.context, server, 1, env, {
          availableBytes: observe,
        }),
      ),
    ).rejects.toMatchObject({ code: 'resources_unavailable' });
    expect(observe.mock.calls.map(([path]) => path)).toEqual(
      expect.arrayContaining([policy.temporaryDiskPath, '/isolated-fixture']),
    );
  });
  it('blocks staging policy, observer and path changes while preserving harmless host labels', async () => {
    const server = await f.server();
    await configure();
    await f.db.connection().execute(async (connection) => {
      const lease = await reserveUploadIngestion(connection, f.context, server, 1, env, enough);
      await lease.unlock();
    });
    const original = await hostInput();
    for (const patch of [
      { uploadPolicy: null },
      { uploadPolicy: { ...policy, providerMaxFileBytes: 1 } },
      { observerId: 'other-observer' },
      { localDiskPath: '/other-fixture' },
      { enabled: false },
    ])
      await expect(setPhysicalHost(f.db, f.owner, { ...original, ...patch })).rejects.toMatchObject(
        { code: 'conflict' },
      );
    await expect(
      setPhysicalHost(f.db, f.owner, { ...original, name: 'Allowed label edit' }),
    ).resolves.toEqual({ id: f.hostId });
  });
  it('uses explicit environment policy precedence and locks conflicting Owner writes', async () => {
    const server = await f.server();
    await configure();
    const override = { ...policy, providerMaxFileBytes: 1 };
    const configuration = { ...env, NH_UPLOAD_POLICIES: JSON.stringify({ [f.hostId]: override }) };
    const row = await f.db
      .selectFrom('physical_hosts')
      .selectAll()
      .where('id', '=', f.hostId)
      .executeTakeFirstOrThrow();
    expect(effectiveUploadPolicy(row, configuration)).toEqual(override);
    await expect(
      f.db
        .connection()
        .execute((connection) =>
          reserveUploadIngestion(connection, f.context, server, 2, configuration, enough),
        ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      setPhysicalHost(
        f.db,
        f.owner,
        { ...(await hostInput()), uploadPolicy: override },
        configuration,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      effectiveUploadPolicy(row, { NH_UPLOAD_POLICIES: JSON.stringify({ [f.hostId]: null }) }),
    ).toBeNull();
    expect(() => uploadPolicyOverrides({ NH_UPLOAD_POLICIES: '{invalid' })).toThrow(
      'configuration_invalid',
    );
  });
});

describe('staging filesystem observations', () => {
  it.each([0x01021994n, 0x858458f6n, BigInt.asIntN(32, 0x858458f6n)])(
    'rejects RAM-backed filesystem type %s',
    (type) => {
      expect(() => uploadStagingAvailableBytes({ bavail: 1_000_000n, bsize: 4096n, type })).toThrow(
        'configuration_invalid',
      );
    },
  );
  it('keeps free space arithmetic exact beyond number precision and rejects invalid samples', () => {
    expect(uploadStagingAvailableBytes({ bavail: 2n ** 53n, bsize: 4096n, type: 0xef53n })).toBe(
      2n ** 65n,
    );
    expect(() =>
      uploadStagingAvailableBytes({ bavail: -1n, bsize: 4096n, type: 0xef53n }),
    ).toThrow();
  });
});
