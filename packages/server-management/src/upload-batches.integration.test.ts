import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type AuthContext, authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { managementFixture } from './test-fixtures.js';
import { recoverUploadIngestion, reserveUploadIngestion } from './upload-admission.js';
import {
  cancelUploadBatchEntry,
  claimUploadBatchEntry,
  closeUploadBatch,
  createUploadBatch,
  readUploadBatch,
  type UploadBatchFile,
} from './upload-batches.js';
import { createUploadTiming, type UploadTiming } from './upload-timing.js';

const policy = {
  providerMaxFileBytes: 1024 ** 2,
  temporaryDiskPath: '/isolated-batch-staging',
  temporaryDiskBudgetBytes: 16 * 1024 ** 2,
  temporaryDiskHeadroomBytes: 1024 ** 2,
};
const env = { NH_OBSERVER_ID: 'isolated-observer' };
const enough = { availableBytes: async () => 1024n ** 3n };
const bindingHash = 'a'.repeat(64);
const file = (name: string, bytes = 1024): UploadBatchFile => ({
  id: randomUUID(),
  path: `/${name}`,
  bytes,
  overwrite: false,
});

describe('bounded durable upload batches', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let f: Awaited<ReturnType<typeof managementFixture>>;
  let serverId: string;
  let open: Array<() => Promise<void>>;
  beforeEach(async () => {
    database = await createTestDatabase();
    f = await managementFixture(database.db, { interactive: true });
    serverId = await f.server();
    await f.db
      .updateTable('physical_hosts')
      .set({ upload_policy: JSON.stringify(policy) })
      .where('id', '=', f.hostId)
      .execute();
    open = [];
  });
  afterEach(async () => {
    await Promise.all(open.map((close) => close()));
    await database.destroy();
  });
  async function prepare(files: UploadBatchFile[], concurrency = 2, id = randomUUID()) {
    return f.db.connection().execute(async (connection) => {
      const reservation = await reserveUploadIngestion(
        connection,
        f.context,
        serverId,
        files.reduce((sum, file) => sum + file.bytes, 0),
        env,
        {
          ...enough,
          claimId: id,
          providerLargestFileBytes: Math.max(...files.map((file) => file.bytes)),
          multipartCount: Math.min(Math.max(1, concurrency), 6, files.length),
        },
      );
      try {
        return await createUploadBatch(connection, f.context, serverId, reservation.id, {
          bindingHash,
          concurrency,
          files,
        });
      } catch (error) {
        await reservation.rejectBeforeDispatch();
        throw error;
      } finally {
        await reservation.unlock();
      }
    });
  }
  async function entry(
    id: string,
    value: UploadBatchFile,
    context = f.context,
    hash = bindingHash,
    targetServer = serverId,
    trace?: UploadTiming,
  ) {
    type Lease = Awaited<ReturnType<typeof claimUploadBatchEntry>>;
    const ready = Promise.withResolvers<Lease>();
    const done = Promise.withResolvers<void>();
    const work = f.db.connection().execute(async (connection) => {
      try {
        const lease = await claimUploadBatchEntry(
          connection,
          context,
          targetServer,
          id,
          { ...value, bindingHash: hash },
          trace,
        );
        ready.resolve(lease);
        await done.promise;
        await lease.unlock();
      } catch (error) {
        ready.reject(error);
      }
    });
    const release = async () => {
      done.resolve();
      await work;
    };
    open.push(release);
    return { lease: await ready.promise, release };
  }
  const read = (id: string) => readUploadBatch(f.db, f.context, serverId, id, bindingHash);
  const claim = (id: string) =>
    f.db
      .selectFrom('upload_ingestion_claims')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  async function recover(id: string, scopeHash?: string) {
    return recoverUploadIngestion(f.db, f.owner, id, {
      confirm: true,
      remoteTransferFinished: true,
      temporaryFilesRemoved: true,
      scopeHash: scopeHash ?? (await claim(id)).scope_hash,
      reason: 'Isolated mocked batch has completed',
      evidence:
        'Only isolated database fixtures were used; no provider writes or staging files exist.',
    });
  }

  it('reserves the whole batch once while applying provider bounds to individual files', async () => {
    const files = [file('a', policy.providerMaxFileBytes), file('b', policy.providerMaxFileBytes)];
    const id = randomUUID();
    expect(await read(id)).toBeNull();
    const batch = await prepare(files, 2, id);
    expect(batch.id).toBe(id);
    const stored = await claim(id);
    expect(stored.declared_bytes).toBe(String(2 * policy.providerMaxFileBytes));
    expect(stored.reserved_bytes).toBe(String(4 * policy.providerMaxFileBytes + 2 * 65536));
    expect(stored.scope_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await read(id)).toEqual(batch);
    await expect(prepare([file('different')], 2, id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      f.db.connection().execute((connection) =>
        createUploadBatch(connection, f.context, serverId, id, {
          bindingHash,
          concurrency: 2,
          files,
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await closeUploadBatch(f.db, f.context, serverId, id, bindingHash);
    await expect(
      prepare([file('too-large', policy.providerMaxFileBytes + 1)]),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('admits only the configured number of entries atomically, then releases the next slot', async () => {
    const files: [UploadBatchFile, UploadBatchFile, UploadBatchFile] = [
      file('a'),
      file('b'),
      file('c'),
    ];
    const batch = await prepare(files);
    const firstTiming = createUploadTiming(),
      secondTiming = createUploadTiming(),
      refusedTiming = createUploadTiming(),
      lastTiming = createUploadTiming();
    const [first, second] = await Promise.all([
      entry(batch.id, files[0], undefined, undefined, undefined, firstTiming),
      entry(batch.id, files[1], undefined, undefined, undefined, secondTiming),
    ]);
    await expect(
      entry(batch.id, files[2], undefined, undefined, undefined, refusedTiming),
    ).rejects.toMatchObject({ code: 'operation_busy' });
    const refused = refusedTiming.snapshot();
    expect(refused['admission.validateTransition']?.count).toBe(1);
    expect(refused['admission.transactionTail']?.count).toBe(1);
    expect(refused['release.claimUnlock']?.count).toBe(1);
    expect(refused['admission.updateClaim']).toBeUndefined();
    expect(refused['admission.audit']).toBeUndefined();
    const before = await claim(batch.id);
    await first.lease.complete();
    await first.release();
    const after = await claim(batch.id);
    expect(after.reserved_bytes).toBe(before.reserved_bytes);
    expect(after.scope_hash).not.toBe(before.scope_hash);
    const third = await entry(batch.id, files[2], undefined, undefined, undefined, lastTiming);
    await second.lease.complete();
    expect((await read(batch.id))?.files.map((file) => file.state)).toEqual([
      'complete',
      'complete',
      'active',
    ]);
    expect((await third.lease.complete()).closed).toBe(true);
    await second.release();
    await third.release();
    for (const trace of [firstTiming, secondTiming, lastTiming]) {
      const timings = trace.snapshot();
      for (const name of [
        'admission.validateInput',
        'admission.claimLock',
        'admission.transactionEntry',
        'admission.transactionBody',
        'admission.transactionTail',
        'admission.selectForUpdate',
        'admission.validateTransition',
        'admission.serializeHash',
        'admission.updateClaim',
        'admission.audit',
        'settlement.transactionEntry',
        'settlement.transactionBody',
        'settlement.transactionTail',
        'settlement.selectForUpdate',
        'settlement.validateTransition',
        'release.claimUnlock',
      ]) {
        expect(timings[name]?.count, name).toBe(1);
        expect(timings[name]?.totalMs, name).toBeGreaterThanOrEqual(0);
      }
      expect(JSON.stringify(timings)).not.toContain(batch.id);
      expect(JSON.stringify(timings)).not.toContain(serverId);
      expect(timings['admission.resourceLock']).toBeUndefined();
      expect(timings['settlement.resourceLock']).toBeUndefined();
      const settled = trace === lastTiming ? 'settlementRelease' : 'settlement';
      expect(timings[`${settled}.audit`]?.count).toBe(1);
    }
    expect(firstTiming.snapshot()['settlement.updateClaim']?.count).toBe(1);
    expect(firstTiming.snapshot()['settlement.deleteClaim']).toBeUndefined();
    expect(lastTiming.snapshot()['settlementRelease.deleteClaim']?.count).toBe(1);
    expect(lastTiming.snapshot()['settlementRelease.resourceLock']?.count).toBe(1);
    expect(lastTiming.snapshot()['settlement.audit']).toBeUndefined();
    expect(lastTiming.snapshot()['settlement.updateClaim']).toBeUndefined();
    await expect(read(batch.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not wait for unrelated global work until final release, then releases its row before waiting', async () => {
    const files: [UploadBatchFile, UploadBatchFile] = [file('a'), file('b')];
    const batch = await prepare(files);
    const blocker = await database.pool.connect();
    let final: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':resources',0))",
      );
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid;
      const first = await Promise.race([
        entry(batch.id, files[0]),
        delay(2000).then(() => {
          throw new Error('Admission waited for unrelated global work');
        }),
      ]);
      await Promise.race([
        first.lease.complete(),
        delay(2000).then(() => {
          throw new Error('Intermediate settlement waited for unrelated global work');
        }),
      ]);
      await first.release();
      const second = await entry(batch.id, files[1]);
      final = second.lease.complete();
      await vi.waitFor(async () => {
        const waiting = await database.pool.query<{ count: string }>(
          'SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
          [pid],
        );
        expect(Number(waiting.rows[0]?.count)).toBe(1);
      });
      // A global→row caller can still acquire the row: the final settlement
      // rolled its first transaction back instead of upgrading row→global.
      const row = await blocker.query<{ scope: { batch: { files: { state: string }[] } } }>(
        'SELECT scope FROM upload_ingestion_claims WHERE id=$1 FOR UPDATE NOWAIT',
        [batch.id],
      );
      expect(row.rows[0]?.scope.batch.files.map((file) => file.state)).toEqual([
        'complete',
        'active',
      ]);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await final;
    }
    await expect(read(batch.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('retains the final reservation across another admission filesystem observation and outstanding sum', async () => {
    const uploaded = file('a');
    const batch = await prepare([uploaded]);
    const active = await entry(batch.id, uploaded);
    const oldReserved = BigInt((await claim(batch.id)).reserved_bytes);
    const other = await managementFixture(f.db);
    const otherServer = await other.server();
    await f.db
      .updateTable('physical_hosts')
      .set({
        upload_policy: JSON.stringify(policy),
        disk_headroom_mib: '0',
      })
      .where('id', '=', other.hostId)
      .execute();
    const observed = Promise.withResolvers<void>(),
      continueObservation = Promise.withResolvers<void>();
    let observations = 0,
      observerPid: number | undefined;
    const nextReserved = BigInt(2 * uploaded.bytes + 65536);
    const next = f.db
      .connection()
      .execute(async (connection) => {
        observerPid = (
          await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(connection)
        ).rows[0]?.pid;
        const reservation = await reserveUploadIngestion(
          connection,
          other.context,
          otherServer,
          uploaded.bytes,
          env,
          {
            availableBytes: async () => {
              if (++observations === 2) observed.resolve();
              await continueObservation.promise;
              // Without the old claim this observation would incorrectly admit the
              // next transfer. Both configured roots can share the same disk.
              return BigInt(policy.temporaryDiskHeadroomBytes) + oldReserved + nextReserved - 1n;
            },
          },
        );
        await reservation.unlock();
        return reservation;
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    let final: Promise<unknown> | undefined;
    let admission: Awaited<typeof next> | undefined;
    try {
      await Promise.race([
        observed.promise,
        next.then(() => {
          throw new Error('Reservation failed before fixture observation');
        }),
      ]);
      final = active.lease.complete();
      await vi.waitFor(async () => {
        const waiting = await database.pool.query<{ count: string }>(
          'SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
          [observerPid],
        );
        expect(Number(waiting.rows[0]?.count)).toBe(1);
      });
      expect(BigInt((await claim(batch.id)).reserved_bytes)).toBe(oldReserved);
    } finally {
      continueObservation.resolve();
      admission = await next;
      await final;
    }
    expect(admission).toMatchObject({ error: { code: 'resources_unavailable' } });
    await expect(read(batch.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('commits both completion audit events with settlement and rolls everything back on audit failure', async () => {
    const uploaded = file('a');
    const batch = await prepare([uploaded]);
    const active = await entry(batch.id, uploaded);
    await sql`CREATE FUNCTION fail_file_uploaded_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'server.files.uploaded' THEN RAISE EXCEPTION 'isolated audit failure'; END IF;
        RETURN NEW;
      END
    $$`.execute(f.db);
    await sql`CREATE TRIGGER fail_file_uploaded_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_file_uploaded_audit()`.execute(f.db);
    const completionAudits = () =>
      f.db
        .selectFrom('audit_events')
        .selectAll()
        .where('action', 'in', ['server.upload.confirmed', 'server.files.uploaded'])
        .where(sql<string>`metadata->>'serverId'`, '=', serverId)
        .execute();
    try {
      await expect(active.lease.complete()).rejects.toThrow('isolated audit failure');
      expect((await read(batch.id))?.files[0]?.state).toBe('active');
      expect(await completionAudits()).toEqual([]);
    } finally {
      await sql`DROP TRIGGER fail_file_uploaded_audit ON audit_events`.execute(f.db);
      await sql`DROP FUNCTION fail_file_uploaded_audit()`.execute(f.db);
    }
    expect((await active.lease.complete()).closed).toBe(true);
    const audits = await completionAudits();
    expect(audits).toHaveLength(2);
    expect(audits.find((audit) => audit.action === 'server.upload.confirmed')?.metadata).toEqual({
      claimId: batch.id,
      serverId,
      closed: true,
    });
    expect(audits.find((audit) => audit.action === 'server.files.uploaded')?.metadata).toEqual({
      serverId,
      bytes: uploaded.bytes,
    });
    expect(
      audits.every(
        (audit) =>
          audit.actor_user_id === f.context.actorUserId &&
          audit.subject_user_id === f.context.subjectUserId,
      ),
    ).toBe(true);
    await expect(active.lease.complete()).rejects.toMatchObject({ code: 'conflict' });
    expect(await completionAudits()).toHaveLength(2);
  });

  it('keeps the original manifest hash and rejected entries for a lost prepare response', async () => {
    const accepted = file('accepted');
    const rejected = [{ id: randomUUID(), code: 'file_exists' as const }];
    const manifestHash = 'b'.repeat(64);
    const batch = await f.db.connection().execute(async (connection) => {
      const reservation = await reserveUploadIngestion(
        connection,
        f.context,
        serverId,
        accepted.bytes,
        env,
        enough,
      );
      try {
        return await createUploadBatch(connection, f.context, serverId, reservation.id, {
          bindingHash,
          manifestHash,
          rejected,
          concurrency: 2,
          files: [accepted],
        });
      } finally {
        await reservation.unlock();
      }
    });
    expect(await read(batch.id)).toMatchObject({
      manifestHash,
      rejected,
      files: [{ id: accepted.id, state: 'queued' }],
    });
    await closeUploadBatch(f.db, f.context, serverId, batch.id, bindingHash);
    await expect(read(batch.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('charges multipart overhead for every simultaneous request before approving the batch', async () => {
    await f.db
      .updateTable('physical_hosts')
      .set({ upload_policy: JSON.stringify({ ...policy, temporaryDiskBudgetBytes: 65536 }) })
      .where('id', '=', f.hostId)
      .execute();
    await expect(prepare([file('a', 0), file('b', 0)])).rejects.toMatchObject({ status: 413 });
    const files: [UploadBatchFile, UploadBatchFile] = [file('a', 0), file('b', 0)];
    await f.db.connection().execute(async (connection) => {
      const single = await reserveUploadIngestion(connection, f.context, serverId, 0, env, enough);
      try {
        await expect(
          createUploadBatch(connection, f.context, serverId, single.id, {
            bindingHash,
            concurrency: 2,
            files,
          }),
        ).rejects.toMatchObject({ code: 'conflict' });
        await single.rejectBeforeDispatch();
      } finally {
        await single.unlock();
      }
    });
    const serial = await prepare(files, 1);
    expect((await claim(serial.id)).reserved_bytes).toBe('65536');
    const first = await entry(serial.id, files[0]);
    await expect(entry(serial.id, files[1])).rejects.toMatchObject({
      code: 'operation_busy',
    });
    await first.lease.rejectBeforeDispatch();
    await closeUploadBatch(f.db, f.context, serverId, serial.id, bindingHash);
  });

  it('rejects duplicate dispatch even across connections and never retries completed entries', async () => {
    const files: [UploadBatchFile, UploadBatchFile] = [file('a'), file('b')];
    const batch = await prepare(files);
    const results = await Promise.allSettled([
      entry(batch.id, files[0]),
      entry(batch.id, files[0]),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const active = results.find((result) => result.status === 'fulfilled');
    if (active?.status !== 'fulfilled') throw new Error('missing active fixture');
    await active.value.lease.complete();
    await expect(entry(batch.id, files[0])).rejects.toMatchObject({ code: 'conflict' });
    await closeUploadBatch(f.db, f.context, serverId, batch.id, bindingHash);
    await expect(read(batch.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('cancels only a queued file while unrelated files continue', async () => {
    const files: [UploadBatchFile, UploadBatchFile, UploadBatchFile] = [
      file('a'),
      file('b'),
      file('c'),
    ];
    const batch = await prepare(files);
    await cancelUploadBatchEntry(f.db, f.context, serverId, batch.id, files[1].id, bindingHash);
    const first = await entry(batch.id, files[0]);
    await cancelUploadBatchEntry(f.db, f.context, serverId, batch.id, files[0].id, bindingHash);
    expect((await read(batch.id))?.files.map((file) => file.state)).toEqual([
      'active',
      'cancelled',
      'queued',
    ]);
    const third = await entry(batch.id, files[2]);
    await first.lease.complete();
    expect((await third.lease.rejectBeforeDispatch()).closed).toBe(true);
  });

  it('retains uncertain writes and their full budget while another slot can finish siblings', async () => {
    const files: [UploadBatchFile, UploadBatchFile, UploadBatchFile] = [
      file('a'),
      file('b'),
      file('c'),
    ];
    const batch = await prepare(files);
    const original = await claim(batch.id);
    const first = await entry(batch.id, files[0]);
    await first.lease.uncertain();
    await first.release();
    const second = await entry(batch.id, files[1]);
    await expect(entry(batch.id, files[2])).rejects.toMatchObject({ code: 'operation_busy' });
    await second.lease.complete();
    await second.release();
    const third = await entry(batch.id, files[2]);
    await third.lease.complete();
    await third.release();
    expect((await claim(batch.id)).reserved_bytes).toBe(original.reserved_bytes);
    expect((await closeUploadBatch(f.db, f.context, serverId, batch.id, bindingHash)).closed).toBe(
      false,
    );
    await expect(entry(batch.id, files[0])).rejects.toMatchObject({ code: 'conflict' });
    await recover(batch.id);
    await expect(read(batch.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('blocks recovery during live transfers and invalidates a stale recovery hash after every update', async () => {
    const files: [UploadBatchFile, UploadBatchFile] = [file('a'), file('b')];
    const batch = await prepare(files);
    const oldHash = (await claim(batch.id)).scope_hash;
    const first = await entry(batch.id, files[0]);
    await expect(recover(batch.id)).rejects.toMatchObject({ code: 'conflict' });
    await first.lease.uncertain();
    await first.release();
    await expect(recover(batch.id, oldHash)).rejects.toMatchObject({ code: 'conflict' });
    await recover(batch.id);
  });

  it('keeps active entries after a lost request, closes queued work, and never replays the active write', async () => {
    const files: [UploadBatchFile, UploadBatchFile] = [file('a'), file('b')];
    const batch = await prepare(files);
    const first = await entry(batch.id, files[0]);
    await first.release(); // Lost process/request: no provider outcome was recorded.
    const closed = await closeUploadBatch(f.db, f.context, serverId, batch.id, bindingHash);
    expect(closed.closed).toBe(false);
    expect(closed.files.map((file) => file.state)).toEqual(['active', 'cancelled']);
    await expect(entry(batch.id, files[0])).rejects.toMatchObject({ code: 'conflict' });
    await recover(batch.id);
  });

  it('binds every entry, read and cancellation to actor, subject, session and current server identity', async () => {
    const files: [UploadBatchFile] = [file('a')];
    const batch = await prepare(files);
    const contexts: AuthContext[] = [
      { ...f.context, actorUserId: f.owner.actorUserId },
      { ...f.context, subjectUserId: f.owner.subjectUserId },
      { ...f.context, [authSessionId]: randomUUID() },
      { ...f.context, [authSessionId]: undefined },
    ];
    for (const context of contexts) {
      await expect(entry(batch.id, files[0], context)).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        readUploadBatch(f.db, context, serverId, batch.id, bindingHash),
      ).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        closeUploadBatch(f.db, context, serverId, batch.id, bindingHash),
      ).rejects.toMatchObject({ code: 'conflict' });
    }
    await expect(entry(batch.id, files[0], f.context, 'b'.repeat(64))).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      entry(batch.id, files[0], f.context, bindingHash, randomUUID()),
    ).rejects.toMatchObject({ code: 'conflict' });
    for (const changed of [{ path: '/other' }, { bytes: 2048 }, { overwrite: true }])
      await expect(entry(batch.id, { ...files[0], ...changed })).rejects.toMatchObject({
        code: 'conflict',
      });
    expect((await read(batch.id))?.files[0]?.state).toBe('queued');
  });

  it('rejects conflicting manifests, invalid paths, excessive entries and unsupported concurrency', async () => {
    const same = file('same');
    for (const files of [
      [same, { ...same, id: randomUUID() }],
      [same, { ...same, path: '/other' }],
      [file('parent'), file('parent/child')],
      [file('../outside')],
      Array.from({ length: 501 }, (_, index) => file(String(index))),
    ])
      await expect(prepare(files)).rejects.toMatchObject({ code: 'validation_failed' });
    for (const concurrency of [0, 7])
      await expect(prepare([file('a')], concurrency)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toEqual([]);
  });

  it('does not treat legacy single-file claims as resumable batches', async () => {
    await f.db.connection().execute(async (connection) => {
      const reservation = await reserveUploadIngestion(
        connection,
        f.context,
        serverId,
        1,
        env,
        enough,
      );
      try {
        await expect(read(reservation.id)).rejects.toMatchObject({ code: 'conflict' });
        await expect(
          closeUploadBatch(f.db, f.context, serverId, reservation.id, bindingHash),
        ).rejects.toMatchObject({ code: 'conflict' });
        await reservation.rejectBeforeDispatch();
      } finally {
        await reservation.unlock();
      }
    });
  });
});
