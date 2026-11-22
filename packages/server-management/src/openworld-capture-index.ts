import { randomUUID } from 'node:crypto';
import type { Database } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';
import { readCaptureEvidence } from '../../../games/openworld/src/capture-console.js';
import { captureCursor } from '../../../games/openworld/src/capture-evidence.js';
import type { OpenworldScreenshot } from '../../../games/openworld/src/screenshots.js';
import {
  assertCurrentOpenworldScope,
  createOpenworldNativeConnection,
  type OpenworldNativeOptions,
  openworldProcessRef,
  readOpenworldScope,
} from './openworld-telemetry.js';

type DB = Kysely<Database>;
type Lease = { server_id: string; lease: string };

export async function claimOpenworldCaptureScans(db: DB, capacity: number) {
  const lease = randomUUID();
  const result = await sql<Lease>`
    WITH due AS (
      SELECT s.id FROM managed_servers s
      JOIN openworld_server_profiles p ON p.server_id = s.id
      LEFT JOIN openworld_capture_cursors c ON c.server_id = s.id
      WHERE s.runtime_state = 'running' AND s.installation_state = 'installed'
        AND s.deleted_at IS NULL AND p.dashboard_credential_prepared
        AND (c.next_scan_at IS NULL OR c.next_scan_at <= now())
      ORDER BY c.next_scan_at NULLS FIRST, s.id LIMIT ${capacity}
      FOR UPDATE OF s SKIP LOCKED
    )
    INSERT INTO openworld_capture_cursors (server_id, lease, next_scan_at)
      SELECT id, ${lease}::uuid, now() + interval '45 seconds' FROM due
    ON CONFLICT (server_id) DO UPDATE SET lease = excluded.lease, next_scan_at = excluded.next_scan_at
      WHERE openworld_capture_cursors.next_scan_at <= now()
    RETURNING server_id, lease`.execute(db);
  return result.rows;
}

export function createOpenworldCaptureCollector(
  options: OpenworldNativeOptions,
  native = createOpenworldNativeConnection(options),
) {
  const { db } = options;
  return async ({ server_id: id, lease }: Lease) => {
    const scope = await readOpenworldScope(db, id);
    if (scope.reason) return;
    const process = openworldProcessRef(scope);
    const saved = await db
      .selectFrom('openworld_capture_cursors')
      .selectAll()
      .where('server_id', '=', id)
      .where('lease', '=', lease)
      .executeTakeFirst();
    if (!saved) return;
    const collected = await native(scope, async (origin, token, signal) => {
      const state = captureCursor(
        saved.binding === scope.binding && saved.process_ref === process
          ? saved.evidence
          : undefined,
      );
      const result = await readCaptureEvidence(
        origin,
        token,
        signal,
        state,
        options.fetcher,
        options.now,
      );
      return { state, ...result };
    });
    return db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('managed_servers')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      assertCurrentOpenworldScope(scope, await readOpenworldScope(tx, id));
      const claimed = await tx
        .updateTable('openworld_capture_cursors')
        .set({
          binding: scope.binding,
          process_ref: process,
          evidence: JSON.stringify(collected.state),
          next_scan_at: new Date(
            Date.now() + (collected.caughtUp ? 6500 + Math.random() * 1500 : 50),
          ),
        })
        .where('server_id', '=', id)
        .where('lease', '=', lease)
        .returning('server_id')
        .executeTakeFirst();
      if (!claimed) return;
      for (const c of collected.captures) {
        await tx
          .insertInto('openworld_capture_owners')
          .values({
            server_id: id,
            binding: scope.binding,
            file_name: c.name,
            file_bytes: String(c.bytes),
            mtime_ms: String(c.mtimeMs),
            process_ref: process,
            account_id: c.account,
            connection_id: String(c.connection),
            request_id: String(c.request),
            requested_seq: String(c.seq),
            written_seq: String(c.writtenSeq),
          })
          .onConflict((oc) =>
            oc
              .columns(['server_id', 'binding', 'file_name', 'file_bytes', 'mtime_ms'])
              .doUpdateSet({ account_id: null })
              .where(sql<boolean>`(openworld_capture_owners.account_id, openworld_capture_owners.process_ref,
            openworld_capture_owners.connection_id, openworld_capture_owners.request_id,
            openworld_capture_owners.requested_seq, openworld_capture_owners.written_seq)
            IS DISTINCT FROM (excluded.account_id, excluded.process_ref, excluded.connection_id,
            excluded.request_id, excluded.requested_seq, excluded.written_seq)`),
          )
          .execute();
      }
      return { scope, sessions: collected.state.sessions };
    });
  };
}

export async function attributedOpenworldScreenshots(
  db: DB,
  serverId: string,
  binding: string,
  files: OpenworldScreenshot[],
  account?: string,
) {
  if (!files.length) return { files: [] };
  let query = db
    .selectFrom('openworld_capture_owners')
    .select(['file_name', 'file_bytes', 'mtime_ms', 'account_id'])
    .where('server_id', '=', serverId)
    .where('binding', '=', binding)
    .where('file_name', '=', sql<string>`ANY(${sql.val(files.map((f) => f.name))}::text[])`)
    .where('account_id', 'is not', null);
  if (account) query = query.where('account_id', '=', account);
  const records = await query.execute();
  const key = (name: string, bytes: string | number, mtime: string | number) =>
    `${name}/${bytes}/${mtime}`;
  const owners = new Map(
    records.map((r) => [key(r.file_name, r.file_bytes, r.mtime_ms), r.account_id]),
  );
  return {
    files: files.flatMap((f) => {
      const accountId = owners.get(key(f.name, f.bytes, f.mtimeMs)) ?? null;
      return !account || accountId === account ? [{ ...f, accountId }] : [];
    }),
  };
}
